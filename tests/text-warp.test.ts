import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStyle, DEFAULT_STYLE } from "../src/lib/workflow";
import {
  hasTextWarp,
  layoutWarpBox,
  psdTextWarp,
  warpFontPath,
  warpPad,
  warpPoint,
} from "../src/lib/textWarp";

const box = { left: 0, top: 0, right: 100, bottom: 40 };

test("Warp Text is off until a style and bend are set", () => {
  assert.equal(hasTextWarp({ warpStyle: "none", warpBend: 50 }), false);
  assert.equal(hasTextWarp({ warpStyle: "arc", warpBend: 0 }), false);
  assert.equal(hasTextWarp({ warpStyle: "arc", warpBend: 40 }), true);
  assert.equal(
    psdTextWarp({ ...DEFAULT_STYLE, warpStyle: "none", warpBend: 40 }),
    undefined,
  );
});

test("pickStyle keeps Photoshop warp fields", () => {
  const style = pickStyle({
    warpStyle: "arcLower",
    warpBend: 35,
    size: 12,
    junk: true,
  });
  assert.equal(style.warpStyle, "arcLower");
  assert.equal(style.warpBend, 35);
  assert.equal("junk" in style, false);
});

test("PSD warp writes Photoshop Bend percents", () => {
  const warp = psdTextWarp({
    ...DEFAULT_STYLE,
    warpStyle: "arc",
    warpBend: 30,
  });
  assert.deepEqual(warp, {
    style: "arc",
    value: 30,
    perspective: 0,
    perspectiveOther: 0,
    rotate: "horizontal",
  });
});

test("Arc envelope is a rainbow: middle sits above the sides", () => {
  const style = { warpStyle: "arc" as const, warpBend: 50 };
  const centre = warpPoint(50, 20, box, style);
  const left = warpPoint(0, 20, box, style);
  const identity = warpPoint(50, 20, box, { warpStyle: "arc", warpBend: 0 });
  assert.equal(identity.y, 20);
  assert.equal(centre.x, 50);
  assert.ok(
    centre.y < left.y,
    "positive Bend raises the middle relative to the sides",
  );
});

test("Arc Lower bends the bottom more than the top", () => {
  const style = { warpStyle: "arcLower" as const, warpBend: 80 };
  const top = warpPoint(0, 0, box, style);
  const bottom = warpPoint(0, 40, box, style);
  assert.ok(Math.abs(bottom.y - 40) > Math.abs(top.y - 0));
});

test("layout box and raster pad follow the fitted rows", () => {
  const rows = [
    { text: "Hi", x: 10, baseline: 30, width: 40 },
    { text: "there", x: 8, baseline: 50, width: 50 },
  ];
  assert.deepEqual(layoutWarpBox(rows, 20), {
    left: 8,
    right: 58,
    top: 10,
    bottom: 56,
  });
  assert.equal(warpPad({ warpStyle: "none", warpBend: 100 }, 80, 40), 0);
  assert.equal(warpPad({ warpStyle: "arc", warpBend: 50 }, 80, 40), 20);
});

test("glyph outlines sample through the envelope instead of sliding upright", () => {
  const style = { warpStyle: "arc" as const, warpBend: 80 };
  const d = warpFontPath(
    [
      { command: "moveTo", args: [0, 0] },
      { command: "lineTo", args: [100, 0] },
      { command: "closePath", args: [] },
    ],
    0,
    20,
    1,
    false,
    box,
    style,
  );
  const ys = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) =>
    Number(m[2]),
  );
  assert.ok(ys.length > 4, "the segment is subdivided");
  const mid = Math.min(...ys);
  assert.ok(
    mid < ys[0] && mid < ys.at(-1)!,
    "the bar itself bends into an arc",
  );
});

test("tiny warped segments avoid redundant subdivisions", () => {
  const d = warpFontPath(
    [
      { command: "moveTo", args: [0, 0] },
      { command: "lineTo", args: [1, 0] },
    ],
    50,
    20,
    0.02,
    false,
    box,
    { warpStyle: "arc", warpBend: 40 },
  );
  assert.equal((d.match(/L/g) ?? []).length, 1);
});

test("adaptive curves follow inflections within subpixel tolerance", () => {
  const style = { warpStyle: "bulge" as const, warpBend: 80 };
  const d = warpFontPath(
    [
      { command: "moveTo", args: [0, 0] },
      { command: "bezierCurveTo", args: [30, 50, 70, -50, 100, 0] },
    ],
    0,
    20,
    1,
    false,
    box,
    style,
  );
  const points = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
  const distance = (
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000,
      u = 1 - t;
    const p = warpPoint(
      90 * u * u * t + 210 * u * t * t + 100 * t * t * t,
      20 - (150 * u * u * t - 150 * u * t * t),
      box,
      style,
    );
    const error = Math.min(
      ...points.slice(1).map((b, j) => distance(p, points[j], b)),
    );
    assert.ok(error < 0.12, "outline error " + error);
  }
});
