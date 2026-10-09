import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CAPABILITIES, CAPABILITY_REQUIREMENTS, qualificationChecks, qualificationQueue, qualificationWarnings, type CapabilityId } from '../src/lib/modelCapabilities';
import { rowHasOperation, allowedOperations, type ModelRow } from '../src/lib/modelRegistry';
import { MODEL_TASK_IDS } from '../src/lib/modelTasks';

const root = await mkdtemp(join(tmpdir(), 'model-capabilities-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.SCAN_BUNDLED_PACKAGES_DIR = join(root, 'packages');
process.env.DATABASE_URL = join(root, 'data/test.db');
await mkdir(join(root, 'data'), { recursive: true });
for (const [id, adapter] of [['reader', 'native-ocr'], ['translator', 'native-translator'], ['browser', 'browser-proofreader']]) {
  const dir = join(root, 'packages', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'model.json'), JSON.stringify({ version: 1, id, name: id, revision: '1', access: id === 'browser' ? 'proofreader' : 'local_http', adapter: { id: adapter } }));
}
const store = await import('../src/lib/server/modelRegistryStore');
const { runQualification } = await import('../src/lib/server/modelQualification');
const { executeModelTask } = await import('../src/lib/server/modelTaskRunner');
const { validateProfileSelections } = await import('../src/lib/modelProfiles');
after(() => rm(root, { recursive: true, force: true }));
const general = () => store.findRegistryRow('fixture-chat')!;
store.createLocalHttpRow({ name: 'Fixture chat', slug: 'fixture-chat' });
const pass = (row: ModelRow, id: CapabilityId) => ({ capability: id, ok: true, outcome: 'passed' as const, at: Date.now(), fingerprint: row.capabilityFingerprints![id] });

test('all capability combinations derive the intended jobs, without enabling image operations', () => {
  for (let bits = 0; bits < 16; bits++) {
    const row = general();
    row.capabilities = Object.fromEntries(CAPABILITIES.filter((_, i) => bits & (1 << i)).map(({ id }) => [id, pass(row, id)]));
    for (const [job, required] of Object.entries(CAPABILITY_REQUIREMENTS)) {
      assert.equal(rowHasOperation(row, job as any), required.every(id => row.capabilities?.[id]?.ok), `${bits}: ${job}`);
    }
    for (const task of ['detect', 'textMask', 'segmentBubble', 'inpaint', 'cleaning'] as const) assert.equal(rowHasOperation(row, task), false);
  }
});

test('specialists qualify independently; profiles accept transcription-only reviewers', async () => {
  let reader = store.findRegistryRow('reader')!;
  const read = await runQualification(reader, 'transcription', { invoke: async (_row, task) => {
    assert.equal(task, 'vision'); return { source: '待って！' };
  } });
  reader = store.saveCapabilityResults(reader.id, read.samples);
  assert.deepEqual(qualificationChecks(reader), ['transcription']);
  assert.deepEqual(allowedOperations(reader), ['vision', 'sourceReview']);
  const translator = store.findRegistryRow('translator')!;
  const result = await runQualification(translator, 'translation', { invoke: async (_row, task, input) => {
    assert.equal(task, 'translate'); return input.boxes.map((box: any) => ({ ...box, translation: 'Test.' }));
  } });
  const saved = store.saveCapabilityResults(translator.id, result.samples);
  assert.deepEqual(allowedOperations(saved), ['translate']);
  assert.equal(rowHasOperation(saved, 'advisory'), false);
  const chat = general();
  chat.capabilities = Object.fromEntries(CAPABILITIES.map(({ id }) => [id, pass(chat, id)]));
  assert.deepEqual(validateProfileSelections({ translate: { engine: saved.id, model: '' }, proofread: { engine: chat.id, model: '' }, reviewers: [{ engine: reader.id, model: '' }], transcriptionModels: [reader.id] }, [saved, reader, chat]), []);
  const review = await executeModelTask(reader, 'sourceReview', {}, { invoke: async () => ({ source: '待って！' }) });
  assert.equal(review.status, 'unassessed');
  assert.equal(review.translation, '');
});

test('image checks share one call and record independent outcomes, including absent fields', async () => {
  let calls = 0;
  const result = await runQualification(general(), 'imageUnderstanding', { invoke: async (_row, task, input) => {
    calls++;
    assert.equal(task, 'advisory');
    assert.equal(input.images.length, 2);
    assert.notDeepEqual(input.images[0], input.images[1]);
    return { source: '待って！' };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result.samples.map(s => [s.capability, s.ok]), [['transcription', true], ['imageUnderstanding', false]]);
  const inverse = await runQualification(general(), 'transcription', { invoke: async () => ({ firstHasText: true, secondHasText: false, secondShape: 'circle', secondColor: 'blue' }) });
  assert.deepEqual(inverse.samples.map(s => s.ok), [false, true]);
  const both = await runQualification(general(), 'transcription', { invoke: async () => ({ source: '待って！', firstHasText: true, secondHasText: false, secondShape: 'circle', secondColor: 'blue' }) });
  assert.ok(both.samples.every(s => s.ok));
});

test('conversation checks structured context and instruction following', async () => {
  const good = await runQualification(general(), 'conversation', { invoke: async () => ({ remembered: 'lantern', total: 10, corrected: 'This is a test.' }) });
  assert.equal(good.samples[0].ok, true);
  const bad = await runQualification(general(), 'conversation', { invoke: async () => ({ remembered: 'lantern', total: 12, corrected: 'This is a test.' }) });
  assert.equal(bad.samples[0].outcome, 'failed_validation');
});

test('batches deduplicate images, retry failed checks, and exclude stale failures from failed queue', () => {
  const row = general();
  assert.deepEqual(qualificationQueue([row], 'all').map(q => q.op), ['conversation', 'translation', 'transcription', 'detect']);
  row.capabilities = Object.fromEntries(CAPABILITIES.map(({ id }) => [id, pass(row, id)]));
  row.capabilities.imageUnderstanding!.ok = false;
  assert.deepEqual(qualificationQueue([row], 'failed').map(q => q.op), ['imageUnderstanding']);
  row.capabilities.imageUnderstanding!.fingerprint = 'old';
  assert.deepEqual(qualificationQueue([row], 'failed'), []);
  assert.deepEqual(qualificationQueue([row], 'untested').map(q => q.op), ['imageUnderstanding', 'detect']);
});

test('legacy language passes do not qualify general models; browser services retain integration checks', () => {
  const row = general();
  row.probes = Object.fromEntries(MODEL_TASK_IDS.map(operation => [operation, { operation, ok: true, at: 1, fingerprint: row.taskFingerprints![operation] }]));
  assert.equal(rowHasOperation(row, 'translate'), false);
  assert.equal(rowHasOperation(row, 'pageImageProofread'), false);
  assert.equal(rowHasOperation(row, 'detect'), true);
  const browser = store.findRegistryRow('browser')!;
  assert.deepEqual(qualificationChecks(browser), ['pageImageProofread']);
});

test('current failures block use; stale checks warn and configuration changes still invalidate queued requests', async () => {
  let row = general();
  row = store.saveCapabilityResults(row.id, CAPABILITIES.map(({ id }) => pass(row, id)));
  assert.equal(rowHasOperation(row, 'pageImageProofread'), true);
  for (const outcome of ['error', 'cancelled'] as const) row = store.saveCapabilityResults(row.id, [{ ...pass(row, 'conversation'), ok: false, outcome }]);
  assert.equal(rowHasOperation(store.listRegistryRows(true).find(r => r.id === row.id)!, 'chapterReview'), true);
  row = store.saveCapabilityResults(row.id, [{ ...pass(row, 'conversation'), ok: false, outcome: 'failed_validation' }]);
  assert.equal(rowHasOperation(row, 'chapterReview'), false);
  assert.equal(rowHasOperation(row, 'sourceReview'), true);
  row = store.saveCapabilityResults(row.id, [pass(row, 'conversation')]);
  store.upsertRegistryRow({ ...row, modelRevision: 'changed' });
  assert.equal(rowHasOperation(general(), 'translate'), true);
  assert.ok(qualificationWarnings(general()).some(warning => warning.includes('Translation')));
  let invoked = false;
  await assert.rejects(executeModelTask(row, 'chapterReview', {}, { invoke: async () => { invoked = true; return {}; } }), /changed while this request was queued/);
  assert.equal(invoked, false);
});

test('admin API saves shared results and rejects removed language-job checks', async () => {
  const { POST } = await import('../src/routes/api/admin/models/+server');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.messages[1].content.filter((part: any) => part.type === 'image_url').length, 2);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ source: '待って！', firstHasText: true, secondHasText: false, secondShape: 'circle', secondColor: 'blue' }) } }] });
  };
  const request = (body: unknown) => POST({ locals: { user: { id: 'admin', username: 'Admin', role: 'admin' } }, request: new Request('http://fixture/api/admin/models', { method: 'POST', body: JSON.stringify(body) }) } as any);
  try {
    const removed = await request({ action: 'test', id: general().id, check: 'sourceReview' });
    assert.equal(removed.status, 400);
    const response = await request({ action: 'test', id: general().id, check: 'transcription' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.equal(body.samples.length, 2);
    assert.equal(calls, 1);
    assert.equal(rowHasOperation(body.row, 'sourceReview'), true);
    assert.equal(body.row.probes?.sourceReview, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('an unqualified default model is tested and recorded before the requested action', async () => {
  const { setModelDefault } = await import('../src/lib/server/modelDefaultStore');
  store.upsertRegistryRow({ ...general(), capabilities: {}, probes: {} });
  const row = general();
  const boxes = [{ x: 0, y: 0, w: 1, h: 1, source: '次', lineType: '""', literal: '', translation: '', reasoning: '' }];
  setModelDefault('translate', row.id);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ items: [{ i: 0, translation: 'Test.', literal: 'test', reasoning: '' }] }) } }] });
  };
  try {
    let ran = false;
    const output = await executeModelTask(row, 'translate', { boxes, requireTranslation: true }, {
      invoke: async () => { ran = true; return [{ translation: 'Next.' }]; },
    });
    assert.equal(ran, true);
    assert.ok(fetches >= 1);
    assert.equal(output[0].translation, 'Next.');
    assert.equal(output[0].source, '次');
    const saved = store.findRegistryRow(row.id)!;
    assert.equal(saved.capabilities?.translation?.ok, true);
    assert.equal(rowHasOperation(saved, 'translate'), true);
    fetches = 0;
    ran = false;
    await executeModelTask(saved, 'translate', { boxes, requireTranslation: true }, {
      invoke: async () => { ran = true; return [{ translation: 'Next.' }]; },
    });
    assert.equal(fetches, 0);
    assert.equal(ran, true);
    let ranOther = false;
    await assert.rejects(
      executeModelTask(store.findRegistryRow('reader')!, 'translate', { boxes }, {
        invoke: async () => { ranOther = true; return [{ translation: 'No.' }]; },
      }),
      /does not implement Translate/,
    );
    assert.equal(ranOther, false);
  } finally {
    globalThis.fetch = originalFetch;
    setModelDefault('translate', undefined);
  }
});

test('a default model that fails its test reports that failure and does not run the action', async () => {
  const { setModelDefault } = await import('../src/lib/server/modelDefaultStore');
  const row = general();
  setModelDefault('chapterReview', row.id);
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('connection refused'); };
  try {
    let ran = false;
    await assert.rejects(
      executeModelTask(row, 'chapterReview', { script: 'p1' }, { invoke: async () => { ran = true; return { summary: 'Done', issues: [], questions: [], notes: '' }; } }),
      /failed the Review Chapter test[\s\S]*connection refused/,
    );
    assert.equal(ran, false);
    const saved = store.findRegistryRow(row.id)!;
    assert.equal(saved.capabilities?.conversation?.ok, false);
    assert.match(saved.capabilities?.conversation?.reason || '', /connection refused/);
    const again = fetches;
    await assert.rejects(
      executeModelTask(saved, 'chapterReview', { script: 'p1' }, { invoke: async () => ({ summary: 'Done', issues: [], questions: [], notes: '' }) }),
      /connection refused/,
    );
    assert.ok(fetches > again);
  } finally {
    globalThis.fetch = originalFetch;
    setModelDefault('chapterReview', undefined);
  }
});

test('cancelled capability requests retain their current evidence and record the attempt', async () => {
  let row = general();
  row = store.saveCapabilityResults(row.id, [pass(row, 'conversation')]);
  let invoked = false;
  const result = await runQualification(row, 'conversation', { abort: AbortSignal.abort(), invoke: async () => { invoked = true; return {}; } });
  assert.equal(invoked, false);
  assert.equal(result.samples[0].outcome, 'cancelled');
  row = store.saveCapabilityResults(row.id, result.samples);
  assert.equal(rowHasOperation(row, 'chapterReview'), true);
  assert.equal(row.capabilityHistory!.at(-1)!.outcome, 'cancelled');
});

test('stale successes and failures remain executable without an automatic retest', async () => {
  const originalFetch = globalThis.fetch;
  let retests = 0;
  globalThis.fetch = async () => { retests++; throw new Error('A stale check must not be rerun here'); };
  try {
    for (const ok of [true, false]) {
      const row = store.saveCapabilityResults(general().id, [{ ...pass(general(), 'translation'), fingerprint: 'old-code', ok, outcome: ok ? 'passed' : 'failed_validation' }]);
      assert.equal(rowHasOperation(row, 'translate'), true);
      assert.ok(qualificationWarnings(row).some(warning => warning.includes('Translation')));
      const boxes = [{ source: '다음', x: 0, y: 0, w: 1, h: 1, lineType: '""', literal: '', translation: '', reasoning: '' }];
      const result = await executeModelTask(row, 'translate', { boxes }, { invoke: async () => [{ translation: 'Next.' }] });
      assert.equal(result[0].translation, 'Next.');
    }
    assert.equal(retests, 0);
    const reader = store.findRegistryRow('reader')!;
    const direct = { ...reader, qualificationAdapter: 'direct' as const, probes: { vision: { operation: 'vision' as const, ok: false, at: 1, fingerprint: 'old-code' } } };
    assert.equal(rowHasOperation(direct, 'vision'), true);
    assert.equal(rowHasOperation(direct, 'translate'), false);
    const currentFailed = { ...general(), capabilities: { translation: { ...pass(general(), 'translation'), ok: false, outcome: 'failed_validation' as const } } };
    assert.equal(rowHasOperation(currentFailed, 'translate'), false);
    assert.equal(rowHasOperation({ ...currentFailed, probes: { translate: { operation: 'translate', fingerprint: 'legacy', ok: true, at: 1 } } }, 'translate'), false,
      'a current failure cannot be bypassed by an older job check');
  } finally { globalThis.fetch = originalFetch; }
});
