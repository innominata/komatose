import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  breakRuns,
  currentBreaks,
  normalizeBreaks,
  oversizedSlices,
  runSlices,
  sliceOutputs,
  type StripPage,
} from "../src/lib/stripBreaks";
process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "komatose-strip-breaks-"));
process.env.SCAN_DATA_DIR = join(process.env.SCAN_ROOT, "data");
process.env.DATABASE_URL = join(process.env.SCAN_DATA_DIR, "test.db");
const { sqlite } = await import("../src/lib/server/db");
const { putDoc, storeAsset, getDoc } = await import("../src/lib/server/workflowStore");
const { getSeries, getEpisode, listImages, listLines } = await import("../src/lib/server/queries");
const { saveImageFile } = await import("../src/lib/server/storage");
const { stitchImages, bandsFromBytes, protectBands } = await import("../src/lib/server/reslice");
const { stripLayout, planStripBreaks, applyStripBreaks } = await import("../src/lib/server/stripBreaks");
const { undoPageOp } = await import("../src/lib/server/pageEdit");

const pages = (heights: number[], widths = heights.map(() => 100)): StripPage[] => {
  let top = 0;
  return heights.map((height, i) => {
    const p = { id: `p${i}`, top, width: widths[i], height };
    top += height;
    return p;
  });
};

test("unchanged breaks touch no pages", () => {
  const p = pages([400, 400, 400]);
  assert.deepEqual(breakRuns(p, currentBreaks(p)), []);
});

test("a moved break reframes the two pages either side and keeps both ids", () => {
  const p = pages([400, 400, 400]);
  const breaks = [350, 800];
  assert.deepEqual(breakRuns(p, breaks), [{ start: 0, end: 1 }]);
  const slices = runSlices(p, { start: 0, end: 1 }, breaks);
  assert.deepEqual(slices, [{ top: 0, bottom: 350 }, { top: 350, bottom: 800 }]);
  let n = 0;
  const out = sliceOutputs(p.slice(0, 2).map((s) => ({ ...s, name: s.id })), slices, { newId: () => `new${++n}`, reuseIds: true });
  assert.deepEqual(out.map((o) => [o.id, o.height]), [["p0", 350], ["p1", 450]]);
  assert.deepEqual(out[1].placements.map((pl) => [pl.imageId, pl.rect.y, pl.rect.height, pl.y]),
    [["p0", 350, 50, 0], ["p1", 0, 400, 50]]);
});

test("added and removed breaks and separate runs", () => {
  const p = pages([400, 400, 400, 400, 400]);
  // Split page 0 at 200, join pages 3 and 4 by dropping 1600.
  const breaks = [200, 400, 800, 1200];
  assert.deepEqual(breakRuns(p, breaks), [{ start: 0, end: 0 }, { start: 3, end: 4 }]);
  let n = 0;
  const split = sliceOutputs([{ ...p[0], name: "a" }], runSlices(p, { start: 0, end: 0 }, breaks), { newId: () => `new${++n}`, reuseIds: true });
  assert.deepEqual(split.map((o) => o.id), ["p0", "new1"]);
  assert.equal(split[1].originalName, "a-2.png");
  const joined = sliceOutputs(p.slice(3).map((s) => ({ ...s, name: s.id })), runSlices(p, { start: 3, end: 4 }, breaks), { newId: () => "x", reuseIds: true });
  assert.deepEqual(joined.map((o) => [o.id, o.height, o.placements.length]), [["p3", 800, 2]]);
});

test("outputs centre narrower pages inside the widest part", () => {
  const p = pages([100, 100], [80, 100]);
  const out = sliceOutputs(p.map((s) => ({ ...s, name: s.id })), [{ top: 50, bottom: 150 }], { newId: () => "n", reuseIds: true });
  assert.equal(out[0].width, 100);
  assert.deepEqual(out[0].placements.map((pl) => pl.x), [10, 0]);
});

test("break helpers", () => {
  assert.deepEqual(normalizeBreaks([5, 0, 5.2, 900, 100, -3], 800), [5, 100]);
  assert.deepEqual(oversizedSlices(1000, [300], 600), [{ top: 300, bottom: 1000 }]);
});

// --- Server: layout and applying breaks on a real chapter ---
sqlite.exec(`INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','u','x','admin',1);
  INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1);`);
const user = { id: "u", username: "u", role: "admin" } as any, series = (await getSeries("s"))!;
putDoc(null, "series:s", { direction: "ltr" }, 0);
let counter = 0;
/** Pages of artwork with white gutters at the given rows (page coordinates). */
async function seed(specs: { width: number; height: number; gutters: [number, number][] }[]) {
  const id = `e${++counter}`;
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,'s',?,?,1,1)").run(id, id, id);
  const episode = (await getEpisode(id))!, ctx = { series, episode, user };
  for (const [i, spec] of specs.entries()) {
    const { width, height } = spec, data = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const white = spec.gutters.some(([a, b]) => y >= a && y < b);
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 3;
        const v = white ? 255 : (x * 7 + y * 3 + i * 40) % 200;
        data[at] = v; data[at + 1] = white ? 255 : (v + 50) % 256; data[at + 2] = white ? 255 : (v * 3) % 256;
      }
    }
    const png = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const imageId = `${id}-p${i}`;
    const file = await saveImageFile({ seriesSlug: "s", episodeSlug: id, sortOrder: i, originalName: `${imageId}.png`, bytes: png, mime: "image/png" });
    sqlite.prepare(`INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number) VALUES(?,?,?,?,?,?,?,1,1,?)`)
      .run(imageId, id, file.filename, `${imageId}.png`, i, width, height, i + 1);
    putDoc(id, `page:${imageId}`, { prepared: await storeAsset(png), original: await storeAsset(png), preparedAt: 1 }, 0);
  }
  return { ctx, images: await listImages(id) };
}
function addRegion(ctx: any, imageId: string, y: number, h: number) {
  const id = `${imageId}-r`;
  sqlite.prepare(`INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,?,'English','plain','approved',1,.2,?,.2,?,0,1,'u','原文','read')`).run(id, ctx.episode.id, imageId, y, h);
  putDoc(ctx.episode.id, `region:${id}`, { polygon: [{ x: .2, y }, { x: .4, y }, { x: .4, y: y + h }, { x: .2, y: y + h }], locked: true }, 0);
  return id;
}

test("layout bands match the stitched strip, across page joins and narrower pages", async () => {
  const f = await seed([
    { width: 120, height: 300, gutters: [[100, 140], [280, 300]] },
    { width: 100, height: 300, gutters: [[0, 30], [200, 260]] },
    { width: 120, height: 200, gutters: [[50, 90]] },
  ]);
  const layout = await stripLayout(f.ctx, { sizing: "custom", maxHeight: 300 });
  const stitch = await stitchImages(f.ctx, f.images);
  const expected = protectBands((await bandsFromBytes(stitch.bytes)).bands, []);
  assert.deepEqual(layout.bands, expected);
  assert.ok(layout.bands.some((b) => b.top === 280 && b.bottom === 330), "white gutter joins across the page boundary");
  assert.deepEqual(layout.pages.map((p) => p.top), [0, 300, 600]);
  assert.equal(layout.width, 120);
  assert.ok(layout.autoCuts.length >= 2);
});

test("applying breaks keeps work, reuses ids, leaves other pages alone, and undoes", async () => {
  const f = await seed([
    { width: 100, height: 400, gutters: [[300, 340]] },
    { width: 100, height: 400, gutters: [] },
    { width: 100, height: 400, gutters: [] },
    { width: 100, height: 400, gutters: [[100, 140]] },
  ]);
  const regionId = addRegion(f.ctx, f.images[1].id, 0.25, 0.1); // strip rows 500..540
  const before = await listImages(f.ctx.episode.id);
  const layout = await stripLayout(f.ctx);
  assert.ok(layout.protected.some((r) => r.id === regionId && r.top <= 500 && r.bottom >= 540));
  await assert.rejects(planStripBreaks(f.ctx, [400, 520, 800, 1200], layout.revisionToken), /crosses an existing region/);
  await assert.rejects(planStripBreaks(f.ctx, [400, 800, 1200], "stale"), /changed since/);
  // Move the 0|1 break up into page 0's gutter, and split page 3 at its gutter.
  const plan = await planStripBreaks(f.ctx, [320, 800, 1200, 1320], layout.revisionToken);
  assert.equal(plan.runs.length, 2);
  await applyStripBreaks(f.ctx, plan);
  const after = await listImages(f.ctx.episode.id);
  assert.deepEqual(after.map((i) => i.height), [320, 480, 400, 120, 280]);
  assert.deepEqual(after.slice(0, 4).map((i) => i.id), before.map((i) => i.id));
  assert.equal(after[2].updatedAt, before[2].updatedAt, "page outside every run is untouched");
  const line = (await listLines(f.ctx.episode.id)).find((l) => l.id === regionId)!;
  assert.equal(line.imageId, before[1].id);
  assert.ok(Math.abs(line.y! * 480 - (80 + 100)) < 1, "region moved down by the 80px taken from page 0");
  assert.ok(getDoc<{ locked?: boolean }>(`region:${regionId}`, {}).data.locked);
  // Two runs are two undo entries; both restore the original pages exactly.
  await undoPageOp(f.ctx);
  await undoPageOp(f.ctx);
  const restored = await listImages(f.ctx.episode.id);
  assert.deepEqual(restored.map((i) => [i.id, i.height]), before.map((i) => [i.id, i.height]));
  const back = (await listLines(f.ctx.episode.id)).find((l) => l.id === regionId)!;
  assert.ok(Math.abs(back.y! - 0.25) < 1e-6);
});
