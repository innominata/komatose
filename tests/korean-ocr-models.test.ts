import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelTaskError } from '../src/lib/modelTasks';

const root = await mkdtemp(join(tmpdir(), 'komatose-korean-ocr-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.SCAN_REVIEW_MODELS_DIR = join(root, 'data/models/review');
process.env.DATABASE_URL = join(root, 'data/test.db');
process.env.PADDLEOCR_PYTHON = process.execPath; // Existing file only; fixture never invokes it as Python.
await mkdir(join(root, 'data'), { recursive: true });
const store = await import('../src/lib/server/modelRegistryStore');
const { modelPackage } = await import('../src/lib/server/modelPackages');
const { localTranscription, reviewResolved, installedLocalReviewModels } = await import('../src/lib/server/localReview');
const { runQualification } = await import('../src/lib/server/modelQualification');
const { invokeBuiltinAdapter } = await import('../src/lib/server/modelAdapters');
const { aliasFromArgs } = await import('../src/lib/server/residentInference');
const { reviewListenPort } = await import('../src/lib/server/gpuMode');
const { installTarget } = await import('../src/lib/installCatalog');
const { installCommand, targetInstalled, planInstallSteps } = await import('../src/lib/server/modelInstall');
after(() => rm(root, { recursive: true, force: true }));

test('both Korean readers have separate install recipes, runtimes, and resident identities', () => {
  for (const id of ['hayai-ocr-v2.5-nova', 'pp-ocrv5-korean']) {
    assert.ok(store.findRegistryRow(id)?.languages?.includes('korean'));
    assert.equal(modelPackage(id)?.manifest.adapter.id, 'native-ocr');
    assert.ok(installCommand(installTarget(id)!).args.includes(id));
  }
  assert.equal(aliasFromArgs(['python', 'hayai_review.py', '--model-id', 'hayai-ocr-v2.5-nova']), 'hayai-ocr-v2.5-nova');
  assert.equal(aliasFromArgs(['python', 'hayai_review.py']), 'hayai-ocr-v2');
  assert.equal(aliasFromArgs(['python', 'ppocr_korean_review.py']), 'pp-ocrv5-korean');
  assert.notEqual(reviewListenPort('hayai-ocr-v2.5-nova'), reviewListenPort('hayai-ocr-v2'));
  assert.notEqual(reviewListenPort('pp-ocrv5-korean'), reviewListenPort('hayai-ocr-v2.5-nova'));
  assert.equal(reviewResolved('pp-ocrv5-korean').kind, 'cpu');
});

test('Korean-only recognition rejects Japanese before inference and qualifies with a Korean image', async () => {
  const row = store.findRegistryRow('pp-ocrv5-korean')!;
  await assert.rejects(localTranscription('pp-ocrv5-korean', Buffer.from('fixture'), new AbortController().signal, 'japanese'), /Korean chapters only/);
  await assert.rejects(invokeBuiltinAdapter(modelPackage(row.id)!, row, 'vision', { lang: 'japanese', jpeg: Buffer.from('fixture') }), /chapter language/);
  const languages: string[] = [];
  const result = await runQualification(row, 'transcription', { invoke: async (_row, task, input) => {
    assert.equal(task, 'vision');
    languages.push(input.lang);
    if (input.lang !== 'korean') throw new ModelTaskError('unsupported', 'Korean only');
    assert.ok(Buffer.isBuffer(input.jpeg));
    assert.ok(input.jpeg.length > 100);
    return { source: '기다려!' };
  } });
  assert.deepEqual(languages, ['japanese', 'korean']);
  assert.equal(result.samples[0].ok, true);
});

test('Paddle reader requires both local line detection and recognition assets', async () => {
  const dir = join(process.env.SCAN_REVIEW_MODELS_DIR!, 'pp-ocrv5-korean');
  const files = ['inference.pdiparams', 'inference.json', 'inference.yml'];
  for (const part of ['detector', 'recognizer']) {
    await mkdir(join(dir, part), { recursive: true });
    for (const file of files) await writeFile(join(dir, part, file), 'fixture');
  }
  await writeFile(join(process.env.SCAN_REVIEW_MODELS_DIR!, 'installed.json'), JSON.stringify({ 'pp-ocrv5-korean': { fixture: true } }));
  assert.ok(installedLocalReviewModels().some(model => model.id === 'pp-ocrv5-korean'));
  assert.equal(targetInstalled(installTarget('pp-ocrv5-korean')!).installed, true,
    'Setup must recognize assets stored under recognizer/ and detector/');
  assert.deepEqual(planInstallSteps(['pp-ocrv5-korean']), { plan: [], skipped: ['pp-ocrv5-korean'] },
    'An installed reader must not be queued for another download');
  await rm(join(dir, 'detector/inference.pdiparams'));
  assert.equal(installedLocalReviewModels().some(model => model.id === 'pp-ocrv5-korean'), false);
  assert.equal(targetInstalled(installTarget('pp-ocrv5-korean')!).installed, false);
  await writeFile(join(dir, 'detector/inference.pdiparams'), '');
  assert.equal(targetInstalled(installTarget('pp-ocrv5-korean')!).installed, false,
    'Empty weights must not count as installed');
});
