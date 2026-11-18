import { test, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = await mkdtemp("/tmp/scan-censor-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "scan.db");

const { censorDocId, censorPixelBoxes, validateCensorRects } = await import("../src/lib/censor");
const { applyCensors, projectCensors, transformCensors } = await import("../src/lib/server/censor");
const { db, sqlite } = await import("../src/lib/server/db");
const { series, episodes, images } = await import("../src/lib/server/db/schema");
const { putDoc, storeAsset } = await import("../src/lib/server/workflowStore");
const { toSeries, toEpisode } = await import("../src/lib/server/queries");
const { createJob, listJobs, updateJob } = await import("../src/lib/server/jobs");
const { pruneExportJobs } = await import("../src/lib/server/exportRetention");
const { capturePageImages } = await import("../src/lib/server/pageImages");
const { renderPage } = await import("../src/lib/server/finishedExport");

after(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

const white = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#ffffff" } }).png().toBuffer();
async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [...data.subarray(i, i + 3)];
}

test("validation clamps boxes to the page and rejects malformed ones", () => {
  const [clamped] = validateCensorRects([{ id: "a", x: -0.1, y: 0.5, w: 0.3, h: 0.8 }]);
  assert.equal(clamped.x, 0);
  assert.ok(Math.abs(clamped.w - 0.2) < 1e-9 && Math.abs(clamped.h - 0.5) < 1e-9);
  assert.deepEqual(validateCensorRects([{ id: "gone", x: 1.2, y: 0, w: 0.1, h: 0.1 }]), []);
  assert.throws(() => validateCensorRects([{ id: "a", x: 0, y: 0, w: "1", h: 1 }]));
  assert.throws(() => validateCensorRects([{ id: "a", x: 0, y: 0, w: 1, h: 1 }, { id: "a", x: 0, y: 0, w: 1, h: 1 }]));
  assert.throws(() => validateCensorRects("nope"));
});

test("pixel boxes cover every touched pixel", () => {
  assert.deepEqual(censorPixelBoxes([{ id: "a", x: 0.105, y: 0.2, w: 0.1, h: 0.05 }], 100, 100), [{ left: 10, top: 20, width: 11, height: 5 }]);
});

test("applyCensors paints black inside the box only", async () => {
  const out = await applyCensors(await white(100, 50), [{ id: "a", x: 0.2, y: 0.2, w: 0.2, h: 0.4 }]);
  assert.deepEqual(await pixel(out, 25, 15), [0, 0, 0]);
  assert.deepEqual(await pixel(out, 10, 10), [255, 255, 255]);
  assert.deepEqual(await pixel(out, 45, 15), [255, 255, 255]);
});

test("geometry edits move and clip boxes", () => {
  // Crop away the left 50 px of a 200×100 page: a box at x 40–80 becomes 0–30 of 150.
  const [moved] = transformCensors([{ id: "a", x: 0.2, y: 0.1, w: 0.2, h: 0.2 }], { width: 200, height: 100 },
    { sx: 1, sy: 1, dx: -50, dy: 0, width: 150, height: 100 });
  assert.equal(moved.id, "a");
  assert.ok(Math.abs(moved.x) < 1e-9 && Math.abs(moved.w - 30 / 150) < 1e-9 && Math.abs(moved.y - 0.1) < 1e-9);
  assert.deepEqual(transformCensors([{ id: "a", x: 0, y: 0, w: 0.1, h: 0.1 }], { width: 200, height: 100 },
    { sx: 1, sy: 1, dx: -50, dy: 0, width: 150, height: 100 }), []);
});

test("a merged page keeps each source's boxes in place", () => {
  // Two 100×100 pages stacked into one 100×200 page.
  const rects = projectCensors(
    { width: 100, height: 200, placements: [
      { imageId: "top", rect: { x: 0, y: 0, width: 100, height: 100 }, x: 0, y: 0 },
      { imageId: "bottom", rect: { x: 0, y: 0, width: 100, height: 100 }, x: 0, y: 100 },
    ] },
    [
      { id: "top", width: 100, height: 100, rects: [] },
      { id: "bottom", width: 100, height: 100, rects: [{ id: "b", x: 0.1, y: 0.5, w: 0.2, h: 0.2 }] },
    ]);
  assert.equal(rects.length, 1);
  assert.ok(Math.abs(rects[0].y - 150 / 200) < 1e-9 && Math.abs(rects[0].h - 20 / 200) < 1e-9 && Math.abs(rects[0].x - 0.1) < 1e-9);
});

test("proofreader captures and censored renders black out the boxes", async () => {
  db.insert(series).values({ id: "series", slug: "series", title: "Series", createdAt: 1, updatedAt: 1 }).run();
  db.insert(episodes).values({ id: "chapter", seriesId: "series", slug: "chapter", title: "1", status: "raws", createdAt: 1, updatedAt: 1 }).run();
  db.insert(images).values({ id: "p1", episodeId: "chapter", filename: "p.png", originalName: "p.png", width: 80, height: 40, sortOrder: 0, createdAt: 1, updatedAt: 1 }).run();
  const prepared = await storeAsset(await white(80, 40));
  putDoc("chapter", "page:p1", { prepared, original: prepared, preparedAt: 1 }, 0);
  const s = toSeries(db.select().from(series).get()!), e = toEpisode(db.select().from(episodes).get()!);

  const before = await capturePageImages(s, e, "p1");
  assert.deepEqual(await pixel(before.raw, 10, 10), [255, 255, 255]);

  putDoc("chapter", censorDocId("p1"), { rects: [{ id: "a", x: 0, y: 0, w: 0.5, h: 0.5 }] }, 0);
  const after = await capturePageImages(s, e, "p1");
  assert.deepEqual(await pixel(after.raw, 10, 10), [0, 0, 0]);
  assert.deepEqual(await pixel(after.typeset!, 10, 10), [0, 0, 0]);
  assert.deepEqual(await pixel(after.raw, 60, 30), [255, 255, 255]);

  const page = { ...after.page, censors: [{ id: "a", x: 0, y: 0, w: 0.5, h: 0.5 }] };
  assert.deepEqual(await pixel((await renderPage(page)).composite, 10, 10), [0, 0, 0]);
  assert.deepEqual(await pixel((await renderPage(after.page)).composite, 10, 10), [255, 255, 255]);
});

test("pruning keeps the newest censored and uncensored zips", () => {
  const full = createJob("chapter", "export", { format: "png", draft: false, quality: 95, includeMetadata: false, censored: false });
  updateJob(full, "completed", { artifact: "", filename: "full.zip" });
  const censored = createJob("chapter", "export", { format: "png", draft: false, quality: 95, includeMetadata: false, censored: true });
  updateJob(censored, "completed", { artifact: "", filename: "censored.zip" });
  pruneExportJobs(sqlite, { episodeId: "chapter", keepJobId: censored });
  assert.deepEqual(listJobs("chapter").filter((j) => j.kind === "export").map((j) => j.id).sort(), [full, censored].sort());
  const newer = createJob("chapter", "export", { format: "png", draft: false, quality: 95, includeMetadata: false, censored: true });
  updateJob(newer, "completed", { artifact: "", filename: "censored.zip" });
  pruneExportJobs(sqlite, { episodeId: "chapter", keepJobId: newer });
  assert.deepEqual(listJobs("chapter").filter((j) => j.kind === "export").map((j) => j.id).sort(), [full, newer].sort());
});
