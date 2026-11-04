import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { PageData, RegionData } from "../src/lib/workflow";
process.env.SCAN_ROOT = await mkdtemp(join(tmpdir(), "komatose-reframe-"));
process.env.SCAN_DATA_DIR = join(process.env.SCAN_ROOT, "data");
process.env.DATABASE_URL = join(process.env.SCAN_DATA_DIR, "test.db");
const { sqlite } = await import("../src/lib/server/db");
const { getDoc, putDoc, storeAsset, readAsset } =
  await import("../src/lib/server/workflowStore");
const { hash } = await import("../src/lib/server/workflowStore");
const { getSeries, getEpisode, listImages, listLines } =
  await import("../src/lib/server/queries");
const { saveImageFile } = await import("../src/lib/server/storage");
const { previewBoundary, moveBoundary } =
  await import("../src/lib/server/pageBoundary");
const { executeReframe, captureReframe, storedDoc } =
  await import("../src/lib/server/pageReframe");
const { combineSpread, joinStrip, splitSpread, undoPageOp } =
  await import("../src/lib/server/pageEdit");
const { reslicePages } = await import("../src/lib/server/reslice");
const { createJob, updateJob, listJobs } =
  await import("../src/lib/server/jobs");
sqlite.exec(`INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','u','x','admin',1);
  INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1);`);
const user = { id: "u", username: "u", role: "admin" } as any,
  series = (await getSeries("s"))!;
putDoc(null, "series:s", { direction: "ltr" }, 0);
const keys = [
  "prepared",
  "original",
  "cleaned",
  "cleanBase",
  "previousArtwork",
  "mask",
] as const;
let counter = 0;
async function seed(widths = [100, 100], heights = [400, 400]) {
  const id = `e${++counter}`;
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,'s',?,?,1,1)",
    )
    .run(id, id, id);
  const episode = (await getEpisode(id))!,
    ctx = { series, episode, user };
  const saved: Record<string, Record<string, string>> = {};
  for (let i = 0; i < widths.length; i++) {
    const imageId = `${id}-p${i}`,
      width = widths[i],
      height = heights[i];
    const assets: Record<string, string> = {};
    for (const [k, key] of keys.entries()) {
      const data = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const at = (y * width + x) * 3;
          data[at] = (20 + i * 50 + k * 17) % 255;
          data[at + 1] = y % 251;
          data[at + 2] = x % 251;
        }
      assets[key] = await storeAsset(
        await sharp(data, { raw: { width, height, channels: 3 } })
          .png()
          .toBuffer(),
      );
    }
    const file = await saveImageFile({
      seriesSlug: "s",
      episodeSlug: id,
      sortOrder: i,
      originalName: `${imageId}.png`,
      bytes: await readAsset(assets.prepared),
      mime: "image/png",
    });
    sqlite
      .prepare(
        `INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number,dpi) VALUES(?,?,?,?,?,?,?,1,1,?,?)`,
      )
      .run(
        imageId,
        id,
        file.filename,
        `${imageId}.png`,
        i,
        width,
        height,
        i + 1,
        i ? 144 : 96,
      );
    putDoc(
      id,
      `page:${imageId}`,
      {
        ...assets,
        preparedAt: 1,
        maskApproved: true,
        cleanApproved: true,
        completed: { clean: "done", review: "done" },
      },
      0,
    );
    saved[imageId] = assets;
  }
  return { ctx, images: await listImages(id), saved };
}
async function region(ctx: any, imageId: string, y = 0.8, h = 0.05) {
  const id = `${imageId}-r`;
  sqlite
    .prepare(
      `INSERT INTO lines(id,episode_id,image_id,body,line_type,status,placed,x,y,w,h,sort_order,updated_at,updated_by,source,source_state)
    VALUES(?,?,?,'English','plain','approved',1,.2,?,.2,?,0,1,'u','原文','read')`,
    )
    .run(id, ctx.episode.id, imageId, y, h);
  const data = {
    polygon: [
      { x: 0.2, y },
      { x: 0.4, y },
      { x: 0.4, y: y + h },
      { x: 0.2, y: y + h },
    ],
    bubbleBounds: { x: 0.2, y, w: 0.2, h },
    locked: true,
    geometryApproved: true,
    style: { size: 12 },
    charRuns: [{ start: 0, end: 3, style: { weight: 700 } }],
    charRunsBody: "English",
  };
  putDoc(ctx.episode.id, `region:${id}`, data, 0);
  sqlite
    .prepare(
      "INSERT INTO comments(id,line_id,user_id,body,created_at) VALUES(?,?,'u','Note',1)",
    )
    .run(`${id}-c`, id);
  const line = (await listLines(ctx.episode.id)).find((l) => l.id === id)!;
  sqlite
    .prepare(
      "INSERT INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,state,created_at) VALUES(?,?,?,?,'Suggestion','','translation','pending',1)",
    )
    .run(`${id}-s`, ctx.episode.id, id, line.revision);
  return id;
}
const pixels = async (asset: string) =>
  hash(
    await sharp(await readAsset(asset))
      .removeAlpha()
      .raw()
      .toBuffer(),
  );
async function crop(
  asset: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  return hash(
    await sharp(await readAsset(asset))
      .extract({ left: x, top: y, width, height })
      .removeAlpha()
      .raw()
      .toBuffer(),
  );
}

test("boundary move conserves every raster and region identity, invalidates page reviews/completion, and fully undoes", async () => {
  const f = await seed([100, 80], [400, 300]),
    [a, b] = f.images,
    id = await region(f.ctx, a.id);
  const beforeRegion = storedDoc(`region:${id}`),
    beforePages = f.images.map((i) => storedDoc(`page:${i.id}`));
  const job = createJob(f.ctx.episode.id, "page-proofread", {
    imageId: a.id,
    mode: "raw",
  });
  updateJob(job, "completed", {
    snapshot: { raw: f.saved[a.id].prepared },
    critique: "Saved reading",
  });
  const preview = await previewBoundary(f.ctx, a.id, 300);
  assert.equal(preview.direction, "next");
  assert.equal(preview.pixels, 100);
  await moveBoundary(f.ctx, a.id, 300, preview.revisionToken);
  const images = await listImages(f.ctx.episode.id);
  assert.deepEqual(
    images.map((i) => i.id),
    [a.id, b.id],
  );
  assert.deepEqual(
    images.map((i) => [i.width, i.height]),
    [
      [100, 300],
      [100, 400],
    ],
  );
  for (const key of keys) {
    const pa = getDoc<PageData>(`page:${a.id}`, {}).data,
      pb = getDoc<PageData>(`page:${b.id}`, {}).data;
    assert.deepEqual(
      await pixels(pa[key]!),
      await crop(f.saved[a.id][key], 0, 0, 100, 300),
    );
    assert.deepEqual(
      await crop(pb[key]!, 0, 0, 100, 100),
      await crop(f.saved[a.id][key], 0, 300, 100, 100),
    );
    assert.deepEqual(
      await crop(pb[key]!, 10, 100, 80, 300),
      await pixels(f.saved[b.id][key]),
    );
    assert.equal(pa.completed, undefined);
    assert.equal(pb.completed, undefined);
    assert.equal(pa.cleanApproved, true);
    assert.equal(pb.cleanApproved, true);
  }
  const line = (await listLines(f.ctx.episode.id)).find((l) => l.id === id)!;
  assert.equal(line.imageId, b.id);
  assert.equal(line.y, 0.05);
  assert.equal(line.body, "English");
  assert.equal(line.status, "approved");
  const doc = getDoc<RegionData>(`region:${id}`, {}).data;
  assert.equal(doc.locked, true);
  assert.equal(doc.geometryApproved, true);
  assert.deepEqual(doc.charRuns, beforeRegion.data.charRuns);
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) n FROM comments WHERE line_id=?")
        .get(id) as any
    ).n,
    1,
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT base_revision FROM suggestions WHERE line_id=?")
        .get(id) as any
    ).base_revision,
    line.revision,
  );
  assert.equal(
    (
      listJobs(f.ctx.episode.id).find((j) => j.id === job)!.progress
        .pageGeometry as any
    ).stale,
    true,
  );
  await undoPageOp(f.ctx);
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => [i.id, i.height]),
    [
      [a.id, 400],
      [b.id, 300],
    ],
  );
  for (const d of beforePages) {
    assert.deepEqual(storedDoc(d.id).data, d.data);
    assert.deepEqual(storedDoc(d.id).undo, d.undo);
  }
  assert.deepEqual(storedDoc(`region:${id}`).data, beforeRegion.data);
  assert.equal(
    listJobs(f.ctx.episode.id).find((j) => j.id === job)!.progress.pageGeometry,
    undefined,
  );
});

test("top segment and midpoint move to previous; missing neighbors, credits and crossing regions leave work unchanged", async () => {
  const f = await seed(),
    [a, b] = f.images;
  const id = await region(f.ctx, b.id, 0.1, 0.15);
  await assert.rejects(
    previewBoundary(f.ctx, b.id, 70),
    /crosses an existing region/,
  );
  await assert.rejects(
    previewBoundary(f.ctx, a.id, 100),
    /no adjacent previous/,
  );
  await assert.rejects(previewBoundary(f.ctx, b.id, 300), /no adjacent next/);
  sqlite.prepare("UPDATE images SET role='post-credits' WHERE id=?").run(a.id);
  await assert.rejects(
    previewBoundary(f.ctx, b.id, 200),
    /no adjacent previous/,
  );
  sqlite.prepare("UPDATE images SET role='page' WHERE id=?").run(a.id);
  const preview = await previewBoundary(f.ctx, b.id, 200);
  assert.equal(preview.direction, "previous");
  await moveBoundary(f.ctx, b.id, 200, preview.revisionToken);
  assert.equal(
    (await listLines(f.ctx.episode.id)).find((l) => l.id === id)!.imageId,
    a.id,
  );
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [600, 200],
  );
});

test("stale previews and missing historical assets abort without replacing pages", async () => {
  const f = await seed(),
    [a] = f.images,
    preview = await previewBoundary(f.ctx, a.id, 300);
  const doc = getDoc<PageData>(`page:${a.id}`, {});
  putDoc(
    f.ctx.episode.id,
    doc.id,
    { ...doc.data, cleanApproved: false },
    doc.revision,
  );
  await assert.rejects(
    moveBoundary(f.ctx, a.id, 300, preview.revisionToken),
    /changed after the preview/,
  );
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [400, 400],
  );
  const row = storedDoc(doc.id);
  row.undo.push({ prepared: "f".repeat(64) });
  sqlite
    .prepare("UPDATE workflow_docs SET undo=? WHERE id=?")
    .run(JSON.stringify(row.undo), doc.id);
  const next = await previewBoundary(f.ctx, a.id, 300);
  await assert.rejects(moveBoundary(f.ctx, a.id, 300, next.revisionToken));
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [400, 400],
  );
});

test("cleaning history is projected and linked across current pages; earlier geometry undo blocks crossing the new boundary", async () => {
  const f = await seed(),
    [a, b] = f.images,
    id = await region(f.ctx, a.id);
  const old = getDoc<PageData>(`page:${a.id}`, {}),
    changed = await storeAsset(
      await sharp({
        create: { width: 100, height: 400, channels: 3, background: "red" },
      })
        .png()
        .toBuffer(),
    );
  putDoc(
    f.ctx.episode.id,
    old.id,
    { ...old.data, cleaned: changed },
    old.revision,
  );
  const r = getDoc<RegionData>(`region:${id}`, {});
  putDoc(
    f.ctx.episode.id,
    r.id,
    { ...r.data, style: { size: 18 } },
    r.revision,
  );
  const preview = await previewBoundary(f.ctx, a.id, 300);
  await moveBoundary(f.ctx, a.id, 300, preview.revisionToken);
  const pa = getDoc<PageData>(`page:${a.id}`, {}),
    pb = getDoc<PageData>(`page:${b.id}`, {});
  putDoc(f.ctx.episode.id, pa.id, pa.data, pa.revision, "undo");
  assert.deepEqual(
    await pixels(getDoc<PageData>(pa.id, {}).data.cleaned!),
    await crop(f.saved[a.id].cleaned, 0, 0, 100, 300),
  );
  assert.deepEqual(
    await crop(getDoc<PageData>(pb.id, {}).data.cleaned!, 0, 0, 100, 100),
    await crop(f.saved[a.id].cleaned, 0, 300, 100, 100),
  );
  const regionDoc = getDoc<RegionData>(r.id, {});
  putDoc(f.ctx.episode.id, r.id, regionDoc.data, regionDoc.revision, "undo");
  assert.equal(getDoc<RegionData>(r.id, {}).data.style?.size, 12);
  const row = storedDoc(r.id);
  row.undo.push({
    ...row.data,
    polygon: [
      { x: 0, y: -0.2 },
      { x: 0.2, y: 0 },
      { x: 0, y: 0.1 },
    ],
  });
  sqlite
    .prepare("UPDATE workflow_docs SET undo=? WHERE id=?")
    .run(JSON.stringify(row.undo), r.id);
  const before = storedDoc(r.id);
  assert.throws(
    () => putDoc(f.ctx.episode.id, r.id, before.data, before.revision, "undo"),
    /Adjust the boundary first/,
  );
  assert.deepEqual(storedDoc(r.id), before);
});

test("horizontal split/merge and vertical reslice share lossless layers and preserve cleaning records", async () => {
  const f = await seed(),
    [a, b] = f.images;
  for (const image of f.images) {
    const d = getDoc<PageData>(`page:${image.id}`, {});
    putDoc(
      f.ctx.episode.id,
      d.id,
      {
        ...d.data,
        cleanFinish: {
          base: f.saved[image.id].prepared,
          answer: f.saved[image.id].cleaned,
          mask: f.saved[image.id].mask,
          result: f.saved[image.id].cleaned,
          method: image.id === a.id ? "tone" : "none",
        },
      },
      d.revision,
    );
  }
  const combined = await combineSpread(f.ctx, [a.id, b.id]);
  assert.equal(combined.width, 200);
  const page = getDoc<PageData>(`page:${a.id}`, {}).data;
  assert.equal(page.cleanFinishes?.length, 2);
  assert.equal(page.completed, undefined);
  assert.deepEqual(
    await crop(page.cleaned!, 0, 0, 100, 400),
    await pixels(f.saved[a.id].cleaned),
  );
  assert.deepEqual(
    await crop(page.cleaned!, 100, 0, 100, 400),
    await pixels(f.saved[b.id].cleaned),
  );
  await splitSpread(f.ctx, a.id, { force: true, at: 0.5 });
  const split = await listImages(f.ctx.episode.id);
  assert.equal(split.length, 2);
  for (const [i, image] of split.entries())
    assert.deepEqual(
      await pixels(getDoc<PageData>(`page:${image.id}`, {}).data.cleaned!),
      await pixels(f.saved[f.images[i].id].cleaned),
    );
  await joinStrip(
    f.ctx,
    split.map((i) => i.id),
  );
  const joined = (await listImages(f.ctx.episode.id))[0];
  assert.equal(joined.height, 800);
  await reslicePages(f.ctx, {
    imageIds: [joined.id],
    cuts: [400],
    sizing: "custom",
    maxHeight: 400,
  });
  const final = await listImages(f.ctx.episode.id);
  assert.equal(final.length, 2);
  for (const [i, image] of final.entries())
    assert.deepEqual(
      await pixels(getDoc<PageData>(`page:${image.id}`, {}).data.cleaned!),
      await pixels(f.saved[f.images[i].id].cleaned),
    );
});

test("reslicing one participant updates linked cleaning undo on its other current pages, including redo", async () => {
  const f = await seed(),
    [a, b] = f.images;
  const old = getDoc<PageData>(`page:${a.id}`, {}),
    red = await storeAsset(
      await sharp({
        create: {
          width: a.width,
          height: a.height,
          channels: 3,
          background: "red",
        },
      })
        .png()
        .toBuffer(),
    );
  putDoc(f.ctx.episode.id, old.id, { ...old.data, cleaned: red }, old.revision);
  const preview = await previewBoundary(f.ctx, a.id, 300);
  await moveBoundary(f.ctx, a.id, 300, preview.revisionToken);
  await reslicePages(f.ctx, {
    imageIds: [a.id],
    cuts: [150],
    sizing: "custom",
    maxHeight: 200,
  });
  const pages = await listImages(f.ctx.episode.id),
    bDoc = getDoc<PageData>(`page:${b.id}`, {});
  putDoc(f.ctx.episode.id, bDoc.id, bDoc.data, bDoc.revision, "undo");
  for (const [i, image] of pages.filter((i) => i.id !== b.id).entries()) {
    assert.equal(
      await pixels(getDoc<PageData>(`page:${image.id}`, {}).data.cleaned!),
      await crop(f.saved[a.id].cleaned, 0, i * 150, 100, 150),
    );
  }
  assert.equal(
    await crop(getDoc<PageData>(bDoc.id, {}).data.cleaned!, 0, 0, 100, 100),
    await crop(f.saved[a.id].cleaned, 0, 300, 100, 100),
  );
  const next = getDoc<PageData>(bDoc.id, {});
  putDoc(f.ctx.episode.id, next.id, next.data, next.revision, "redo");
  for (const image of pages.filter((i) => i.id !== b.id))
    assert.equal(
      await pixels(getDoc<PageData>(`page:${image.id}`, {}).data.cleaned!),
      await crop(red, 0, 0, image.width, image.height),
    );
});

test("a retained finishing fragment cannot overwrite artwork in the other half of a merged page", async () => {
  const f = await seed(),
    [a, b] = f.images;
  const d = getDoc<PageData>(`page:${a.id}`, {}),
    mask = await storeAsset(
      await sharp({
        create: { width: 100, height: 400, channels: 3, background: "white" },
      })
        .png()
        .toBuffer(),
    );
  putDoc(
    f.ctx.episode.id,
    d.id,
    {
      ...d.data,
      cleanFinish: {
        base: f.saved[a.id].prepared,
        answer: f.saved[a.id].cleaned,
        mask,
        result: f.saved[a.id].cleaned,
        method: "tone",
      },
    },
    d.revision,
  );
  await combineSpread(f.ctx, [a.id, b.id]);
  const page = getDoc<PageData>(d.id, {}).data,
    finish = page.cleanFinishes![0];
  const green = await storeAsset(
    await sharp({
      create: { width: 200, height: 400, channels: 3, background: "green" },
    })
      .png()
      .toBuffer(),
  );
  const { compositeFinishedFragment } =
    await import("../src/lib/server/postprocess");
  const result = await compositeFinishedFragment(
    page.cleaned!,
    green,
    finish.mask,
  );
  assert.equal(
    await crop(result, 100, 0, 100, 400),
    await pixels(f.saved[b.id].cleaned),
  );
  assert.equal(
    await crop(result, 0, 0, 100, 400),
    await crop(green, 0, 0, 100, 400),
  );
});

test("RGBA source pixels are copied exactly, and jobs or cancellation cannot change page boundaries", async () => {
  const f = await seed(),
    [a, b] = f.images;
  const rgba = Buffer.alloc(100 * 400 * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 35;
    rgba[i + 1] = 72;
    rgba[i + 2] = 110;
    rgba[i + 3] = 17;
  }
  const raw = await storeAsset(
    await sharp(rgba, { raw: { width: 100, height: 400, channels: 4 } })
      .png()
      .toBuffer(),
  );
  const doc = getDoc<PageData>(`page:${a.id}`, {});
  putDoc(
    f.ctx.episode.id,
    doc.id,
    { ...doc.data, prepared: raw },
    doc.revision,
  );
  const preview = await previewBoundary(f.ctx, a.id, 300);
  const job = createJob(f.ctx.episode.id, "director", {});
  updateJob(job, "running", {});
  await assert.rejects(
    moveBoundary(f.ctx, a.id, 300, preview.revisionToken),
    /active chapter jobs/,
  );
  updateJob(job, "completed", {});
  const { boundaryPlan } = await import("../src/lib/server/pageBoundary");
  const plan = await boundaryPlan(f.ctx, a.id, 300);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    executeReframe(
      f.ctx,
      plan.ids,
      plan.outputs,
      "Cancelled",
      plan.capture.token,
      abort.signal,
    ),
  );
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [400, 400],
  );
  await moveBoundary(f.ctx, a.id, 300, preview.revisionToken);
  const outputs = [];
  for (const [id, height] of [
    [a.id, 300],
    [b.id, 100],
  ] as const)
    outputs.push(
      await sharp(
        await readAsset(getDoc<PageData>(`page:${id}`, {}).data.prepared!),
      )
        .extract({ left: 0, top: 0, width: 100, height })
        .ensureAlpha()
        .raw()
        .toBuffer(),
    );
  assert.equal(hash(Buffer.concat(outputs)), hash(rgba));
});
console.log("Boundary fixtures:", process.env.SCAN_ROOT);

test("legacy region geometry history restores the old hitbox in its new page coordinates", async () => {
  const f = await seed(),
    [a, b] = f.images,
    id = await region(f.ctx, a.id, 0.75, 0.05);
  sqlite
    .prepare("UPDATE lines SET y=.85,updated_at=? WHERE id=?")
    .run(Date.now(), id);
  const doc = getDoc<RegionData>(`region:${id}`, {});
  putDoc(
    f.ctx.episode.id,
    doc.id,
    {
      ...doc.data,
      polygon: [
        { x: 0.2, y: 0.85 },
        { x: 0.4, y: 0.85 },
        { x: 0.4, y: 0.9 },
        { x: 0.2, y: 0.9 },
      ],
    },
    doc.revision,
  );
  const preview = await previewBoundary(f.ctx, a.id, 300);
  await moveBoundary(f.ctx, a.id, 300, preview.revisionToken);
  const before = getDoc<RegionData>(doc.id, {});
  putDoc(f.ctx.episode.id, doc.id, before.data, before.revision, "undo");
  const line = (await listLines(f.ctx.episode.id)).find((l) => l.id === id)!;
  assert.equal(line.imageId, b.id);
  assert.equal(line.y, 0);
  assert.equal(line.h, 0.04);
});

test("an interrupted precommit journal leaves earlier undo available", async () => {
  const f = await seed();
  const { pushUndo, readUndoLog, popUndo } =
    await import("../src/lib/server/pageUndo");
  const { episodeDir } = await import("../src/lib/server/storage");
  const { readFile, writeFile } = await import("node:fs/promises");
  await pushUndo("s", f.ctx.episode.slug, {
    type: "reorder",
    order: f.images.map((i) => ({ id: i.id, sortOrder: i.sortOrder })),
  });
  const path = join(episodeDir("s", f.ctx.episode.slug), "undo.json");
  const log = JSON.parse(await readFile(path, "utf8"));
  log.push({
    type: "reframe",
    frameIds: ["uncommitted-frame"],
    created: [{ id: f.images[0].id }],
    description: "Interrupted",
  });
  await writeFile(path, JSON.stringify(log));
  assert.equal((await readUndoLog("s", f.ctx.episode.slug)).length, 1);
  assert.equal((await popUndo("s", f.ctx.episode.slug))?.type, "reorder");
  assert.equal((await readUndoLog("s", f.ctx.episode.slug)).length, 0);
});

test("a crop between boundary edits keeps older artwork history in the current frame", async () => {
  const f = await seed([100, 100, 100], [400, 400, 400]);
  const [a, b] = f.images;
  await moveBoundary(
    f.ctx,
    a.id,
    300,
    (await previewBoundary(f.ctx, a.id, 300)).revisionToken,
  );
  const { cropPage } = await import("../src/lib/server/pageEdit");
  await cropPage(f.ctx, b.id, { x: 10, y: 0, w: 80, h: 500 });
  const doc = storedDoc(`page:${b.id}`);
  for (const frame of [doc.data, ...doc.undo, ...doc.redo]) {
    for (const key of keys)
      if (frame[key]) {
        const meta = await sharp(await readAsset(frame[key])).metadata();
        assert.equal(meta.width, 80);
        assert.equal(meta.height, 500);
      }
  }
  const preview = await previewBoundary(f.ctx, b.id, 400);
  await moveBoundary(f.ctx, b.id, 400, preview.revisionToken);
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [300, 400, 500],
  );
  await undoPageOp(f.ctx);
  await undoPageOp(f.ctx);
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => [i.width, i.height]),
    [
      [100, 300],
      [100, 500],
      [100, 400],
    ],
  );
});

test("the running reslice context excludes itself while still blocking other chapter jobs", async () => {
  const f = await seed(),
    [a] = f.images;
  const preview = await previewBoundary(f.ctx, a.id, 300);
  const { runWithJob } = await import("../src/lib/server/jobs");
  const ownJob = createJob(f.ctx.episode.id, "reslice", {});
  const otherJob = createJob(f.ctx.episode.id, "mask", {});
  await assert.rejects(
    runWithJob({ jobId: ownJob, step: "reslice" }, () =>
      moveBoundary(f.ctx, a.id, 300, preview.revisionToken),
    ),
    /mask: running/,
  );
  updateJob(otherJob, "completed", {});
  await runWithJob({ jobId: ownJob, step: "reslice" }, () =>
    moveBoundary(f.ctx, a.id, 300, preview.revisionToken),
  );
  updateJob(ownJob, "completed", {});
  assert.deepEqual(
    (await listImages(f.ctx.episode.id)).map((i) => i.height),
    [300, 500],
  );
});
