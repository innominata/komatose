import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStyle, DEFAULT_STYLE } from "../src/lib/workflow";
import {
  hasTextWarp,
  layoutWarpBox,
  psdTextWarp,
  glyphToPage,
  textWarpMap,
  warpFontPath,
  warpPad,
  warpPoint,
} from "../src/lib/textWarp";
import { TEXT_WARP_STYLES } from "../src/lib/workflow";
import { applyCharStyle, commonCharStyle, normalizeCharRuns, remapCharRuns } from "../src/lib/charStyles";
import { pathFrame } from "../src/lib/textPath";

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
  // As in Photoshop, the corners stay put and the bottom edge bows in the middle.
  const top = warpPoint(50, 0, box, style);
  const bottom = warpPoint(50, 40, box, style);
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
    glyphToPage(0, 20, 1, false),
    textWarpMap(box, style)!,
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
    glyphToPage(50, 20, 0.02, false),
    textWarpMap(box, { warpStyle: "arc", warpBend: 40 })!,
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
    glyphToPage(0, 20, 1, false),
    textWarpMap(box, style)!,
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

test("every Photoshop warp style bends smoothly and is the identity at zero", () => {
  assert.equal(TEXT_WARP_STYLES.length, 16);
  for (const warpStyle of TEXT_WARP_STYLES.slice(1)) {
    assert.equal(textWarpMap(box, { warpStyle, warpBend: 0 }), undefined, warpStyle);
    const strong = warpPoint(30, 10, box, { warpStyle, warpBend: 60 });
    assert.ok(Number.isFinite(strong.x) && Number.isFinite(strong.y), warpStyle);
    const tiny = warpPoint(30, 10, box, { warpStyle, warpBend: 0.5 });
    assert.ok(Math.abs(tiny.x - 30) < 2 && Math.abs(tiny.y - 10) < 2, warpStyle);
  }
});

test("warp distortion alone still warps, and PSD keeps it", () => {
  const style = { ...DEFAULT_STYLE, warpStyle: "flag" as const, warpBend: 0, warpHorizontal: 40 };
  assert.equal(hasTextWarp(style), true);
  assert.equal(psdTextWarp(style)!.perspective, 40);
  const corner = warpPoint(100, 0, box, style);
  assert.notDeepEqual(corner, { x: 100, y: 0 });
});

test("vertical orientation bends down the text instead of across it", () => {
  const across = warpPoint(50, 0, box, { warpStyle: "arch", warpBend: 50 });
  const down = warpPoint(50, 0, box, { warpStyle: "arch", warpBend: 50, warpOrientation: "vertical" });
  assert.ok(Math.abs(across.y) > 1);
  assert.ok(Math.abs(down.x - 50) > Math.abs(down.y) || Math.abs(down.y) < Math.abs(across.y));
});

test("character runs apply, merge, clear and follow edits", () => {
  let runs = applyCharStyle([], 11, 0, 5, { fill: "#FF0000" });
  runs = applyCharStyle(runs, 11, 5, 11, { fill: "#ff0000" });
  assert.deepEqual(runs, [{ start: 0, end: 11, style: { fill: "#ff0000" } }]);
  runs = applyCharStyle(runs, 11, 3, 6, { fill: undefined, size: 150 });
  assert.deepEqual(commonCharStyle(runs, 11, 3, 6), { size: 150 });
  // "hello world" → "hello big world": typed text takes the style before it.
  const moved = remapCharRuns(runs, "hello world", "hello big world");
  assert.deepEqual(commonCharStyle(moved, 15, 10, 15), { fill: "#ff0000" });
  assert.deepEqual(commonCharStyle(moved, 15, 4, 5), { size: 150 });
  assert.deepEqual(normalizeCharRuns([{ start: 0, end: 4, style: { size: "huge" } }], 4), []);
});

test("a text path measures its length and places glyphs along the tangent", () => {
  const frame = pathFrame([{ x: 0, y: 0 }, { x: 100, y: 0 }])!;
  assert.equal(Math.round(frame.length), 100);
  const [a, b, , , e, f] = frame.frame(25)!;
  assert.deepEqual([a, b, e, f].map((n) => Math.round(n)), [1, 0, 25, 0]);
  assert.equal(frame.frame(120), undefined);
  const flipped = pathFrame([{ x: 0, y: 0 }, { x: 100, y: 0 }], true)!;
  assert.equal(Math.round(flipped.frame(25)![0]), -1);
});

test("EngineData round-trips Photoshop's Txt2 block byte for byte", async () => {
  const { PATH_TEXT_TXT2 } = await import("../src/lib/server/psdTemplates/pathText");
  const { parseEngineData, serializeEngineData, formatReal } = await import("../src/lib/server/engineData");
  const bytes = Buffer.from(PATH_TEXT_TXT2, "base64");
  assert.ok(Buffer.from(serializeEngineData(parseEngineData(bytes))).equals(bytes));
  assert.deepEqual([1, 0.5, -0.5, -52.122463, 0].map(formatReal), ["1.0", ".5", "-.5", "-52.12246", "0.0"]);
});

test("text path Beziers follow the layout curve and trim from the start", async () => {
  const { textPathBeziers, trimBeziers } = await import("../src/lib/textPath");
  const line = textPathBeziers([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
  const trimmed = trimBeziers(line, 25);
  assert.ok(Math.abs(trimmed[0][0].x - 25) < 0.5);
  assert.equal(trimmed[0][3].x, 100);
  const curve = textPathBeziers([{ x: 0, y: 0 }, { x: 50, y: -30 }, { x: 100, y: 0 }]);
  assert.equal(curve.length, 2);
  assert.deepEqual(curve[0][3], { x: 50, y: -30 });
});

test("layer styles validate, round-trip through Photoshop's effects, and build filters", async () => {
  const { EFFECT_DEFAULTS, EFFECT_ORDER, effectFilters, effectsFromPsd, effectsReach, normalizeEffects, psdEffects } = await import("../src/lib/textEffects");
  const all = Object.fromEntries(EFFECT_ORDER.map((k) => [k, EFFECT_DEFAULTS[k]]));
  const norm = normalizeEffects(all)!;
  assert.deepEqual(Object.keys(norm).sort(), [...EFFECT_ORDER].sort());
  assert.equal(normalizeEffects({ dropShadow: { opacity: 500, color: "red" } })!.dropShadow!.opacity, 100);
  assert.equal(normalizeEffects({ wobble: {} }), undefined);
  // 300 dpi: points ↔ pixels both ways.
  const back = effectsFromPsd(psdEffects(norm, 300) as Record<string, unknown>, 300)!;
  for (const k of EFFECT_ORDER) assert.deepEqual(back[k], norm[k], k);
  assert.ok(Math.abs((psdEffects(norm, 300).dropShadow as { distance: { value: number } }[])[0].distance.value - (4 * 300) / 72) < 0.01);
  assert.ok(effectsReach(norm) >= 4 + 4);
  const fx = effectFilters(norm, 1, { x: 0, y: 0, width: 100, height: 50 }, { x: 10, y: 10, width: 80, height: 30 });
  assert.ok(fx.exterior && fx.interior && fx.overlay);
  assert.match(fx.defs, /<filter id="fx-ext"/);
  assert.match(fx.defs, /feDiffuseLighting/);
  assert.equal(effectFilters({ dropShadow: { ...EFFECT_DEFAULTS.dropShadow, enabled: false } }, 1, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }).defs, "");
});

test("throttle runs at once, then at most once per window with the latest value", async () => {
  const { throttle } = await import("../src/lib/throttle");
  const seen: number[] = [];
  const t = throttle((v: number) => seen.push(v), 50);
  t(1); t(2); t(3);
  assert.deepEqual(seen, [1]);
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(seen, [1, 3], "one trailing call with the newest value");
  t(4); t(5);
  t.cancel();
  await new Promise((r) => setTimeout(r, 70));
  // Still inside the window after the trailing call, so 4 and 5 wait; cancel drops them.
  assert.deepEqual(seen, [1, 3], "cancel drops the pending call");
  t(6); t.flush();
  assert.deepEqual(seen, [1, 3, 6], "flush runs the pending call now");
});
