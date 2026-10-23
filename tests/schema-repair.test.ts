import assert from 'node:assert/strict';
import test from 'node:test';
import { repairToSchema } from '../src/lib/server/schemaRepair';
import { cachedMaskOperation, rejectedClean, rememberRejectedClean } from '../src/lib/server/directorMaskCache';

const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const ids = ['4751d120-aaaa-4bbb-8ccc-000000000001', '9f00aa11-aaaa-4bbb-8ccc-000000000002'];
const observations = object({
  observations: { type: 'array', items: object({ lineId: { type: 'string', enum: ids }, enclosure: { type: 'string' }, reason: { type: 'string', minLength: 1 } }) },
});
const coverage = object({
  edits: { type: 'array', items: object({ lineId: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, polygon: { type: 'array' }, reason: { type: 'string' } }) },
  regions: { type: 'array', items: object({ x: { type: 'number' }, y: { type: 'number' } }) },
});

test('a bare item goes into its list, and extra fields are dropped', () => {
  assert.deepEqual(repairToSchema({ lineId: ids[0], enclosure: 'none', reason: 'Open sky', mood: 'calm' }, observations),
    { observations: [{ lineId: ids[0], enclosure: 'none', reason: 'Open sky' }] });
});

test('a bare region proposal without an ID is a new region, not an edit', () => {
  assert.deepEqual(repairToSchema({ x: 0.1, y: 0.2, polygon: [], reason: 'Missed caption' }, coverage), { regions: [{ x: 0.1, y: 0.2 }], edits: [] });
});

test('a garbled ID maps only to the one ID with the same first eight characters', () => {
  const fixed = repairToSchema({ observations: [{ lineId: '4751d120-f656-4a10-b6dd-dca177693589', enclosure: 'box', reason: 'x' }] }, observations) as any;
  assert.equal(fixed.observations[0].lineId, ids[0]);
  const unknown = repairToSchema({ observations: [{ lineId: 'deadbeef-0000', enclosure: 'box', reason: 'x' }] }, observations) as any;
  assert.equal(unknown.observations[0].lineId, 'deadbeef-0000', 'no guess without a unique prefix match');
});

test('a valid reply is left unchanged', () => {
  const valid = { observations: [{ lineId: ids[1], enclosure: 'bubble', reason: 'Tail points to speaker' }] };
  assert.deepEqual(repairToSchema(valid, observations), valid);
});

test('a run reuses identical mask requests and forgets failed ones', async () => {
  let calls = 0;
  const op = (async (payload: any) => {
    calls++;
    if (payload.fail) throw new Error('worker failed');
    return { result: { pixels: 5 }, artifact: 'mask' };
  }) as any;
  const cached = cachedMaskOperation(`run-${Date.now()}`, op);
  await cached({ cmd: 'mask', path: 'a.png', expansion: 5 });
  await cached({ cmd: 'mask', path: 'a.png', expansion: 5 });
  assert.equal(calls, 1);
  await cached({ cmd: 'mask', path: 'a.png', expansion: 13 });
  assert.equal(calls, 2, 'a different request is not a repeat');
  await cached({ cmd: 'clean', path: 'a.png' });
  await cached({ cmd: 'clean', path: 'a.png' });
  assert.equal(calls, 4, 'only masks are cached');
  await assert.rejects(cached({ cmd: 'mask', path: 'b.png', fail: true }));
  await assert.rejects(cached({ cmd: 'mask', path: 'b.png', fail: true }));
  assert.equal(calls, 6, 'a failed mask is asked again');
});

test('a rejected deterministic clean is remembered per run', () => {
  const run = `run-rejected-${Date.now()}`;
  assert.equal(rejectedClean(run, 'lama|a|m'), false);
  rememberRejectedClean(run, 'lama|a|m');
  assert.equal(rejectedClean(run, 'lama|a|m'), true);
  assert.equal(rejectedClean(run, 'lama|a|wider'), false, 'a different mask is a new request');
  assert.equal(rejectedClean(`${run}-other`, 'lama|a|m'), false, 'other runs start clean');
});
