import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PageData } from "../src/lib/workflow";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = await mkdtemp("/tmp/scan-hot-path-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "scan.db");

await import("../src/lib/workflow");
const { db, sqlite } = await import("../src/lib/server/db");
const { users, series, episodes, images, lines, comments } = await import("../src/lib/server/db/schema");
const { episodeOwnsAsset, getDoc, peekUndo, putDoc, storeAsset, assetPath } = await import("../src/lib/server/workflowStore");
const { createJob, jobPollStamp, listJobs, updateJob } = await import("../src/lib/server/jobs");
const { pruneExportJobs, unlinkAssetFiles, unreferencedAssets } = await import("../src/lib/server/exportRetention");
const { forgetPageHistory } = await import("../src/lib/server/stepUndo");

db.insert(users).values({ id: "editor", username: "editor", role: "admin", passwordHash: "x", createdAt: 1 }).run();
db.insert(series).values({ id: "series", slug: "series", title: "Series", createdAt: 1, updatedAt: 1 }).run();
db.insert(episodes).values({
  id: "chapter", seriesId: "series", slug: "chapter", title: "1", status: "raws",
  createdAt: 1, updatedAt: 1,
}).run();

after(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

test("editor hot path keeps current pages fast, polls jobs, and drops finished undo and old exports", async () => {
  assert.ok(sqlite.prepare("SELECT 1 FROM schema_versions WHERE version=7").get());
  assert.ok(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_workflow_docs_episode'").get());

  const hash = await storeAsset(Buffer.from("page-png"));
  putDoc("chapter", "page:p1", { prepared: hash }, 0);
  assert.equal(episodeOwnsAsset("chapter", hash), true);
  const onlyHistory = "ab".repeat(32);
  sqlite.prepare(
    "INSERT INTO workflow_revisions(episode_id, entity_id, revision, data, created_at) VALUES(?,?,?,?,?)",
  ).run("chapter", "page:old", 1, JSON.stringify({ prepared: onlyHistory }), 1);
  assert.equal(episodeOwnsAsset("chapter", onlyHistory), true);
  assert.equal(episodeOwnsAsset("chapter", "cd".repeat(32)), false);

  const before = jobPollStamp("chapter");
  const exp = createJob("chapter", "export", {
    schemaVersion: 1,
    format: "png",
    draft: false,
    quality: 95,
    includeMetadata: false,
    lines: [{ body: "x".repeat(2000) }],
  });
  updateJob(exp, "completed", {});
  const older = createJob("chapter", "mask", { request: { imageId: "p1", strokes: [{ points: [{ x: 1, y: 1 }] }] } });
  updateJob(older, "completed", {});
  const latest = createJob("chapter", "mask", { request: { imageId: "p1", strokes: [{ points: [{ x: 2, y: 2 }] }] } });
  const summary = listJobs("chapter", "summary");
  const summarized = summary.find((job) => job.id === exp)!;
  assert.equal(summarized.payload.format, "png");
  assert.equal("lines" in summarized.payload, false);
  assert.equal(listJobs("chapter").find((job) => job.id === exp)!.payload.schemaVersion, 1);
  assert.equal(summary.find((job) => job.id === older)!.payload.request?.strokes, undefined);
  const latestStrokes = summary.find((job) => job.id === latest)!.payload.request?.strokes;
  assert.ok(Array.isArray(latestStrokes));
  assert.equal(latestStrokes.length, 1);
  const stamp = jobPollStamp("chapter");
  assert.ok(stamp.jobsAt >= before.jobsAt);
  assert.equal(stamp.revision, jobPollStamp("chapter").revision);

  const oldZip = await storeAsset(Buffer.from("old-zip"));
  const newZip = await storeAsset(Buffer.from("new-zip"));
  updateJob(exp, "completed", { artifact: oldZip, filename: "old.zip" });
  const kept = createJob("chapter", "export", { format: "jpg", draft: true, quality: 80, includeMetadata: true });
  updateJob(kept, "completed", { artifact: newZip, filename: "new.zip" });
  const removed = pruneExportJobs(sqlite, { episodeId: "chapter", keepJobId: kept });
  unlinkAssetFiles(unreferencedAssets(sqlite, removed.hashes));
  const exports = listJobs("chapter").filter((job) => job.kind === "export");
  assert.deepEqual(exports.map((job) => job.id), [kept]);
  assert.deepEqual(exports[0].payload, { format: "jpg", draft: true, quality: 80, includeMetadata: true });
  assert.equal(existsSync(assetPath(oldZip)), false);
  assert.equal(existsSync(assetPath(newZip)), true);

  const image = {
    episodeId: "chapter", filename: "p.png", originalName: "p.png", width: 10, height: 10,
    createdAt: 1, updatedAt: 1,
  };
  db.insert(images).values([
    { ...image, id: "p1", sortOrder: 0 },
    { ...image, id: "p2", filename: "p2.png", originalName: "p2.png", sortOrder: 1 },
  ]).run();
  db.insert(lines).values([
    { id: "r1", episodeId: "chapter", imageId: "p1", body: "Hello", updatedAt: 1 },
    { id: "r2", episodeId: "chapter", imageId: "p2", body: "There", updatedAt: 1 },
  ]).run();
  db.insert(comments).values({
    id: "c1", lineId: "r1", userId: "editor", body: "Note", createdAt: 1,
  }).run();
  sqlite.prepare(
    "INSERT INTO workflow_revisions(episode_id, entity_id, revision, data, created_at) VALUES(?,?,?,?,?)",
  ).run("chapter", "r1", 1, JSON.stringify({ body: "Old" }), 1);
  sqlite.prepare(
    "INSERT INTO workflow_revisions(episode_id, entity_id, revision, data, created_at) VALUES(?,?,?,?,?)",
  ).run("chapter", "r2", 1, JSON.stringify({ body: "Keep" }), 1);
  sqlite.prepare(
    "INSERT INTO workflow_revisions(episode_id, entity_id, revision, data, created_at) VALUES(?,?,?,?,?)",
  ).run("chapter", "comment:c1", 1, JSON.stringify({ body: "Old note" }), 1);

  putDoc("chapter", "region:r1", { polygon: [{ x: 0, y: 0 }] }, 0);
  putDoc("chapter", "region:r1", { polygon: [{ x: 1, y: 1 }] }, 1);
  putDoc("chapter", "region:r1", { polygon: [{ x: 2, y: 2 }] }, 2);
  putDoc("chapter", "region:r2", { polygon: [{ x: 3, y: 3 }] }, 0);
  putDoc("chapter", "region:r2", { polygon: [{ x: 4, y: 4 }] }, 1);
  assert.equal(peekUndo("region:r1").length, 3);

  const translated = forgetPageHistory("chapter", "p1", "translate");
  assert.ok(translated.removed >= 1);
  const { readiness } = await import("../src/lib/server/workflowService");
  const { toEpisode, toSeries, listImages, listLines } = await import("../src/lib/server/queries");
  const { eq } = await import("drizzle-orm");
  const seriesRow = toSeries(db.select().from(series).where(eq(series.id, "series")).get()!);
  const episodeRow = toEpisode(db.select().from(episodes).where(eq(episodes.id, "chapter")).get()!);
  const openSteps = async () =>
    readiness(seriesRow, episodeRow, await listImages("chapter"), await listLines("chapter"))
      .filter((issue) => issue.code === "step-complete" && issue.imageId === "p1");
  assert.equal((await openSteps()).filter((issue) => issue.message.includes("Translate")).length, 0);
  assert.equal((await openSteps()).length, 3);
  assert.equal(((sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_revisions WHERE entity_id='r1'").get() as { n: number }).n), 0);
  assert.equal(((sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_revisions WHERE entity_id='comment:c1'").get() as { n: number }).n), 1);
  assert.equal(((sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_revisions WHERE entity_id='r2'").get() as { n: number }).n), 1);
  assert.equal(peekUndo("region:r1").length, 3);

  const reviewed = forgetPageHistory("chapter", "p1", "review");
  assert.ok(reviewed.removed >= 1);
  assert.equal(((sqlite.prepare("SELECT COUNT(*) AS n FROM workflow_revisions WHERE entity_id='comment:c1'").get() as { n: number }).n), 0);
  assert.equal(((sqlite.prepare("SELECT body FROM lines WHERE id='r1'").get() as { body: string }).body), "Hello");
  db.update(lines).set({ body: "Changed" }).where(eq(lines.id, "r1")).run();
  assert.equal((await openSteps()).filter((issue) => issue.message.includes("Translate")).length, 1);
  assert.equal((await openSteps()).filter((issue) => issue.message.includes("Review")).length, 1);

  const pageRev = getDoc("page:p1", {}).revision;
  putDoc("chapter", "page:p1", { prepared: hash, cleaned: "cc".repeat(32) }, pageRev);
  putDoc("chapter", "page:p2", { prepared: hash }, 0);
  putDoc("chapter", "page:p2", { prepared: hash, cleaned: "dd".repeat(32) }, 1);
  assert.ok(peekUndo("page:p1").length >= 1);
  forgetPageHistory("chapter", "p1", "clean");
  assert.deepEqual(peekUndo("page:p1"), []);
  assert.equal(getDoc<Partial<PageData>>("page:p1", {}).data.prepared, hash);
  assert.ok(peekUndo("page:p2").length >= 1);
  assert.equal(peekUndo("region:r1").length, 3);

  const typeset = forgetPageHistory("chapter", "p1", "typeset");
  assert.ok(typeset.removed >= 1);
  assert.deepEqual(peekUndo("region:r1"), []);
  assert.deepEqual(getDoc("region:r1", {}).data, { polygon: [{ x: 2, y: 2 }] });
  assert.ok(peekUndo("region:r2").length >= 1);
  const { completeOutstandingPages } = await import("../src/lib/server/stepUndo");
  const { onlyStepCompleteBlockers } = await import("../src/lib/workflow");
  assert.equal(onlyStepCompleteBlockers([{ code: "step-complete", message: "Mark this page complete in Translate" }]), true);
  assert.equal(onlyStepCompleteBlockers([
    { code: "step-complete", message: "Mark this page complete in Translate" },
    { code: "review", message: "Approve the English translation" },
  ]), false);
  assert.equal(onlyStepCompleteBlockers([{ code: "glossary", message: "term", severity: "warning" }]), false);
  const finished = completeOutstandingPages("chapter");
  assert.equal(finished.pages, 2);
  assert.equal((await openSteps()).length, 0);
  assert.ok(peekUndo("page:p2").length >= 1, "marking complete must keep revision history");
  const other = readiness(seriesRow, episodeRow, await listImages("chapter"), await listLines("chapter"))
    .filter((issue) => issue.code === "step-complete" && issue.imageId === "p2");
  assert.equal(other.length, 0);
  const { removePageRegions } = await import("../src/lib/server/workflowService");
  const removedRegions = removePageRegions("chapter", "p1");
  assert.deepEqual(removedRegions, ["r1"]);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM lines WHERE image_id='p1'").get() as { n: number }).n, 0);
  assert.equal((sqlite.prepare("SELECT id FROM lines WHERE id='r2'").get() as { id: string }).id, "r2");
});
