import assert from "node:assert/strict";
import test from "node:test";
import { MIN_AUTO_REGION_PX, regionsFromDetection } from "../src/lib/server/detect";
import {
  automaticRegionPolygon,
  regionPaintOrder,
  sameDetectedTextBox,
  regionRectangle,
  translatePolygon,
} from "../src/lib/regionGeometry";

test("overlapping text of different sizes remains distinct; duplicate boxes collapse", () => {
  const result = regionsFromDetection(
    [
      { cls: "text_free", box: [100, 100, 300, 300], score: 0.95 },
      { cls: "text_bubble", box: [110, 110, 145, 145], score: 0.9 },
      { cls: "text_bubble", box: [111, 111, 146, 146], score: 0.8 },
      { cls: "bubble", box: [90, 90, 310, 310], score: 0.9 },
    ],
    500,
    500,
  );
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.kind),
    ["free", "bubble"],
  );
  assert.ok(result[1].ocr.width < 50);
});

test("detector boxes under 30px on either axis are not created", () => {
  assert.equal(MIN_AUTO_REGION_PX, 30);
  const rows = regionsFromDetection(
    [
      { cls: "text_bubble", box: [10, 10, 28, 80], score: 0.9 },
      { cls: "text_free", box: [40, 40, 90, 55], score: 0.9 },
      { cls: "text_bubble", box: [100, 100, 130, 130], score: 0.95 },
      { cls: "bubble", box: [200, 200, 220, 280], score: 0.9 },
      { cls: "text_bubble", box: [300, 300, 315, 360], score: 0.99 },
      { cls: "bubble", box: [280, 280, 400, 420], score: 0.8 },
    ],
    500,
    500,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.place.width >= 30 && row.place.height >= 30));
  assert.ok(rows.some((row) => row.place.width < 50));
  assert.ok(rows.some((row) => row.place.width > 100));
});

test("absent, displaced, invalid and out-of-page geometry uses exact region bounds", () => {
  const region = { x: 0.2, y: 0.3, w: 0.1, h: 0.2 };
  const rectangle = regionRectangle(region);
  for (const points of [
    undefined,
    [],
    [
      { x: 0.7, y: 0.7 },
      { x: 0.9, y: 0.7 },
      { x: 0.9, y: 0.9 },
    ],
    [
      { x: NaN, y: 0.3 },
      { x: 0.3, y: 0.3 },
      { x: 0.3, y: 0.5 },
    ],
    [
      { x: -0.1, y: 0.3 },
      { x: 0.3, y: 0.3 },
      { x: 0.3, y: 0.5 },
    ],
  ])
    assert.deepEqual(automaticRegionPolygon(region, points), rectangle);
  assert.equal(automaticRegionPolygon(region, rectangle), rectangle);
});

test("saved detection matching preserves nested side lettering", () => {
  const large = {x:.1,y:.1,w:.4,h:.4};
  assert.equal(sameDetectedTextBox(large,{x:.11,y:.11,w:.39,h:.4}),true);
  assert.equal(sameDetectedTextBox(large,{x:.12,y:.12,w:.04,h:.1}),false);
  assert.equal(sameDetectedTextBox(large,{x:.6,y:.6,w:.4,h:.4}),false);
});

test("matching text lets redetection tighten a box, differing text never merges", () => {
  const large = {x:.1,y:.1,w:.4,h:.4};
  const tightened = {x:.12,y:.12,w:.05,h:.1};
  // Nested and far smaller, but the same recognised text: the same region.
  assert.equal(sameDetectedTextBox(large,tightened,"待って","待って"),true);
  // Nested side lettering inside a bubble is its own region, however neatly it fits.
  assert.equal(sameDetectedTextBox(large,tightened,"待って","行け"),false);
  // Text on one side only leaves the geometry to decide.
  assert.equal(sameDetectedTextBox(large,tightened,"待って",""),false);
  assert.equal(sameDetectedTextBox(large,tightened,"待って",undefined),false);
});

test("translating a polygon keeps its shape on the page", () => {
  const shape = [{ x: 0.25, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.375, y: 0.75 }];
  assert.deepEqual(translatePolygon(shape, 0.25, -0.25), [
    { x: 0.5, y: 0.25 },
    { x: 0.75, y: 0.25 },
    { x: 0.625, y: 0.5 },
  ]);
  assert.deepEqual(translatePolygon(shape, 5, -5), [
    { x: 0.75, y: 0 },
    { x: 1, y: 0 },
    { x: 0.875, y: 0.25 },
  ]);
});

test("overlapping regions paint the smallest box on top", () => {
  const small = { id: "small", x: 0.1, y: 0.1, w: 0.1, h: 0.1 };
  const large = { id: "large", x: 0, y: 0, w: 0.5, h: 0.5 };
  const peer = { id: "peer", x: 0.8, y: 0.8, w: 0.1, h: 0.1 };
  const order = regionPaintOrder([small, large, peer]);
  assert.deepEqual(order.map((item) => item.line.id), ["large", "small", "peer"]);
  assert.deepEqual(order.map((item) => item.index), [1, 0, 2]);
});
