import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import JSZip from "jszip";
import { parseSeriesCredits, parseSeriesCreditImageId, serializeSeriesCredits, withSeriesCreditImages } from "../src/lib/credits";
import { exportBlockers } from "../src/lib/workflow";

const root = await mkdtemp("/tmp/scan-credits-");
process.env.SCAN_DATA_DIR = join(root, "data");
process.env.DATABASE_URL = join(root, "scan.db");
const { db, sqlite } = await import("../src/lib/server/db");
const { users, series, episodes, images } = await import("../src/lib/server/db/schema");
const { eq } = await import("drizzle-orm");
const { saveImageFile } = await import("../src/lib/server/storage");
const { toEpisode, toSeries, listImages } = await import("../src/lib/server/queries");
const { saveSeriesCredit, clearSeriesCredit } = await import("../src/lib/server/seriesCredits");
const { addSeriesCredits, autoAlignPages, autoCropPages, contentBBox } = await import("../src/lib/server/pageEdit");
const { readiness, renumberPages } = await import("../src/lib/server/workflowService");
const { captureExport, captureExportMetadata, buildExport } = await import("../src/lib/server/finishedExport");
const { putDoc, storeAsset } = await import("../src/lib/server/workflowStore");
const { getDoc } = await import("../src/lib/server/workflowStore");
const { actions: libraryActions } = await import("../src/routes/+page.server");
const { POST: uploadChapterImage } = await import("../src/routes/api/episodes/[eid]/images/+server");

const user = { id: "editor", username: "editor", role: "admin" as const };
db.insert(users).values({ ...user, passwordHash: "unused", createdAt: 1 }).run();
db.insert(series).values({ id: "series", slug: "series", title: "Volume", createdAt: 1, updatedAt: 1 }).run();
const s = toSeries(db.select().from(series).get()!);
let n = 0;

async function png(width: number, height: number, color: string) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function artwork(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const shade = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 32 : 224;
    pixels.set([shade, shade, shade], (y * width + x) * 3);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function chapter() {
  const id = `ch-${++n}`;
  db.insert(episodes).values({
    id, seriesId: s.id, slug: id, title: id, numberingStale: false, createdAt: 10, updatedAt: 20,
  }).run();
  const ctx = {
    series: toSeries(db.select().from(series).where(eq(series.id, s.id)).get()!),
    episode: toEpisode(db.select().from(episodes).where(eq(episodes.id, id)).get()!),
    user,
  };
  return ctx;
}

async function addPage(ctx: {
  series: ReturnType<typeof toSeries>;
  episode: ReturnType<typeof toEpisode>;
  user: typeof user;
}, opts: {
  id: string; width: number; height: number; color?: string; sortOrder: number; role?: string; patterned?: boolean;
}) {
  const bytes = opts.patterned
    ? await artwork(opts.width, opts.height)
    : await png(opts.width, opts.height, opts.color ?? "#808080");
  const saved = await saveImageFile({
    seriesSlug: ctx.series.slug, episodeSlug: ctx.episode.slug, sortOrder: opts.sortOrder,
    originalName: `${opts.id}.png`, bytes, mime: "image/png",
  });
  db.insert(images).values({
    ...saved, id: opts.id, episodeId: ctx.episode.id, originalName: `${opts.id}.png`,
    sortOrder: opts.sortOrder, role: opts.role ?? "page", createdAt: 1, updatedAt: 1,
  }).run();
  const asset = await storeAsset(bytes);
  putDoc(ctx.episode.id, `page:${opts.id}`, { prepared: asset, original: asset, cleanBase: asset, cleaned: asset }, 0);
  return bytes;
}

test("series credits JSON keeps only valid pre/post pages", () => {
  assert.deepEqual(parseSeriesCredits(""), {});
  assert.deepEqual(parseSeriesCredits("{not json"), {});
  const hash = "a".repeat(64);
  const raw = serializeSeriesCredits({
    pre: { hash, filename: "pre.png", originalName: "Pre.png", width: 10, height: 20 },
    post: { hash: "nope", filename: "x", originalName: "x", width: 1, height: 1 },
  });
  assert.deepEqual(parseSeriesCredits(raw), {
    pre: { hash, filename: "pre.png", originalName: "Pre.png", width: 10, height: 20 },
  });
});

test("new series saves format, language, direction and both credits images", async () => {
  const form = new FormData();
  form.set('title', 'New webtoon');
  form.set('pageMode', 'strip');
  form.set('lang', 'korean');
  form.set('direction', 'ltr');
  form.set('pre', new File([await png(60, 20, '#112233')], 'opening.png', { type: 'image/png' }));
  form.set('post', new File([await png(60, 20, '#334455')], 'closing.png', { type: 'image/png' }));
  const result = await libraryActions.create({ locals: { user }, request: new Request('http://test/', { method: 'POST', body: form }) } as any) as { seriesId: string };
  assert.ok(result.seriesId);
  assert.deepEqual(getDoc(`series:${result.seriesId}`, {}).data, { pageMode: 'strip', lang: 'korean', direction: 'ltr' });
  const created = toSeries(db.select().from(series).where(eq(series.id, result.seriesId)).get()!);
  assert.ok(created.credits.pre);
  assert.ok(created.credits.post);
});

test("upload series credits, add to chapter, skip a second add", async () => {
  const ctx = await chapter();
  await addPage(ctx, { id: `${ctx.episode.id}-p0`, width: 80, height: 100, color: "#445566", sortOrder: 0 });
  await addPage(ctx, { id: `${ctx.episode.id}-p1`, width: 80, height: 100, color: "#556677", sortOrder: 1 });
  await saveSeriesCredit(ctx.series.id, "pre", "pre.png", await png(120, 40, "#cc3344"));
  await saveSeriesCredit(ctx.series.id, "post", "post.png", await png(90, 30, "#3344cc"));
  ctx.series = toSeries(db.select().from(series).where(eq(series.id, s.id)).get()!);
  const first = await addSeriesCredits(ctx);
  assert.equal(first.added, 2);
  const pages = await listImages(ctx.episode.id);
  assert.equal(pages.length, 4);
  assert.equal(pages[0].role, "pre-credits");
  assert.equal(pages[0].sortOrder, 0);
  assert.equal(pages[0].width, 80, "added credits scale to current story width");
  assert.equal(pages[0].height, 27);
  assert.equal(pages[1].role, "page");
  assert.equal(pages[2].role, "page");
  assert.equal(pages.at(-1)?.role, "post-credits");
  assert.equal(pages.at(-1)?.width, 80);
  const second = await addSeriesCredits(ctx);
  assert.equal(second.added, 0);
  assert.equal((await listImages(ctx.episode.id)).length, 4);
});

test("series credits appear automatically in exports and chapter pages replace them", async () => {
  const ctx = await chapter();
  await addPage(ctx, { id: `${ctx.episode.id}-p`, width: 40, height: 50, color: "#808080", sortOrder: 0 });
  await saveSeriesCredit(ctx.series.id, "pre", "pre.png", await png(40, 20, "#111111"));
  await saveSeriesCredit(ctx.series.id, "post", "post.png", await png(40, 20, "#eeeeee"));
  const withCredits = toSeries(db.select().from(series).where(eq(series.id, s.id)).get()!);
  const missing = readiness(withCredits, ctx.episode, await listImages(ctx.episode.id), []);
  const credits = missing.filter((issue) => issue.code === "credits");
  assert.equal(credits.length, 0);
  assert.deepEqual(exportBlockers(credits), []);
  const automatic = captureExportMetadata(withCredits, ctx.episode);
  assert.deepEqual(automatic.pages.map((page) => page.image.role), ["pre-credits", "page", "post-credits"]);
  assert.deepEqual(automatic.pages.map((page) => page.image.pageNumber), [1, 2, 3]);
  assert.ok(automatic.pages[0].image.id.startsWith('series-credit:'));
  const zip = await JSZip.loadAsync(await buildExport(await captureExport(withCredits, ctx.episode, 'png', true)));
  assert.deepEqual(Object.keys(zip.files).filter((name) => name.endsWith('.png')).sort(), ['1.png', '2.png', '3.png']);
  assert.equal((await sharp(await zip.file('1.png')!.async('nodebuffer')).metadata()).width, 40);
  ctx.series = withCredits;
  await addSeriesCredits(ctx);
  const overridden = captureExportMetadata(withCredits, ctx.episode);
  assert.equal(overridden.pages.length, 3);
  assert.ok(overridden.pages.every((page) => !page.image.id.startsWith('series-credit:')));
  const present = readiness(withCredits, ctx.episode, await listImages(ctx.episode.id), []);
  assert.equal(present.filter((issue) => issue.code === "credits").length, 0);
  await clearSeriesCredit(s.id, "pre");
  await clearSeriesCredit(s.id, "post");
});

test("chapter credits upload overrides the series default without changing it", async () => {
  const ctx = await chapter();
  await addPage(ctx, { id: `${ctx.episode.id}-story`, width: 80, height: 100, sortOrder: 0 });
  await saveSeriesCredit(ctx.series.id, 'pre', 'series.png', await png(80, 20, '#112233'));
  const form = new FormData();
  form.set('creditKind', 'pre');
  form.set('files', new File([await png(80, 30, '#cc3344')], 'guest.png', { type: 'image/png' }));
  const response = await uploadChapterImage({ locals: { user }, params: { eid: ctx.episode.id },
    request: new Request('http://test/images', { method: 'POST', body: form }) } as any);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = captureExportMetadata(ctx.series, ctx.episode);
  assert.equal(saved.pages[0].image.role, 'pre-credits');
  assert.equal(saved.pages[0].image.originalName, 'guest.png');
  assert.equal(saved.pages.filter((page) => page.image.role === 'pre-credits').length, 1);
  assert.equal(toSeries(db.select().from(series).where(eq(series.id, ctx.series.id)).get()!).credits.pre?.originalName, 'series.png');
});

test("credits pages do not need regions to export", async () => {
  const ctx = await chapter();
  await addPage(ctx, {
    id: `${ctx.episode.id}-pre`,
    width: 40,
    height: 20,
    color: "#cc3344",
    sortOrder: 0,
    role: "pre-credits",
  });
  sqlite.prepare("UPDATE episodes SET numbering_stale=0 WHERE id=?").run(ctx.episode.id);
  renumberPages(ctx.episode.id);
  const issues = readiness(ctx.series, ctx.episode, await listImages(ctx.episode.id), []);
  assert.equal(issues.filter((issue) => issue.code === "regions").length, 0);
  assert.equal(issues.filter((issue) => issue.imageId === `${ctx.episode.id}-pre` && issue.code !== "step-complete").length, 0);
  assert.equal(issues.filter((issue) => issue.code === "step-complete").length, 4);
  assert.equal(exportBlockers(issues).every((issue) => issue.code === "step-complete"), true);
});

test("auto-align measures story pages and scales credits to that width", async () => {
  const ctx = await chapter();
  await addPage(ctx, { id: `${ctx.episode.id}-wide`, width: 80, height: 100, patterned: true, sortOrder: 0 });
  await addPage(ctx, { id: `${ctx.episode.id}-pre`, width: 160, height: 40, color: "#cc3344", sortOrder: 1, role: "pre-credits" });
  const aligned = await autoAlignPages(ctx);
  const story = aligned.find((img) => img.id === `${ctx.episode.id}-wide`)!;
  const credits = aligned.find((img) => img.id === `${ctx.episode.id}-pre`)!;
  assert.equal(story.width, 80);
  assert.equal(story.height, 100);
  assert.equal(credits.width, 80);
  assert.equal(credits.height, 20);
  assert.equal(credits.role, "pre-credits");
});

test("auto-crop skips credits pages", async () => {
  const ctx = await chapter();
  const margin = await sharp({
    create: { width: 100, height: 80, channels: 3, background: "#ffffff" },
  }).composite([{
    input: await png(60, 40, "#333333"),
    left: 20,
    top: 20,
  }]).png().toBuffer();
  const saved = await saveImageFile({
    seriesSlug: ctx.series.slug, episodeSlug: ctx.episode.slug, sortOrder: 0,
    originalName: "credits.png", bytes: margin, mime: "image/png",
  });
  db.insert(images).values({
    ...saved, id: `${ctx.episode.id}-credits`, episodeId: ctx.episode.id,
    originalName: "credits.png", sortOrder: 0, role: "pre-credits", createdAt: 1, updatedAt: 1,
  }).run();
  const box = await contentBBox(margin);
  assert.ok(box.w < 100 || box.h < 80, "sample has croppable margins");
  await autoCropPages(ctx);
  const after = (await listImages(ctx.episode.id))[0];
  assert.equal(after.width, 100);
  assert.equal(after.height, 80);
  assert.equal(after.role, "pre-credits");
});

after(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

test("the web viewer adds series credits the chapter has not added itself", () => {
	const credit = { hash: "a".repeat(64), filename: "c.png", originalName: "c.png", width: 10, height: 20 };
	const page = { id: "p1", episodeId: "e1", role: "page", width: 40, height: 60 } as any;
	const ownPost = { id: "p2", episodeId: "e1", role: "post-credits" } as any;
	const s = { credits: { pre: credit, post: credit }, createdAt: 1, updatedAt: 2 };
	const shown = withSeriesCreditImages([page, ownPost], s, "e1");
	assert.deepEqual(shown.map((img) => img.id), ["series-credit:pre:e1", "p1", "p2"]);
	assert.equal(shown[0].role, "pre-credits");
	assert.deepEqual([shown[0].width, shown[0].height], [40, 80], "credits match the story page width");
	assert.deepEqual(parseSeriesCreditImageId(shown[0].id), { kind: "pre", episodeId: "e1" });
	assert.equal(parseSeriesCreditImageId("p1"), null);
	assert.deepEqual(withSeriesCreditImages([page], { ...s, credits: {} }, "e1"), [page]);
});
