import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MODEL_TASK_IDS } from '../src/lib/modelTasks';
import { rowHasOperation } from '../src/lib/modelRegistry';
const root = await mkdtemp(join(tmpdir(), 'model-package-test-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_BUNDLED_PACKAGES_DIR = join(root, 'model-packages');
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
await mkdir(join(root, 'data'), { recursive: true });
after(() => rm(root, { recursive: true, force: true }));
const packages = await import('../src/lib/server/modelPackages');
const store = await import('../src/lib/server/modelRegistryStore');
const { executeModelTask } = await import('../src/lib/server/modelTaskRunner');
const { operatePackage, invokePackage } = await import('../src/lib/server/modelSupervisor');
const { probeModelRow, probeOperationsFor } = await import('../src/lib/server/modelProbe');
const { migrateModelPackages } = await import('../src/lib/server/modelPackageMigration');
const dir = join(root, 'model-packages', 'unknown-reader');
await mkdir(dir, { recursive: true });
const manifest = { version: 1, id: 'unknown-reader', name: 'Unknown reader', revision: '1', access: 'local_http',
 adapter: { id: 'unregistered-adapter', command: { executable: process.execPath, args: ['{package}/adapter.mjs'] } },
 service: { id: 'shared-fixture-service' } };
const adapter = (translate = false) => `
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin })) {
 const r = JSON.parse(line); let output, error;
 if (r.action === 'install') { writeFileSync('installed', 'yes'); output = { installed:true }; }
 else if (r.action === 'installation-status') output = { installed: existsSync('installed') };
 else if (r.action === 'start') { writeFileSync('running','yes'); output = { ready:true }; }
 else if (r.action === 'health') output = { ready:existsSync('running') };
 else if (r.action === 'stop') { writeFileSync('stopped','yes'); output = { stopped:true }; }
 else if (r.input.delay) { await new Promise(resolve => setTimeout(resolve, 30000)); output = { source:'待って',lineType:'""' }; }
 else if (r.task.id === 'vision') output = { source:'待って',lineType:'""' };
 else if (r.task.id === 'sourceReview') output = { status:'unassessed',source:'待って',answer:'Independent reading.',translation:'' };
 ${translate ? "else if (r.task.id === 'translate') output = r.input.boxes.map(box => ({...box,translation:'Test.'}));" : ''}
 else error = { kind:'unsupported',message:'Not implemented by this adapter revision' };
 console.log(JSON.stringify({ protocol:1,requestId:r.requestId,type:'result',ok:!error,output,error }));
}
`;
await writeFile(join(dir, 'model.json'), JSON.stringify(manifest));
await writeFile(join(dir, 'adapter.mjs'), adapter());

test('unknown package is discovered, installed, controlled and tested without registration', async () => {
 assert.equal(packages.discoverModelPackages(true).errors.length, 0);
 let row = store.findRegistryRow('unknown-reader')!;
 assert.ok(row);
 assert.deepEqual(probeOperationsFor(row), MODEL_TASK_IDS);
 assert.equal(rowHasOperation(row, 'vision'), false);
 assert.deepEqual(await operatePackage(row.id, 'installation-status'), { installed:false });
 await operatePackage(row.id, 'install');
 assert.deepEqual(await operatePackage(row.id, 'installation-status'), { installed:true });
 await operatePackage(row.id, 'start');
 const vision = await probeModelRow(row, 'vision');
 assert.equal(vision.ok, true, vision.reason);
 row = store.saveProbeResult(row.id, vision);
 assert.equal(rowHasOperation(row, 'vision'), true);
 assert.equal((await executeModelTask(row, 'vision', {})).source, '待って');
 const unsupported = await probeModelRow(row, 'advisory');
 assert.equal(unsupported.outcome, 'unsupported');
 const review = await probeModelRow(row, 'sourceReview');
 assert.equal(review.ok, true, review.reason);
 await operatePackage(row.id, 'stop');
 assert.equal(await readFile(join(dir,'stopped'),'utf8'), 'yes');
});

test('adapter changes make previous checks warnings and can add a task without app changes', async () => {
 let row = store.findRegistryRow('unknown-reader')!;
 const failed = await probeModelRow(row, 'translate');
 assert.equal(failed.outcome, 'unsupported');
 store.saveProbeResult(row.id, failed);
 await writeFile(join(dir, 'adapter.mjs'), adapter(true));
 packages.discoverModelPackages(true);
 row = store.findRegistryRow(row.id)!;
 assert.equal(rowHasOperation(row,'vision'),true);
 assert.equal(rowHasOperation(row,'translate'),true);
 const passed = await probeModelRow(row,'translate');
 assert.equal(passed.ok,true,passed.reason);
 row = store.saveProbeResult(row.id,passed);
 assert.equal(rowHasOperation(row,'translate'),true);
 assert.equal((await executeModelTask(row,'translate',{boxes:[{source:'テスト'}]}))[0].translation,'Test.');
});

test('cosmetic names preserve passes, interruption preserves evidence, model revision warns', async () => {
 let row = store.findRegistryRow('unknown-reader')!;
 const fp = row.taskFingerprints!.translate;
 row = store.saveProbeResult(row.id,{ operation:'translate',ok:false,outcome:'cancelled',fingerprint:fp,at:Date.now() });
 assert.equal(rowHasOperation(row,'translate'),true);
 assert.equal(row.probeHistory!.at(-1)!.outcome,'cancelled');
 store.upsertRegistryRow({...row,name:'Renamed'});
 row = store.findRegistryRow(row.id)!;
 assert.equal(rowHasOperation(row,'translate'),true);
 store.upsertRegistryRow({...row,modelRevision:'new remote version'});
 assert.equal(rowHasOperation(store.findRegistryRow(row.id)!,'translate'),true);
});

test('cancellation kills the running command and releases its queue', async () => {
 const pkg = packages.modelPackage('unknown-reader')!;
 const abort = new AbortController();
 const pending = invokePackage(pkg,'execute',{delay:true},{task:'vision',signal:abort.signal});
 setTimeout(() => abort.abort(),100);
 await assert.rejects(pending,/Cancelled/);
 assert.equal((await invokePackage(pkg,'execute',{}, {task:'vision'})).source,'待って');
});

test('malformed output fails task validation instead of becoming a capability', async () => {
 const row = store.findRegistryRow('unknown-reader')!;
 const result = await probeModelRow(row,'vision',{invoke:async()=>({source:''})});
 assert.equal(result.outcome,'failed_validation');
});

test('migration backs up configuration once and does not mint fingerprints for legacy passes', async () => {
 const file = join(root,'data','models.json');
 await writeFile(file,JSON.stringify({rows:[{id:'legacy',probes:{vision:{operation:'vision',ok:true,at:1}}}]}));
 migrateModelPackages();
 const first = await readFile(join(root,'data','backups','model-packages-v1','models.json'),'utf8');
 migrateModelPackages();
 assert.equal(await readFile(join(root,'data','backups','model-packages-v1','models.json'),'utf8'),first);
 const saved = JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.rows[0].probes.vision.fingerprint,undefined);
 assert.equal(saved.rows[0].probeHistory.length,1);
 store.invalidateRegistryCache();
});

test('manifests cannot advertise capabilities', () => {
 assert.throws(()=>packages.validatePackage({...manifest,operations:['vision']}),/cannot declare/);
});

test('shared services honor concurrency, reject active stop, and release cancelled waiters', async () => {
 const { superviseModel, packageServiceStatus } = await import('../src/lib/server/modelSupervisor');
 const base = packages.modelPackage('unknown-reader')!;
 const pkg = { ...base, manifest: { ...base.manifest, service: { id: 'concurrency-fixture', concurrency: 2 } } };
 let running = 0, peak = 0;
 let release!: () => void;
 const gate = new Promise<void>(resolve => release = resolve);
 const work = () => superviseModel(pkg, async () => { running++; peak = Math.max(peak, running); await gate; running--; });
 const first = work(), second = work();
 await new Promise(resolve => setTimeout(resolve, 10));
 assert.equal(packageServiceStatus(pkg).active, 2);
 const abort = new AbortController();
 const queued = superviseModel(pkg, async () => assert.fail('cancelled waiter ran'), abort.signal);
 abort.abort();
 await assert.rejects(queued);
 release();
 await Promise.all([first, second]);
 assert.equal(peak, 2);
 assert.equal(packageServiceStatus(pkg).active, 0);
 const actual = packages.modelPackage('unknown-reader')!;
 let unblock!: () => void;
 const active = superviseModel(actual, () => new Promise<void>(resolve => unblock = resolve));
 await new Promise(resolve => setTimeout(resolve, 10));
 await assert.rejects(operatePackage(actual.manifest.id, 'stop'), /in use/);
 unblock();
 await active;
});

test('shared resource reservations serialize different services', async () => {
 const { superviseModel } = await import('../src/lib/server/modelSupervisor');
 const base = packages.modelPackage('unknown-reader')!;
 let active = 0, peak = 0;
 await Promise.all(['one','two'].map(id => superviseModel({ ...base,
   manifest: { ...base.manifest, service: { id, resource: 'fixture-device' } } }, async () => {
     active++; peak = Math.max(peak, active);
     await new Promise(resolve => setTimeout(resolve, 10));
     active--;
   })));
 assert.equal(peak, 1);
});

test('a failed validation or unsupported retest supersedes a pass, transient errors do not', async () => {
 let row = store.findRegistryRow('unknown-reader')!;
 for (const outcome of ['error', 'cancelled', 'failed_validation', 'unsupported'] as const) {
   const pass = await probeModelRow(row, 'vision');
   assert.equal(pass.ok, true, pass.reason);
   row = store.saveProbeResult(row.id, pass);
   row = store.saveProbeResult(row.id, { operation: 'vision', ok: false, outcome, at: Date.now(), fingerprint: row.taskFingerprints!.vision });
   assert.equal(rowHasOperation(row, 'vision'), outcome === 'error' || outcome === 'cancelled');
 }
});

test('blank production OCR is valid but cannot pass the meaningful fixture', async () => {
 const { validateTaskOutput } = await import('../src/lib/modelTasks');
 assert.doesNotThrow(() => validateTaskOutput('vision', {source: ''}));
 const row = store.findRegistryRow('unknown-reader')!;
 assert.equal((await probeModelRow(row, 'vision', {invoke: async () => ({source: ''})})).outcome, 'failed_validation');
 for (const task of ['translate', 'alternatives', 'detect'] as const) {
   assert.throws(() => validateTaskOutput(task, task === 'detect' ? {regions:[null]} : [null]), /invalid or incomplete/);
 }
});

test('native installation receipts require surviving weights and invalidate evidence on changes', async () => {
 const { nativeInstallationStatus } = await import('../src/lib/server/modelAdapterLifecycle');
 assert.equal(nativeInstallationStatus('sam').installed, false);
 const receiptDir = join(root, 'data/models/package-installations');
 await mkdir(receiptDir, {recursive:true});
 const weight = join(root, 'fixture-weight');
 await writeFile(weight, 'weights');
 await writeFile(join(receiptDir,'sam.json'), JSON.stringify({artifacts:[weight]}));
 assert.equal(nativeInstallationStatus('sam').installed, true);
 const row = {...store.findRegistryRow('unknown-reader')!, id:'sam'};
 const before = packages.rowTaskFingerprints(row).vision;
 await writeFile(weight, 'changed weights');
 assert.notEqual(packages.rowTaskFingerprints(row).vision, before);
 await rm(weight);
 assert.equal(nativeInstallationStatus('sam').installed, false);
});

test('malformed JSONL and missing image output are failed validation', async () => {
 const base = packages.modelPackage('unknown-reader')!;
 await writeFile(join(dir,'bad.mjs'), `process.stdin.once('data', () => {console.log('not json')});`);
 const pkg = {...base, manifest:{...base.manifest, adapter:{id:'bad',command:{executable:process.execPath,args:['{package}/bad.mjs']}}}};
 await assert.rejects(invokePackage(pkg,'execute',{}, {task:'vision'}), (error:any) => error.outcome === 'failed_validation');
});

test('builtin adapter sources only cover that adapter', () => {
 const translator = packages.adapterSourceFiles('native-translator');
 const ocr = packages.adapterSourceFiles('native-ocr');
 const chat = packages.adapterSourceFiles('openai');
 const grok = packages.adapterSourceFiles('cli', 'grok');
 const codex = packages.adapterSourceFiles('cli', 'codex');
 assert.ok(translator.includes('src/lib/server/specialistTranslation.ts'));
 assert.equal(ocr.includes('src/lib/server/specialistTranslation.ts'), false);
 assert.equal(chat.includes('src/lib/server/specialistTranslation.ts'), false);
 assert.ok(ocr.includes('ocr/hayai_review.py'));
 assert.equal(translator.includes('ocr/hayai_review.py'), false);
 assert.ok(translator.includes('src/lib/server/modelTaskRunner.ts'));
 assert.equal(translator.some(path => path.endsWith('jobs.ts')), false);
 assert.ok(grok.includes('src/lib/server/cliAdapters/grok.ts'));
 assert.equal(codex.includes('src/lib/server/cliAdapters/grok.ts'), false);
 assert.ok(codex.includes('src/lib/server/codexClean.ts'));
 assert.equal(grok.includes('src/lib/server/codexClean.ts'), false);
 const row = { id: 'unpacked', name: 'Unpacked', slug: 'unpacked', operations: [], roles: [] };
 const remote = packages.rowTaskFingerprints({ ...row, access: 'remote_http' } as never).translate;
 const proof = packages.rowTaskFingerprints({ ...row, id: 'unpacked-proof', access: 'proofreader' } as never).translate;
 assert.notEqual(remote, proof);
 assert.notEqual(packages.rowTaskFingerprints({ ...row, id: 'unpacked-grok', access: 'cli', cliAdapter: 'grok' } as never).translate,
  packages.rowTaskFingerprints({ ...row, id: 'unpacked-codex', access: 'cli', cliAdapter: 'codex' } as never).translate);
});

test('failed installation cannot report completion and invalid packages block lifecycle', async () => {
 const failedDir = join(root,'model-packages','failed-installer');
 await mkdir(failedDir);
 await writeFile(join(failedDir,'model.json'), JSON.stringify({...manifest,id:'failed-installer', setup:{executable:process.execPath,args:['-e','process.exit(7)']}}));
 packages.discoverModelPackages(true);
 await assert.rejects(operatePackage('failed-installer','install'), /Installer exited 7/);
 await writeFile(join(failedDir,'model.json'), JSON.stringify({...manifest,id:'failed-installer',capabilities:['vision']}));
 packages.discoverModelPackages(true);
 await assert.rejects(operatePackage('failed-installer','start'), /Invalid model package/);
});

test('removed inpainters are absent from bundled packages', async () => {
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const id of ['migan', 'manga-inpainting']) {
    assert.equal(existsSync(fileURLToPath(new URL(`../model-packages/${id}/model.json`, import.meta.url))), false);
  }
});
