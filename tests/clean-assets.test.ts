import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { PlacedAsset } from "../src/lib/cleanAssets";
import type { PageData } from "../src/lib/workflow";
process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "komatose-clean-assets-"));
process.env.SCAN_DATA_DIR = join(process.env.SCAN_ROOT, "data");
process.env.DATABASE_URL = join(process.env.SCAN_DATA_DIR, "scan.db");
const { sqlite } = await import("../src/lib/server/db");
const { getDoc, putDoc, storeAsset, readAsset, hash } =
  await import("../src/lib/server/workflowStore");
const { saveImageFile } = await import("../src/lib/server/storage");
const { getSeries, getEpisode, listImages } =
  await import("../src/lib/server/queries");
const {
  saveCleanAsset,
  deleteCleanAsset,
  cleanAssetLibrary,
  compositePageAssets,
  validatePlacements,
} = await import("../src/lib/server/cleanAssets");
const { previewBoundary, moveBoundary } =
  await import("../src/lib/server/pageBoundary");
const { undoPageOp, cropPage } = await import("../src/lib/server/pageEdit");
const { pagePng, renderPage } =
  await import("../src/lib/server/finishedExport");
sqlite.exec(
  "INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','u','x','admin',1); INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1)",
);
const red = await sharp({
  create: {
    width: 20,
    height: 40,
    channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 0.5 },
  },
})
  .png()
  .toBuffer();
let n = 0;
async function seed() {
  const id = `e${++n}`;
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,'s',?,?,1,1)",
    )
    .run(id, id, id);
  for (let i = 0; i < 2; i++) {
    const bytes = await sharp({
        create: { width: 100, height: 400, channels: 3, background: "#fff" },
      })
        .png()
        .toBuffer(),
      asset = await storeAsset(bytes);
    const f = await saveImageFile({
      seriesSlug: "s",
      episodeSlug: id,
      sortOrder: i,
      originalName: `p${i}.png`,
      bytes,
      mime: "image/png",
    });
    sqlite
      .prepare(
        "INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at) VALUES(?,?,?,?,?,100,400,1,1)",
      )
      .run(`${id}-p${i}`, id, f.filename, `p${i}.png`, i);
    putDoc(
      id,
      `page:${id}-p${i}`,
      {
        prepared: asset,
        original: asset,
        preparedAt: 1,
        thumbnail: asset,
        thumbnailAt: 1,
      },
      0,
    );
  }
  return {
    series: (await getSeries("s"))!,
    episode: (await getEpisode(id))!,
    user: { id: "u", username: "u", role: "admin" } as any,
  };
}
function placement(asset: any, extra: Partial<PlacedAsset> = {}): PlacedAsset {
  return {
    ...asset,
    id: `placed-${n}`,
    assetId: asset.id,
    x: 50,
    y: 300,
    rotation: 0,
    opacity: 1,
    ...extra,
  };
}
async function raw(bytes: Buffer) {
  return sharp(bytes).ensureAlpha().raw().toBuffer();
}
test("series asset uploads preserve alpha; replacement/deletion keep independent placements and reject stale writes", async () => {
  const ctx = await seed(),
    initial = cleanAssetLibrary("s");
  const added = await saveCleanAsset("s", "Title.png", red, initial.revision),
    asset = added.assets[0];
  assert.equal(
    (await sharp(await readAsset(asset.hash)).metadata()).hasAlpha,
    true,
  );
  const g = placement(asset),
    page = getDoc<PageData>(`page:${ctx.episode.id}-p0`, {});
  putDoc(
    ctx.episode.id,
    page.id,
    { ...page.data, placedAssets: [g] },
    page.revision,
  );
  const blue = await sharp({
    create: { width: 30, height: 20, channels: 3, background: "blue" },
  })
    .png()
    .toBuffer();
  const replaced = await saveCleanAsset(
    "s",
    "New title.png",
    blue,
    added.revision,
    asset.id,
  );
  assert.equal(replaced.assets[0].id, asset.id);
  assert.notEqual(replaced.assets[0].hash, asset.hash);
  await assert.rejects(
    saveCleanAsset("s", "Stale.png", red, added.revision),
    /changed|conflict/i,
  );
  deleteCleanAsset("s", asset.id, replaced.revision);
  const saved = getDoc<PageData>(page.id, {}).data;
  assert.equal(saved.placedAssets![0].hash, asset.hash);
  const composed = await raw(
    await compositePageAssets(await readAsset(saved.prepared!), saved),
  );
  const pixel = (300 * 100 + 50) * 4;
  assert.equal(composed[pixel], 255);
  assert.ok(composed[pixel + 1] > 120 && composed[pixel + 1] < 140);
  await assert.rejects(
    saveCleanAsset(
      "s",
      "Not PNG.jpg",
      await sharp(red).jpeg().toBuffer(),
      cleanAssetLibrary("s").revision,
    ),
    /PNG/,
  );
});
test("clean PNG and normal exports include graphics once, and transform edits remain undoable", async () => {
  const ctx = await seed(),
    image = (await listImages(ctx.episode.id))[0];
  const asset = (
    await saveCleanAsset("s", "Title.png", red, cleanAssetLibrary("s").revision)
  ).assets[0];
  const original = getDoc<PageData>(`page:${image.id}`, {}),
    g = placement(asset, { y: 100 });
  const doc = putDoc(
    ctx.episode.id,
    original.id,
    { ...original.data, placedAssets: [g] },
    original.revision,
  );
  const expected = await raw(
    await compositePageAssets(await readAsset(doc.data.prepared!), doc.data),
  );
  const png = await pagePng(ctx.series, ctx.episode, image.id, "clean");
  assert.equal(hash(await raw(png.bytes)), hash(expected));
  const rendered = await renderPage({
    image,
    source: doc.data,
    sourceRevision: doc.revision,
    dpi: 72,
    regions: [],
  });
  assert.equal(hash(await raw(rendered.composite)), hash(expected));
  putDoc(
    ctx.episode.id,
    doc.id,
    {
      ...doc.data,
      placedAssets: [{ ...g, rotation: 35, width: 40, height: 80 }],
    },
    doc.revision,
  );
  const latest = getDoc<PageData>(doc.id, {});
  putDoc(ctx.episode.id, doc.id, latest.data, latest.revision, "undo");
  assert.deepEqual(getDoc<PageData>(doc.id, {}).data.placedAssets, [g]);
  assert.throws(() => validatePlacements([{ ...g, width: -1 }]), /Invalid/);
});
test("a boundary cut through a graphic transfers its visible pixels losslessly and structural undo restores the editable original", async () => {
  const ctx = await seed(),
    [a, b] = await listImages(ctx.episode.id);
  const asset = cleanAssetLibrary("s").assets[0],
    g = placement(asset),
    doc = getDoc<PageData>(`page:${a.id}`, {});
  putDoc(
    ctx.episode.id,
    doc.id,
    { ...doc.data, placedAssets: [g] },
    doc.revision,
  );
  const before = await compositePageAssets(
    await readAsset(doc.data.prepared!),
    { placedAssets: [g] },
  );
  const preview = await previewBoundary(ctx, a.id, 300);
  await moveBoundary(ctx, a.id, 300, preview.revisionToken);
  const left = getDoc<PageData>(`page:${a.id}`, {}).data,
    right = getDoc<PageData>(`page:${b.id}`, {}).data;
  assert.equal(left.placedAssets!.length, 1);
  assert.equal(right.placedAssets!.length, 1);
  const leftImage = await compositePageAssets(
      await readAsset(left.prepared!),
      left,
    ),
    rightImage = await compositePageAssets(
      await readAsset(right.prepared!),
      right,
    );
  const pixels = Buffer.concat([
    await raw(leftImage),
    await raw(
      await sharp(rightImage)
        .extract({ left: 0, top: 0, width: 100, height: 100 })
        .png()
        .toBuffer(),
    ),
  ]);
  assert.equal(hash(pixels), hash(await raw(before)));
  await undoPageOp(ctx);
  assert.deepEqual(getDoc<PageData>(doc.id, {}).data.placedAssets, [g]);
  await cropPage(ctx, a.id, { x: 10, y: 0, w: 80, h: 400 });
  assert.equal(getDoc<PageData>(doc.id, {}).data.placedAssets![0].x, 40);
});

test("series backups include the reusable library and hashes used by placed graphics", async () => {
  const ctx = await seed();
  const { createSeriesBackup, seriesBackupArchivePath, restoreSeriesBackup } =
    await import("../src/lib/server/seriesBackups");
  const { readFile } = await import("node:fs/promises");
  const JSZip = (await import("jszip")).default;
  const library = cleanAssetLibrary("s"),
    asset = library.assets[0],
    page = getDoc<PageData>(`page:${ctx.episode.id}-p0`, {});
  putDoc(
    ctx.episode.id,
    page.id,
    { ...page.data, placedAssets: [placement(asset)] },
    page.revision,
  );
  const backup = await createSeriesBackup("s", ctx.user, "Graphic library");
  const zip = await JSZip.loadAsync(
    await readFile(seriesBackupArchivePath(backup.id)),
  );
  assert.ok(zip.file(`assets/${asset.hash}`));
  deleteCleanAsset("s", asset.id, library.revision);
  await restoreSeriesBackup(backup.id, ctx.user);
  assert.deepEqual(cleanAssetLibrary("s").assets, library.assets);
  assert.equal(
    getDoc<PageData>(page.id, {}).data.placedAssets![0].hash,
    asset.hash,
  );
});

test("older graphic placement undo and redo stay linked after a boundary splits the graphic", async () => {
  const ctx = await seed(),
    [a, b] = await listImages(ctx.episode.id),
    asset = cleanAssetLibrary("s").assets[0];
  const doc = getDoc<PageData>(`page:${a.id}`, {});
  putDoc(
    ctx.episode.id,
    doc.id,
    { ...doc.data, placedAssets: [placement(asset, { rotation: 25 })] },
    doc.revision,
  );
  const preview = await previewBoundary(ctx, a.id, 300);
  await moveBoundary(ctx, a.id, 300, preview.revisionToken);
  const current = getDoc<PageData>(doc.id, {});
  putDoc(ctx.episode.id, doc.id, current.data, current.revision, "undo");
  assert.equal(
    getDoc<PageData>(`page:${a.id}`, {}).data.placedAssets?.length ?? 0,
    0,
  );
  assert.equal(
    getDoc<PageData>(`page:${b.id}`, {}).data.placedAssets?.length ?? 0,
    0,
  );
  const undone = getDoc<PageData>(doc.id, {});
  putDoc(ctx.episode.id, doc.id, undone.data, undone.revision, "redo");
  assert.equal(
    getDoc<PageData>(`page:${a.id}`, {}).data.placedAssets?.length,
    1,
  );
  assert.equal(
    getDoc<PageData>(`page:${b.id}`, {}).data.placedAssets?.length,
    1,
  );
});

test('adding asset support preserves existing completion stamps on pages without graphics',async()=>{
  const {pageStepStamp}=await import('../src/lib/workflow');
  const page:PageData={prepared:'raw',cleaned:'art',maskApproved:true,cleanApproved:true};
  const legacy=['raw','','art','','','1','1'].join('\t');
  assert.equal(pageStepStamp('clean',page,[],[],[]),legacy);
  assert.equal(pageStepStamp('clean',{...page,placedAssets:[]},[],[],[]),legacy);
});
