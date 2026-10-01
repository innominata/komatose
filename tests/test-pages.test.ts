import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = await mkdtemp("/tmp/scan-test-pages-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "scan.db");
const { db } = await import("../src/lib/server/db");
const { users, series, episodes, images } = await import("../src/lib/server/db/schema");
const { addTestPages, TEST_PAGES_TITLE, TEST_PAGES_CHAPTER, listTestPageNames } = await import("../src/lib/server/testPages");
const { workCredit } = await import("../src/lib/workCredit");

after(() => rm(root, { recursive: true, force: true }));

db.insert(users).values({ id: "editor", username: "editor", passwordHash: "unused", role: "admin", createdAt: 1 }).run();

test("Add Test Pages creates the credited series and chapter, then skips pages already there", async () => {
  const names = await listTestPageNames();
  assert.deepEqual(names, ["001.jpg", "002.jpg", "003.jpg", "004.jpg", "005.jpg", "006.jpg", "007.jpg", "008.jpg", "009.jpg", "010.jpg"]);
  const first = await addTestPages("editor");
  assert.equal(first.title, TEST_PAGES_TITLE);
  assert.equal(first.added, 10);
  assert.ok(workCredit(first.title));
  const saved = db.select().from(series).where(eq(series.id, first.seriesId)).get()!;
  assert.match(saved.notes, /佐藤秀峰/);
  assert.match(saved.notes, /SHUHO SATO/);
  const chapter = db.select().from(episodes).where(eq(episodes.id, first.episodeId)).get()!;
  assert.equal(chapter.title, TEST_PAGES_CHAPTER);
  assert.equal(chapter.seriesId, first.seriesId);
  const pages = db.select().from(images).where(eq(images.episodeId, chapter.id)).all();
  assert.deepEqual(pages.map((page) => page.originalName), names);
  assert.ok(pages.every((page) => page.width === 1414 && page.height === 2000));
  const second = await addTestPages("editor");
  assert.equal(second.seriesId, first.seriesId);
  assert.equal(second.episodeId, first.episodeId);
  assert.equal(second.added, 0);
  assert.equal(db.select().from(images).where(eq(images.episodeId, chapter.id)).all().length, 10);
});
