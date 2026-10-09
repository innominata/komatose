import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ImageRow } from '../src/lib/types';
import { nextUnfinishedPage, prepareActionConfirmation, preparePageLabel } from '../src/lib/prepareActions';

const images = [
  { id: 'a', originalName: 'first.png', role: 'page' },
  { id: 'b', originalName: 'second.png', role: 'page' },
  { id: 'c', originalName: 'third.png', role: 'page' },
  { id: 'd', originalName: 'fourth.png', role: 'page' },
] as ImageRow[];

test('Typeset advances in reading order while skipping pages already done', () => {
  const done = new Set(['a', 'b']);
  assert.equal(nextUnfinishedPage(images, 'a', id => done.has(id))?.id, 'c');
});

test('Typeset wraps to earlier unfinished pages and stays put when all are done', () => {
  assert.equal(nextUnfinishedPage(images, 'd', id => id !== 'b')?.id, 'b');
  assert.equal(nextUnfinishedPage(images, 'd', () => true), undefined);
  assert.equal(nextUnfinishedPage(images.slice(0, 1), 'a', () => false), undefined);
  assert.equal(nextUnfinishedPage(images, 'missing', () => false), undefined);
});

test('a reopened page is eligible even when it has an older completion mark', () => {
  const marks = { a: 'v2', b: 'v1', c: 'v2', d: 'v2' };
  const current = { a: 'v2', b: 'v3', c: 'v2', d: 'v2' };
  assert.equal(nextUnfinishedPage(images, 'a', id => marks[id as keyof typeof marks] === current[id as keyof typeof current])?.id, 'b');
});

test('every destructive page operation describes its scope and asks confirmation', () => {
  for (const op of ['crop', 'resize', 'nudge', 'revert', 'split', 'auto-crop', 'auto-align', 'combine', 'reslice', 'reorder', 'delete']) {
    const message = prepareActionConfirmation({ op, imageId: 'b', width: 300, height: 600, dx: -5, dy: 10 }, images);
    assert.ok(message?.includes('?'), op);
    if (op !== 'reorder') assert.ok(message?.includes('page 2 (second.png)'), op);
  }
  assert.match(prepareActionConfirmation({ op: 'delete', imageIds: ['b', 'c'] }, images)!, /page 2.*page 3.*cannot be undone/);
  assert.match(prepareActionConfirmation({ op: 'resize', imageId: 'b', width: 300, height: 600 }, images)!, /300 × 600/);
});

test('reslice confirmation distinguishes automatic and previewed cuts and excludes credits from chapter scope', () => {
  assert.match(prepareActionConfirmation({ op: 'reslice' }, [...images, { id: 'credit', role: 'pre-credits' } as ImageRow])!, /4 chapter pages.*automatic cuts/);
  assert.match(prepareActionConfirmation({ op: 'reslice', imageIds: ['b'], cuts: [100, 200] }, images)!, /page 2.*3 pages using the previewed cuts/);
  assert.match(prepareActionConfirmation({ op: 'reslice', imageIds: ['b'], cuts: [] }, images)!, /1 page using the previewed cuts/);
});

test('non-destructive previews, additions and ordinary text edits do not prompt', () => {
  for (const op of ['reslice-preview', 'add-credits', 'extract', 'caption'])
    assert.equal(prepareActionConfirmation({ op }, images), null);
  assert.equal(preparePageLabel('missing', images), 'the selected page');
});
