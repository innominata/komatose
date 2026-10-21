import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { composeDetections, minRegionPx, MIN_AUTO_REGION_PX } from '../src/lib/server/detect';
import { fuseDetections, type FusedRegion } from '../src/lib/server/detectFusion';
import type { WorkerRegion } from '../src/lib/server/ocr';

const r = (backend: string, cls: string, score: number, box: [number, number, number, number]): WorkerRegion => ({ backend, cls, score, box });
const text = (rows: FusedRegion[]) => rows.filter((row) => row.cls !== 'bubble');

const page16 = JSON.parse(readFileSync(new URL('./fixtures/geometry/page16.json', import.meta.url), 'utf8'));
for (const fixture of page16) {
  test(`page 16 ${fixture.name}: joined dialogue has two regions, without a spanning CTD box`, () => {
    const rows = composeDetections(fixture.outputs, fixture.width, fixture.height);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.kind === 'bubble'));
    // Keep the two independent RT-DETR text boxes as the geometry seeds.
    const expected = fixture.outputs.rtdetr.filter((row: WorkerRegion) => row.cls === 'text_bubble');
    for (const row of rows) {
      assert.ok(expected.some((seed: WorkerRegion) => Math.abs(row.place.x * fixture.width - seed.box[0]) < 4 && Math.abs(row.place.y * fixture.height - seed.box[1]) < 4));
    }
  });
}

test('a weak free-text box alone is dropped; a second detector keeps it', () => {
  const weak = r('rtdetr', 'text_free', 0.25, [100, 100, 160, 180]);
  const ran = ['rtdetr', 'ctd'] as const;
  assert.equal(text(fuseDetections([weak], { ran: [...ran] })).length, 0);
  const kept = text(fuseDetections([weak, r('ctd', 'text', 0.4, [104, 104, 156, 176])], { ran: [...ran] }));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].cls, 'text_free');
  assert.deepEqual(kept[0].sources, ['rtdetr', 'ctd']);
});

test('a lone detector keeps its own boxes: nobody is there to check them', () => {
  const rows = text(fuseDetections([r('ctd', 'text', 0.25, [10, 10, 50, 90])], { ran: ['ctd'] }));
  assert.equal(rows.length, 1);
});

const block = (box: [number, number, number, number], fill = 0.2, stroke = 4): WorkerRegion => ({ ...r('koharu', 'text', 0.8, box), fill, stroke });
const balloon = (box: [number, number, number, number]) => r('rtdetr', 'bubble', 0.9, box);

test('Koharu agrees with a box, and lettering no box claimed is its own region', () => {
  const koharu = block([300, 300, 360, 400]);
  const rows = text(fuseDetections([r('rtdetr', 'text_free', 0.25, [300, 302, 358, 398]), koharu], { ran: ['rtdetr', 'koharu'] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].sources, ['rtdetr', 'koharu']);
  const alone = text(fuseDetections([koharu], { ran: ['rtdetr', 'ctd', 'koharu'] }));
  assert.equal(alone.length, 1);
  assert.equal(alone[0].cls, 'text_free');
  assert.deepEqual(alone[0].sources, ['koharu']);
  assert.ok(alone[0].score < 0.7, 'mask-only lettering ranks below a confident box');
});

test('mask-only lettering inside a balloon is bubble text', () => {
  const rows = text(fuseDetections([balloon([200, 200, 500, 500]), block([300, 300, 360, 400])], { ran: ['rtdetr', 'koharu'] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cls, 'text_bubble');
});

test('a solid shape the mask marks is not lettering', () => {
  assert.equal(text(fuseDetections([block([0, 500, 300, 586], 0.85, 68)], { ran: ['rtdetr', 'koharu'] })).length, 0);
  assert.equal(text(fuseDetections([block([0, 500, 300, 586], 0.3, 60)], { ran: ['rtdetr', 'koharu'] })).length, 0);
});

test('a box that cut the lettering short grows to hold it', () => {
  const rows = text(fuseDetections([
    r('rtdetr', 'text_free', 0.9, [100, 100, 200, 200]),
    block([110, 120, 200, 240]),
  ], { ran: ['rtdetr', 'koharu'] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].box, [100, 100, 200, 240]);
});

test('pieces of one effect within reach are one region, but not across balloons', () => {
  const pieces = text(fuseDetections([block([100, 100, 160, 160]), block([180, 100, 240, 160])], { ran: ['rtdetr', 'koharu'] }));
  assert.equal(pieces.length, 1);
  assert.deepEqual(pieces[0].box, [100, 100, 240, 160]);
  const walled = text(fuseDetections([
    balloon([90, 90, 170, 170]), balloon([175, 90, 250, 170]),
    block([100, 100, 160, 160]), block([180, 100, 240, 160]),
  ], { ran: ['rtdetr', 'koharu'] }));
  assert.equal(walled.length, 2);
});

test('boxes in two different balloons are two regions however they overlap', () => {
  const rows = text(fuseDetections([
    balloon([100, 100, 200, 300]), balloon([190, 100, 300, 300]),
    r('rtdetr', 'text_bubble', 0.9, [120, 120, 200, 280]),
    r('ctd', 'text', 0.9, [185, 120, 280, 280]),
  ], { ran: ['rtdetr', 'ctd'] }));
  assert.equal(rows.length, 2);
});

test('one column of a bubble is a fragment of its text box, not another region', () => {
  const rows = text(fuseDetections([
    r('rtdetr', 'text_bubble', 0.95, [100, 100, 220, 300]),
    r('ctd', 'text', 0.9, [105, 105, 140, 290]),
    r('paddle', 'text', 1, [150, 110, 180, 200]),
  ], { ran: ['rtdetr', 'ctd', 'paddle'] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cls, 'text_bubble');
  assert.deepEqual(rows[0].sources, ['rtdetr', 'ctd', 'paddle']);
});

test('a looser box and a tighter box around one balloon are one region, with the class of either', () => {
  const rows = text(fuseDetections([
    r('ctd', 'text', 0.95, [128, 203, 148, 273]),
    r('rtdetr', 'text_bubble', 0.92, [119, 196, 157, 284]),
  ], { ran: ['rtdetr', 'ctd'] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cls, 'text_bubble');
});

test('free lettering inside a bubble stays its own region', () => {
  const rows = text(fuseDetections([
    r('rtdetr', 'text_bubble', 0.95, [100, 100, 300, 300]),
    r('rtdetr', 'text_free', 0.9, [120, 120, 180, 200]),
  ], { ran: ['rtdetr', 'ctd'] }));
  assert.deepEqual(rows.map((row) => row.cls).sort(), ['text_bubble', 'text_free']);
});

test('an oversized box does not chain separate lettering together', () => {
  const rows = text(fuseDetections([
    r('coo', 'text_free', 0.85, [467, 590, 568, 819]),
    r('rtdetr', 'text_bubble', 0.94, [496, 460, 555, 590]),
    r('ctd', 'text', 0.45, [494, 476, 562, 807]),
  ], { ran: ['rtdetr', 'ctd'] }));
  assert.equal(rows.length, 2);
});

test('a block of line-grouped Paddle text over two bubbles is not a region', () => {
  const rows = text(fuseDetections([
    r('rtdetr', 'text_bubble', 0.95, [100, 100, 160, 240]),
    r('rtdetr', 'text_bubble', 0.95, [300, 100, 360, 240]),
    r('paddle', 'text', 1, [90, 90, 370, 250]),
  ], { ran: ['rtdetr', 'paddle'] }));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.backend === 'rtdetr'));
});

test('sound effects beside dialogue do not erase the Paddle block that holds both', () => {
  const rows = text(fuseDetections([
    r('coo', 'text_free', 0.8, [200, 80, 330, 160]),
    r('coo', 'text_free', 0.8, [100, 390, 230, 450]),
    r('paddle', 'text', 1, [100, 80, 330, 455]),
  ], { ran: ['paddle'] }));
  assert.equal(rows.filter((row) => row.backend === 'paddle').length, 1);
});

test('regions from a custom detector pass through untouched', () => {
  const rows = fuseDetections([{ cls: 'text', score: 0.3, box: [0, 0, 50, 50], backend: 'yolo' }], { ran: [] });
  assert.equal(rows.length, 1);
});

test('composed regions keep the detector class and report who agreed', () => {
  const rows = composeDetections({
    rtdetr: [r('rtdetr', 'text_bubble', 0.9, [100, 100, 200, 260]), r('rtdetr', 'bubble', 0.9, [80, 80, 220, 280])],
    ctd: [r('ctd', 'text', 0.8, [105, 105, 195, 255])],
  }, 1000, 1000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'bubble');
  assert.deepEqual(rows[0].provenance?.sources, ['rtdetr', 'ctd']);
  assert.ok(rows[0].bubble);
});

test('bubbles whose text no detector found are not read', () => {
  const rows = composeDetections({
    rtdetr: [r('rtdetr', 'bubble', 0.9, [80, 80, 220, 280])],
    ctd: [],
  }, 1000, 1000);
  assert.equal(rows.length, 0);
});

test('the smallest saved region follows the page resolution', () => {
  assert.equal(minRegionPx(654, 919), 10);
  assert.equal(minRegionPx(1414, 2000), 17);
  assert.equal(minRegionPx(4000, 6000), MIN_AUTO_REGION_PX);
  const small = composeDetections({
    rtdetr: [r('rtdetr', 'text_bubble', 0.9, [121, 198, 138, 282])],
    ctd: [],
  }, 654, 919);
  assert.equal(small.length, 1);
  // Under the floor: speckle the detector is unsure of is dropped, short dialogue it is sure of is kept.
  assert.equal(composeDetections({ rtdetr: [r('rtdetr', 'text_bubble', 0.6, [121, 198, 138, 282])], ctd: [] }, 4000, 6000).length, 0);
  assert.equal(composeDetections({ rtdetr: [r('rtdetr', 'text_bubble', 0.9, [121, 198, 138, 282])], ctd: [] }, 4000, 6000).length, 1);
  assert.equal(composeDetections({ rtdetr: [r('rtdetr', 'text_bubble', 0.9, [121, 198, 130, 282])], ctd: [] }, 4000, 6000).length, 0);
});
