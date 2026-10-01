import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRegionDoc } from '../src/lib/regionUpdates';
import type { RegionData, WorkflowDoc } from '../src/lib/workflow';
const doc = (id: string, revision: number): WorkflowDoc<RegionData> => ({ id: 'region:' + id, revision, data: { style: { size: revision } }, canUndo: true, canRedo: false });
test('fit response replaces the visible region immediately without a chapter refresh', () => {
  const previous = { first: doc('first', 1), second: doc('second', 4) };
  const fitted = doc('first', 2);
  const next = mergeRegionDoc(previous, fitted);
  assert.equal(next.first, fitted);
  assert.equal(next.second, previous.second);
  assert.equal(next['region:first'], undefined);
  assert.equal(previous.first.revision, 1);
});
test('late responses cannot roll back a newer preview', () => {
  const regions = { first: doc('first', 5) };
  assert.equal(mergeRegionDoc(regions, doc('first', 4)), regions);
  assert.equal(mergeRegionDoc(regions, doc('first', 5)), regions);
});
