import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
process.env.SCAN_ROOT = await mkdtemp(
  join(tmpdir(), "komatose-chapter-mask-test-"),
);
process.env.SCAN_DATA_DIR = join(process.env.SCAN_ROOT, "data");
process.env.DATABASE_URL = join(process.env.SCAN_DATA_DIR, "scan.db");
const { sqlite } = await import("../src/lib/server/db");
const { saveImageFile } = await import("../src/lib/server/storage");
const { getSeries, getEpisode, listImages } =
  await import("../src/lib/server/queries");
const { getDoc, putDoc, storeAsset, readAsset } =
  await import("../src/lib/server/workflowStore");
const { startChapterMask, cancelChapterMask } =
  await import("../src/lib/server/chapterMask");
const { listJobs } = await import("../src/lib/server/jobs");
const { fixturePasses } = await import("./local-ocr-fixture");
await fixturePasses("ctd", ["textMask"]);
sqlite.exec(
  "INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','s','Series',1,1)",
);
let count = 0;
async function seed() {
  const id = `e${++count}`;
  sqlite
    .prepare(
      "INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,'s',?,?,1,1)",
    )
    .run(id, id, id);
  for (let i = 0; i < 4; i++) {
    const bytes = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "#eeeeee" },
    })
      .png()
      .toBuffer();
    const file = await saveImageFile({
      seriesSlug: "s",
      episodeSlug: id,
      sortOrder: i,
      originalName: `p${i}.png`,
      bytes,
      mime: "image/png",
    });
    sqlite
      .prepare(
        "INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,role,created_at,updated_at) VALUES(?,?,?,?,?,80,120,?,1,1)",
      )
      .run(
        `${id}-p${i}`,
        id,
        file.filename,
        `p${i}.png`,
        i,
        i === 3 ? "post-credits" : "page",
      );
  }
  return {
    series: (await getSeries("s"))!,
    episode: (await getEpisode(id))!,
    maskEngine: "ctd",
    expansion: 4,
  };
}
const mask = await sharp({
  create: { width: 80, height: 120, channels: 3, background: "#ffffff" },
})
  .png()
  .toBuffer();
async function detect(payload: any) {
  assert.equal(payload.wholePage, true);
  assert.equal(payload.regions, undefined);
  assert.equal(payload.cmd, "mask");
  await writeFile(payload.out, mask);
  return {
    maskEngine: "ctd",
    maskVersion: "test",
    backend: "fixture",
    maskDiagnostics: [],
  };
}
async function finished(episode: string, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = listJobs(episode).find((j) => j.id === id)!;
    if (!["running", "queued"].includes(job.state)) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Mask job timed out");
}
test("chapter masks unprepared pages without regions, skips credits, preserves cleaned artwork, and supports undo", async () => {
  const options = await seed(),
    id = options.episode.id;
  const image = (await listImages(id))[1];
  const prepared = await storeAsset(mask);
  putDoc(
    id,
    `page:${image.id}`,
    {
      prepared,
      preparedAt: 1,
      thumbnail: prepared,
      thumbnailAt: 1,
      cleaned: prepared,
      mask: prepared,
      cleanApproved: true,
      completed: { clean: "old", translate: "kept" },
    },
    0,
  );
  const before = getDoc(`page:${image.id}`, {});
  let calls = 0;
  const { jobId } = await startChapterMask(options, async (p) => {
    calls++;
    return detect(p);
  });
  assert.equal((await finished(id, jobId)).state, "completed");
  assert.equal(calls, 3);
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) n FROM lines WHERE episode_id=?")
        .get(id) as { n: number }
    ).n,
    0,
  );
  for (const page of (await listImages(id)).slice(0, 3)) {
    const doc = getDoc<any>(`page:${page.id}`, {});
    assert.ok(doc.data.mask);
    assert.equal(doc.data.maskApproved, false);
    assert.equal(doc.data.maskDiagnostics.wholePage, true);
    assert.equal(doc.data.expansion, 4);
  }
  const doc = getDoc<any>(before.id, {});
  assert.equal(doc.data.cleaned, prepared);
  assert.equal(doc.data.completed.clean, undefined);
  assert.equal(doc.data.completed.translate, "kept");
  putDoc(id, doc.id, doc.data, doc.revision, "undo");
  assert.deepEqual(getDoc(doc.id, {}).data, before.data);
  assert.deepEqual(getDoc(`page:${id}-p3`, {}).data, {});
});
test("chapter masking refuses to overwrite a concurrent mask edit and continues other pages", async () => {
  const options = await seed(),
    id = options.episode.id;
  let calls = 0;
  const { jobId } = await startChapterMask(options, async (p) => {
    if (calls++ === 0) {
      const doc = getDoc<any>(`page:${id}-p0`, {});
      putDoc(id, doc.id, { ...doc.data, mask: "manual-mask" }, doc.revision);
    }
    return detect(p);
  });
  const job = await finished(id, jobId);
  assert.equal(job.state, "failed");
  assert.equal(job.progress.completed, 2);
  assert.equal(getDoc<any>(`page:${id}-p0`, {}).data.mask, "manual-mask");
  assert.equal(job.pages.filter((p) => p.state === "failed").length, 1);
  const retry = await startChapterMask(
    { ...options, imageIds: [`${id}-p0`] },
    detect,
  );
  assert.equal((await finished(id, retry.jobId)).state, "completed");
});
test("chapter masking cancellation keeps saved masks and rejects a duplicate job", async () => {
  const options = await seed(),
    id = options.episode.id;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  let calls = 0;
  const result = await startChapterMask(options, async (p, signal) => {
    if (calls++ === 1) {
      entered();
      await new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(Error("Cancelled")), {
          once: true,
        }),
      );
    }
    return detect(p);
  });
  await ready;
  await assert.rejects(
    startChapterMask(options, detect),
    /active chapter jobs/,
  );
  cancelChapterMask(result.jobId);
  const job = await finished(id, result.jobId);
  assert.equal(job.state, "cancelled");
  assert.equal(job.progress.completed, 1);
  assert.ok(getDoc<any>(`page:${id}-p0`, {}).data.mask);
  assert.equal(getDoc<any>(`page:${id}-p1`, {}).data.mask, undefined);
  assert.equal(getDoc<any>(`page:${id}-p2`, {}).data.mask, undefined);
});
