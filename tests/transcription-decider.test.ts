import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DECIDER_MIN_MARGIN, DECIDER_MIN_PROBABILITY, decisionThreshold, validateTranscriptionChoice } from '../src/lib/decider';
import { compareOcrReadings, ocrResolutionAccepted } from '../src/lib/ocrConsensus';
import { regionAiSettings } from '../src/lib/regionAi';
const workspace = process.cwd();
const root = await mkdtemp(join(tmpdir(), 'komatose-decider-test-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
process.env.SCAN_BUNDLED_PACKAGES_DIR = join(workspace, 'model-packages');
delete process.env.SCAN_DECIDER_RUNTIME_DIR;
delete process.env.SCAN_DECIDER_MODELS_DIR;
await mkdir(join(root, 'data'), { recursive: true });
const { transcriptionCandidates, decideChoice, decideTranscription, invokeDecider } = await import('../src/lib/server/transcriptionDecider');
const { saveOcrConsensus, applyLonePendingSource, readOcrConsensus } = await import('../src/lib/server/ocrConsensus');
const { saveFillMissingSource } = await import('../src/lib/server/fillMissing');
const { db, sqlite } = await import('../src/lib/server/db');
const { lines } = await import('../src/lib/server/db/schema');
const { toLine } = await import('../src/lib/server/queries');
const { getDoc, putDoc } = await import('../src/lib/server/workflowStore');
const store = await import('../src/lib/server/modelRegistryStore');
const install = await import('../src/lib/server/modelInstall');
const runtime = await import('../src/lib/server/deciderRuntime');
const { modelDefaultFor, setModelDefault } = await import('../src/lib/server/modelDefaultStore');
const { activeModelUses, acquireModelUse } = await import('../src/lib/server/modelUsage');
const { rowHasOperation } = await import('../src/lib/modelRegistry');
const { parseProfileSelections, snapshotProfileSelections, mergeProfileIntoSettings, validateProfileSelections } = await import('../src/lib/modelProfiles');
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });
const readings = [{ model: 'hayai-ocr-v2', source: '持って' }, { model: 'paddleocr-vl-1.6', source: '待って' }];
const candidates = transcriptionCandidates(readings);
const base = { modelId: 'd1-3b', modelName: 'd1', at: 1, cropHash: 'hash', candidates,
  minProbability: DECIDER_MIN_PROBABILITY, minMargin: DECIDER_MIN_MARGIN };
const goodId = candidates.find(c => c.source === '待って')!.id;
const otherId = candidates.find(c => c.id !== goodId)!.id;
const distribution = (p = .8, second = .15) => ({ choice: goodId, probabilities: { [goodId]: p, [otherId]: second, none: Math.max(0, 1 - p - second), unclear: 0 } });

// Source decisions are structured evidence, never a generated replacement string.
test('deduplicates OCR clusters, preserves Paddle spacing, excludes errors, and hides vote counts', () => {
  const inputs = [...readings, { model: 'third', source: '待 って' }, { model: 'fourth', source: '待って', error: 'failed' }, { model: 'empty', source: '...' }];
  assert.deepEqual(transcriptionCandidates(inputs), candidates);
  assert.deepEqual(transcriptionCandidates(inputs.reverse()), candidates);
  assert.deepEqual(Object.keys(candidates[0]), ['id', 'source']);
});
test('threshold boundaries and abstentions do not become OCR agreement', () => {
  const decision = decideChoice(distribution(), base);
  assert.equal(decision.status, 'accepted');
  const result = { ...compareOcrReadings(readings), source: '待って', decision };
  assert.equal(result.agreed, false);
  assert.equal(ocrResolutionAccepted(result), true);
  assert.equal(decideChoice(distribution(.799, .15), base).status, 'abstained');
  assert.equal(decideChoice(distribution(.81, .19), { ...base, minMargin: .63 }).status, 'abstained');
  assert.equal(decideChoice({ choice: 'none', probabilities: { A: .05, B: .05, none: .85, unclear: .05 } }, base).status, 'abstained');
});
test('rejects missing, unknown, non-finite, negative, non-normalized, and inconsistent probabilities', () => {
  for (const value of [
    { choice: 'A', probabilities: { A: 1 } },
    { choice: 'X', probabilities: { A: .8, B: .1, none: .1, unclear: 0 } },
    { choice: 'A', probabilities: { A: NaN, B: .1, none: .1, unclear: 0 } },
    { choice: 'A', probabilities: { A: .8, B: -.1, none: .3, unclear: 0 } },
    { choice: 'A', probabilities: { A: .8, B: .3, none: .1, unclear: 0 } },
    { choice: 'B', probabilities: { A: .8, B: .1, none: .1, unclear: 0 } },
  ]) assert.throws(() => validateTranscriptionChoice(value, candidates));
});
test('Off, default-unset and agreements do not invoke; failures leave plurality disagreements unresolved', async () => {
  let calls = 0;
  const invoke = async () => { calls++; throw new Error('unavailable'); };
  const signal = new AbortController().signal;
  assert.equal(await decideTranscription(Buffer.from('image'), readings, signal, 'japanese', { selection: null }, undefined, invoke), undefined);
  assert.equal(await decideTranscription(Buffer.from('image'), readings, signal, 'japanese', {}, undefined, invoke), undefined);
  const options = { selection: { engine: 'd1-3b', model: '' } };
  assert.equal(await decideTranscription(Buffer.from('image'), [readings[0]], signal, 'japanese', options, undefined, invoke), undefined);
  const plurality = compareOcrReadings([...readings, readings[0]]);
  assert.equal(plurality.agreed, true);
  const decision = await decideTranscription(Buffer.from('image'), plurality.readings, signal, 'japanese', options, undefined, invoke);
  assert.equal(decision?.status, 'error');
  assert.equal(ocrResolutionAccepted({ ...plurality, decision }), false);
  assert.equal(calls, 1);
});
test('cancellation is propagated instead of saved as a decider error', async () => {
  const abort = new AbortController();
  await assert.rejects(decideTranscription(Buffer.from('image'), readings, abort.signal, 'japanese',
    { selection: { engine: 'd1-3b', model: '' } }, undefined, async () => { abort.abort(); throw abort.signal.reason; }), { name: 'AbortError' });
});
test('settings and profiles preserve Default, explicit Off, selected model and thresholds', () => {
  assert.equal(regionAiSettings().transcriptionDecider, undefined);
  assert.equal(regionAiSettings({ transcriptionDecider: null }).transcriptionDecider, null);
  for (const v of [-1, 2, '0.8', null, NaN]) assert.throws(() => decisionThreshold(v, .8));
  const selected = { engine: 'd1-3b', model: '' };
  const settings = regionAiSettings({ transcriptionDecider: selected, deciderMinProbability: .81, deciderMinMargin: .17 });
  const snapshot = snapshotProfileSelections(settings);
  assert.deepEqual(parseProfileSelections(snapshot), snapshot);
  assert.deepEqual(mergeProfileIntoSettings(regionAiSettings(), snapshot).transcriptionDecider, selected);
  assert.equal(mergeProfileIntoSettings(settings, { ...snapshot, transcriptionDecider: null }).transcriptionDecider, null);
  const legacy = { ...snapshot }; delete legacy.transcriptionDecider; delete legacy.deciderMinProbability; delete legacy.deciderMinMargin;
  assert.equal(mergeProfileIntoSettings(settings, legacy).transcriptionDecider, undefined);
});

sqlite.exec("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1); INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES('e','s','e','Episode',1,1); INSERT INTO images(id,episode_id,filename,original_name,width,height,created_at) VALUES('i','e','page.png','page.png',100,100,1)");
function createLine(source = '', extra: Record<string, any> = {}) {
  return toLine(db.insert(lines).values({ id: randomUUID(), episodeId: 'e', imageId: 'i', source, body: '', updatedAt: 1,
    x: .1, y: .1, w: .3, h: .3, placed: true, ...extra }).returning().get());
}
test('saves minority selection with provenance and retains dissenting suggestions', () => {
  const line = createLine();
  const decision = decideChoice(distribution(.9, .05), base);
  const result = { ...compareOcrReadings([...readings, readings[0]]), source: '待って', decision };
  const saved = saveOcrConsensus('e', line, result)!;
  assert.equal(saved.source, '待って');
  assert.equal(saved.sourceState, 'read');
  const provenance = getDoc<any>(`region:${line.id}`, {}).data.sourceDecision;
  assert.equal(provenance.applied, true);
  assert.equal(provenance.status, 'accepted');
  assert.equal(provenance.probabilities[goodId], .9);
  assert.ok(sqlite.prepare("SELECT * FROM suggestions WHERE line_id=? AND body='持って' AND state='pending'").get(line.id));
});
test('abstentions cannot fall through plurality or the lone-suggestion shortcut', () => {
  const line = createLine();
  const decision = decideChoice(distribution(.7, .2), base);
  const result = { ...compareOcrReadings([...readings, readings[0]]), source: '', decision };
  assert.equal(saveOcrConsensus('e', line, result)?.source, '');
  sqlite.prepare("UPDATE suggestions SET state='rejected' WHERE line_id=? AND body='持って'").run(line.id);
  assert.equal(applyLonePendingSource('e', line.id), false);
});
test('fill-missing honors the same accepted choice and abstention policy', () => {
  const a = createLine(), b = createLine();
  const accepted = { ...compareOcrReadings(readings), source: '待って', decision: decideChoice(distribution(), base) };
  assert.equal(saveFillMissingSource('e', a, accepted)?.source, '待って');
  assert.equal(saveFillMissingSource('e', b, { ...accepted, source: '', decision: decideChoice(distribution(.7, .2), base) })?.source, '');
});
test('concurrent edits, approved and ignored lines are preserved', () => {
  const accepted = { ...compareOcrReadings(readings), source: '待って', decision: decideChoice(distribution(), base) };
  const concurrent = createLine();
  sqlite.prepare("UPDATE lines SET source='human',revision=revision+1 WHERE id=?").run(concurrent.id);
  assert.equal(saveOcrConsensus('e', concurrent, accepted)?.source, 'human');
  assert.equal(saveFillMissingSource('e', concurrent, accepted)?.source, 'human');
  const approved = createLine('approved', { status: 'approved' });
  assert.equal(saveOcrConsensus('e', approved, accepted)?.source, 'approved');
  const ignored = createLine('ignored', { sourceState: 'ignored' });
  assert.equal(saveOcrConsensus('e', ignored, accepted), undefined);
});
test('HTTP adapter sends only crop, language and neutral candidates; releases model use on invalid output', async () => {
  let request: any;
  let bad = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/systemone');
    let body = ''; for await (const c of req) body += c;
    request = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { transcription: bad ? { choice: 'A', probabilities: { A: 1 } } : distribution() } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const row = { id: 'test-decider', name: 'Test', slug: 'test', access: 'local_http' as const, operations: ['sourceDecide' as const],
    roles: ['admin' as const], seeded: false, operationsLocked: false,
    http: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKeyEnv: '' } };
  try {
    await invokeDecider(row, { jpeg: Buffer.from('image'), candidates, lang: 'japanese', translation: 'Do not send', seriesNotes: 'Do not send' });
    assert.deepEqual(request.state, { language: 'japanese' });
    assert.equal(request.images.length, 1);
    assert.deepEqual(Object.keys(request.questions.transcription.criteria), ['A', 'B', 'none', 'unclear']);
    assert.ok(!JSON.stringify(request).includes('Do not send'));
    assert.equal(activeModelUses(row.id), 0);
    bad = true;
    await assert.rejects(invokeDecider(row, { jpeg: Buffer.from('image'), candidates }), /probabilities/);
    assert.equal(activeModelUses(row.id), 0);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
test('install completion creates one on-demand model without selecting an unqualified default', async () => {
  await mkdir(runtime.deciderModelsDir(), { recursive: true });
  await mkdir(join(runtime.deciderRuntimeDir(), 'build/bin'), { recursive: true });
  for (const [name, bytes] of Object.entries(runtime.D1_FILES)) {
    const file = await open(join(runtime.deciderModelsDir(), name), 'w'); await file.truncate(bytes); await file.close();
  }
  await writeFile(runtime.deciderBinary(), 'fixture');
  await writeFile(join(runtime.deciderModelsDir(), 'installed.json'), JSON.stringify({ revision: runtime.D1_REVISION,
    files: Object.fromEntries(Object.entries(runtime.D1_FILES).map(([name, bytes]) => [name, { bytes, sha256: runtime.D1_SHA256[name] }])) }));
  await writeFile(join(runtime.deciderRuntimeDir(), 'installed.json'), JSON.stringify({ commit: runtime.DECIDER_COMMIT, backend: 'vulkan', sha256: '0'.repeat(64) }));
  install.ensureInstalledModelRows('d1-3b');
  const row = store.findRegistryRow('d1-3b')!;
  assert.equal(row.qualificationAdapter, 'direct');
  assert.deepEqual(row.implementedTasks, ['sourceDecide']);
  assert.equal(row.managedLaunch?.port, 18093);
  assert.equal(row.managedLaunch?.startOnBoot, false);
  assert.equal(modelDefaultFor('sourceDecide'), undefined);
  assert.equal(rowHasOperation(row, 'vision'), false);
  store.saveProbeResult(row.id, { operation: 'sourceDecide', ok: true, outcome: 'passed', at: 1 });
  assert.equal(rowHasOperation(store.findRegistryRow(row.id)!, 'sourceDecide'), true);
  setModelDefault('sourceDecide', 'hayai-ocr-v2');
  install.ensureInstalledModelRows('d1-3b');
  assert.equal(modelDefaultFor('sourceDecide'), 'hayai-ocr-v2');
  assert.equal(install.uninstallPlan('llama-decider').blocked?.includes('Uninstall d1'), true);
  const release = acquireModelUse('d1-3b');
  assert.ok(install.uninstallPlan('d1-3b').blocked);
  release();
  install.uninstallTarget('d1-3b');
  assert.equal(store.findRegistryRow('d1-3b')?.managedLaunch, null);
  assert.equal(runtime.deciderInstalled('d1-3b').installed, false);
});


test('changed geometry and source-page preparation prevent stale choices from being applied', () => {
  const line = createLine();
  const accepted = { ...compareOcrReadings(readings), source: '待って', decision: decideChoice(distribution(), base) };
  sqlite.prepare('UPDATE lines SET x=.5 WHERE id=?').run(line.id);
  assert.equal(saveOcrConsensus('e', line, accepted)?.source, '');
  const fresh = createLine();
  accepted.decision.pageSourceStamp = JSON.stringify(['', 0, '', '']);
  const doc = getDoc<any>(`page:${fresh.imageId}`, {});
  putDoc('e', doc.id, { prepared: 'changed.jpg', preparedAt: Date.now() }, doc.revision);
  assert.equal(saveOcrConsensus('e', fresh, accepted)?.source, '');
  assert.equal(saveFillMissingSource('e', fresh, accepted)?.source, '');
});


test('qualification requires the visible reading in both candidate orders', async () => {
  const { probeModelRow } = await import('../src/lib/server/modelProbe');
  const row = store.findRegistryRow('d1-3b')!;
  let calls = 0;
  const probe = await probeModelRow(row, 'sourceDecide', { invoke: async (_row, _task, input) => {
    calls++;
    const id = input.candidates.find((c: any) => c.source === (calls === 1 ? '待って' : '持って')).id;
    return { choice: id, probabilities: Object.fromEntries([...input.candidates.map((c: any) => [c.id, c.id === id ? 1 : 0]), ['none', 0], ['unclear', 0]]) };
  } });
  assert.equal(calls, 2);
  assert.equal(probe.ok, false);
  assert.equal(probe.outcome, 'failed_validation');
});


test('OCR pipeline decides before translating and applies a confident minority over a plurality', async () => {
  const original = store.findRegistryRow('d1-3b')!;
  const originalDefault = modelDefaultFor('sourceDecide');
  const steps: string[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const input = JSON.parse(body);
    const criteria = input.questions.transcription.criteria;
    const id = Object.keys(criteria).find(key => criteria[key] === '待って')!;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers: { transcription: { choice: id,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === id ? .94 : .02])) } } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    store.upsertRegistryRow({ ...original, managedLaunch: null, http: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, apiKeyEnv: '' } });
    setModelDefault('sourceDecide', 'd1-3b');
    const result = await readOcrConsensus(Buffer.from('image'), new AbortController().signal,
      async id => id === 'reader-3' ? '待って' : '持って', async source => `English ${source}`, 'japanese',
      ['reader-1', 'reader-2', 'reader-3'], { onDecide: () => steps.push('decide'), onTranslate: () => steps.push('translate') });
    assert.equal(result.agreed, true); // independent plurality evidence is preserved
    assert.equal(result.source, '待って');
    assert.equal(result.decision?.status, 'accepted');
    assert.deepEqual(steps, ['decide', 'translate']);
  } finally {
    store.upsertRegistryRow(original);
    setModelDefault('sourceDecide', originalDefault);
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('model packs retain selected deciders, Off and thresholds, and report missing decider dependencies', async () => {
  const { previewPackExport, parseModelPack } = await import('../src/lib/modelPack');
  const selections = snapshotProfileSelections(regionAiSettings({ transcriptionDecider: { engine: 'd1-3b', model: '' }, deciderMinProbability: .87 }));
  const result = previewPackExport([], [{ id: 'decider-profile', name: 'Decider', updatedAt: 1, selections }]);
  assert.deepEqual(parseModelPack(result.pack).profiles[0].selections, selections);
  assert.ok(result.profilesNeedingConfig[0].excludedModels.some(item => item.id === 'd1-3b'));
  const off = previewPackExport([], [{ id: 'off-profile', name: 'Off', updatedAt: 1, selections: { ...selections, transcriptionDecider: null } }]);
  assert.equal(parseModelPack(off.pack).profiles[0].selections.transcriptionDecider, null);
});
