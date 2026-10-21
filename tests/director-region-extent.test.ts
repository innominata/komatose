import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";

process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "scan-region-extent-"));
process.env.DATABASE_URL = join(process.env.SCAN_ROOT, "data/test.db");

const { extendClippedRegions, relocateEmptyRegions, letteringInBox } = await import("../src/lib/server/directorAutomation");
const { getDoc, putDoc, storeAsset } = await import("../src/lib/server/workflowStore");
const save = (id: string, data: unknown) => putDoc(null, id, data, getDoc(id, {}).revision);

const SIZE = 1000;
/** A detector mask: white rectangles, in pixels, on a black page. */
async function maskAsset(rects: [number, number, number, number][]) {
  const body = rects.map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`).join("");
  const png = await sharp(Buffer.from(`<svg width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="black"/>${body}</svg>`)).png().toBuffer();
  return storeAsset(png);
}

const line = (id: string, x: number, y: number, w: number, h: number) =>
  ({ id, imageId: "page", x, y, w, h, sourceState: "accepted" }) as any;

test("a region boxed around one glyph of a spaced SFX is refit to the whole SFX, and a covered caption is left alone", async () => {
  // Four glyphs 15px apart (closer than the 2% link), and a caption column fully inside its region.
  const sfx: [number, number, number, number][] = [0, 1, 2, 3].map((i) => [600 + i * 55, 700, 40, 40]);
  const caption: [number, number, number, number] = [100, 100, 60, 300];
  // A screentone-like speck field next to the caption: 1px dots that erosion must drop.
  const specks: [number, number, number, number][] = [];
  for (let y = 120; y < 300; y += 4) for (let x = 170; x < 260; x += 4) specks.push([x, y, 1, 1]);
  const mask = await maskAsset([...sfx, caption, ...specks]);
  save("page:page", { prepared: mask });
  const calls: any[] = [];
  const ctx: any = {
    run: { id: "run", policy: "{}" },
    signal: new AbortController().signal,
    imageOperation: async (payload: any) => {
      calls.push(payload);
      assert.equal(payload.cmd, "mask");
      assert.equal(payload.detect, true);
      return { artifact: mask };
    },
  };
  const lines = [line("sfx", 0.595, 0.695, 0.05, 0.05), line("caption", 0.09, 0.09, 0.08, 0.32)];
  const edits = await extendClippedRegions(ctx, "page", lines);
  assert.equal(calls.length, 2, "one detector window per region");
  assert.deepEqual(edits.map((edit) => edit.lineId), ["sfx"]);
  const [edit] = edits;
  assert.ok(Math.abs(edit.x - 0.59) < 0.005, `left edge ${edit.x}`);
  assert.ok(Math.abs(edit.x + edit.w - 0.815) < 0.005, `right edge ${edit.x + edit.w}`);
  assert.ok(Math.abs(edit.y - 0.69) < 0.005 && Math.abs(edit.y + edit.h - 0.75) < 0.005, "snapped to the glyph rows");
  assert.equal(edit.polygon.length, 4);
});

test("a region is never refit into another region, nor when it is locked", async () => {
  const sfx: [number, number, number, number][] = [0, 1, 2, 3].map((i) => [600 + i * 55, 700, 40, 40]);
  const mask = await maskAsset(sfx);
  save("page:page", { prepared: mask });
  const ctx: any = {
    run: { id: "run", policy: "{}" },
    signal: new AbortController().signal,
    imageOperation: async () => ({ artifact: mask }),
  };
  const neighbour = line("neighbour", 0.72, 0.69, 0.05, 0.06);
  assert.deepEqual(await extendClippedRegions(ctx, "page", [line("sfx", 0.595, 0.695, 0.05, 0.05), neighbour]), []);
  save("region:sfx", { locked: true });
  assert.deepEqual(await extendClippedRegions(ctx, "page", [line("sfx", 0.595, 0.695, 0.05, 0.05)]), []);
});

test("an empty region moves onto a column another region's box swallowed, and that region shrinks", async () => {
  // A title of two columns, and a separate author column split into two clusters by a gap.
  const title: [number, number, number, number][] = [[500, 300, 60, 400], [600, 300, 60, 400]];
  const author: [number, number, number, number][] = [[300, 320, 60, 150], [300, 490, 60, 200]];
  const mask = await maskAsset([...title, ...author]);
  save("page:page", { prepared: mask });
  const ctx: any = {
    run: { id: "run", policy: "{}" },
    episode: { id: "episode" },
    series: { id: "series" },
    signal: new AbortController().signal,
    imageOperation: async () => ({ artifact: mask }),
  };
  const lines = [
    { ...line("merged", 0.28, 0.29, 0.4, 0.42), source: "タイトル" },
    { ...line("false", 0.05, 0.6, 0.15, 0.15), source: "作者" },
    { ...line("english", 0.05, 0.1, 0.05, 0.01), source: "BLACK JACK" },
  ];
  const edits = await relocateEmptyRegions(ctx, "page", lines);
  const moved = edits.find((edit) => edit.lineId === "false")!;
  assert.ok(moved, "the empty region is moved");
  assert.ok(Math.abs(moved.x - 0.29) < 0.005 && Math.abs(moved.x + moved.w - 0.37) < 0.005, `author columns x ${moved.x}`);
  assert.ok(Math.abs(moved.y - 0.31) < 0.005 && Math.abs(moved.y + moved.h - 0.70) < 0.005, `both author clusters y ${moved.y}`);
  const shrunk = edits.find((edit) => edit.lineId === "merged")!;
  assert.ok(Math.abs(shrunk.x - 0.49) < 0.005, `title keeps only its columns, x ${shrunk.x}`);
  assert.equal(edits.some((edit) => edit.lineId === "english"), false, "English-only regions are never moved");
});


test("a proposed box around part of a sound effect grows to the whole effect; artwork running off the window stays clipped", async () => {
  // A 척-like effect: glyph strokes extending well past the proposed box, plus a long
  // artwork line that runs to the edge of the search window.
  const glyphs: [number, number, number, number][] = [[500, 500, 40, 80], [545, 470, 30, 140]];
  const artwork: [number, number, number, number] = [0, 640, 1000, 6];
  const mask = await maskAsset([...glyphs, artwork]);
  save("page:page", { prepared: mask });
  const ctx: any = {
    run: { id: "run", policy: "{}" },
    signal: new AbortController().signal,
    imageOperation: async () => ({ artifact: mask }),
  };
  const fit = (await letteringInBox(ctx, "page", { x: 0.51, y: 0.51, w: 0.04, h: 0.06 }))!;
  assert.ok(fit, "lettering is found");
  assert.ok(fit.x <= 0.5 && fit.y <= 0.47, `grew up and left: ${fit.x},${fit.y}`);
  assert.ok(fit.x + fit.w >= 0.575 && fit.y + fit.h >= 0.61, "grew to the tall stroke");
  assert.ok(fit.y + fit.h < 0.63, "never takes the artwork line below");
  assert.equal(await letteringInBox(ctx, "page", { x: 0.1, y: 0.1, w: 0.05, h: 0.05 }), null, "an empty box is rejected");
  // A box sitting on the artwork line keeps only what lies inside it.
  const line = (await letteringInBox(ctx, "page", { x: 0.2, y: 0.6, w: 0.1, h: 0.1 }))!;
  assert.ok(line.x >= 0.18 && line.x + line.w <= 0.32, `artwork clipped to the box: ${line.x}..${line.x + line.w}`);
});

test("refitting a region box keeps a fitted geometry polygon, and moves one that only copied the box", async () => {
  const sfx: [number, number, number, number][] = [0, 1, 2, 3].map((i) => [600 + i * 55, 700, 40, 40]);
  const mask = await maskAsset(sfx);
  save("page:page", { prepared: mask });
  const ctx: any = {
    run: { id: "run", policy: "{}" },
    signal: new AbortController().signal,
    imageOperation: async () => ({ artifact: mask }),
  };
  const box = { x: 0.595, y: 0.695, w: 0.05, h: 0.05 };
  const balloon = [{ x: 0.56, y: 0.66 }, { x: 0.86, y: 0.64 }, { x: 0.88, y: 0.8 }, { x: 0.58, y: 0.79 }, { x: 0.55, y: 0.72 }];
  save("region:shaped", { polygon: balloon });
  const [shaped] = await extendClippedRegions(ctx, "page", [line("shaped", box.x, box.y, box.w, box.h)]);
  assert.deepEqual(shaped.polygon, balloon, "the typesetting shape is not the lettering box");
  const copy = [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
  save("region:boxed", { polygon: copy });
  const [boxed] = await extendClippedRegions(ctx, "page", [line("boxed", box.x, box.y, box.w, box.h)]);
  assert.ok(Math.abs(Math.max(...boxed.polygon.map((p) => p.x)) - (boxed.x + boxed.w)) < 1e-9, "a copied box follows the refit");
});
