import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, "chrome-linux64/chrome"))
    .find(p => existsSync(p)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const confirmations = [];
page.on('dialog', async dialog => {
  confirmations.push(dialog.message());
  await dialog.accept();
});
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const previewAfter = async action => {
  const response = page.waitForResponse(r => r.url() === `${api}/pages` && r.request().postDataJSON()?.op === "reslice-preview");
  await action();
  const data = await (await response).json();
  await expect(page.locator(".reslice-hint")).toContainText(`Target slice height: ${data.maxHeight}px`);
  return data;
};

try {
  // Synthetic long-form artwork stays inside the isolated browser fixture.
  const bytes = await sharp({ create: { width: 800, height: 4800, channels: 3,
    background: { r: 40, g: 80, b: 120 } } }).png().toBuffer();
  const upload = await context.request.post(`${api}/images`, { multipart: {
    files: { name: "long-strip.png", mimeType: "image/png", buffer: bytes },
  } });
  expect(upload.ok()).toBeTruthy();
  const before = await state();
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.getByRole("complementary", { name: "Pages in chapter order" })
    .getByRole("button", { name: `Open page ${before.images.length}`, exact: true }).click();
  const size = page.getByRole("combobox", { name: "Strip slice size" });
  await expect(size).toHaveValue("pages");
  let preview = await previewAfter(() => page.getByRole("toolbar", { name: "Tools" })
    .getByRole("button", { name: "Reslice strips", exact: true }).click());
  expect(preview.maxHeight).toBe(1200);
  expect(preview.forced).toEqual([]);
  expect(preview.manualRequired).toBe(false);
  expect(preview.cuts.length).toBeGreaterThan(2);

  preview = await previewAfter(() => size.selectOption("custom"));
  expect(preview.maxHeight).toBe(2048);
  const height = page.getByRole("spinbutton", { name: "Target slice height" });
  await height.fill("199");
  await expect(page.getByRole("button", { name: "Split strips", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply reslice cuts", exact: true })).toBeDisabled();
  const rejected = await context.request.post(`${api}/pages`, { data: { op: "reslice", sizing: "custom", maxHeight: 199 } });
  expect(rejected.status()).toBe(400);
  preview = await previewAfter(() => height.fill("1200"));
  expect(preview.maxHeight).toBe(1200);
  preview = await previewAfter(() => size.selectOption("strips"));
  expect(preview.cuts).toEqual([]);
  // An explicit empty cut list is a valid request to combine this window.
  await expect(page.getByRole("button", { name: "Apply reslice cuts", exact: true })).toBeEnabled();
  preview = await previewAfter(() => size.selectOption("pages"));
  await page.screenshot({ path: "/tmp/komatose-reslice-prepare.png" });

  // Add a cut on the visible selected-page band and apply the edited preview.
  const canvas = page.locator(".canvas-page");
  const box = await canvas.boundingBox();
  const scroller = await page.locator(".canvas-scroll").boundingBox();
  const current = preview.pages.find(p => p.id === before.images.at(-1).id);
  const clickY = box.y + (current.top + 400) / preview.height * box.height;
  expect(clickY).toBeGreaterThan(scroller.y);
  expect(clickY).toBeLessThan(scroller.y + scroller.height);
  await page.mouse.click(box.x + box.width * 0.5, clickY);
  await expect(page.locator(".reslice-cut")).toHaveCount(preview.cuts.length + 1);
  const editedCuts = await page.locator(".reslice-cut").evaluateAll((cuts, height) =>
    cuts.map(el => Math.round(parseFloat(el.style.top) / 100 * height)), preview.height);
  const request = page.waitForRequest(r => r.url() === `${api}/pages` && r.postDataJSON()?.op === "reslice");
  await page.getByRole("button", { name: "Apply reslice cuts", exact: true }).click();
  const body = (await request).postDataJSON();
  expect(confirmations.at(-1)).toContain('using the previewed cuts');
  expect(body.sizing).toBe("pages");
  expect(body.imageIds).toEqual(preview.imageIds);
  expect(body.cuts).toEqual(editedCuts);
  await expect.poll(async () => {
    const job = (await state()).jobs.find(j => j.kind === "reslice");
    if (job?.state === "failed") throw new Error(job.error || JSON.stringify(job.progress));
    return job?.state;
  }, { timeout: 30000 }).toBe("completed");
  const split = await state();
  const kept = before.images.filter(img => !preview.imageIds.includes(img.id));
  const created = split.images.filter(img => !kept.some(p => p.id === img.id));
  expect(created.length).toBe(editedCuts.length + 1);
  expect(created.every(img => img.width === 800 && img.height <= 1320)).toBeTruthy();
  expect(created.reduce((total, img) => total + img.height, 0)).toBe(preview.height);
  const undoDetails = await (await context.request.get(`${api}/pages`)).json();
  expect(undoDetails.undo.confirmation).toContain(`Remove ${created.length} sliced pages`);
  const undo = await context.request.post(`${api}/pages`, { data: { op: "undo", undoToken: undoDetails.undo.token } });
  expect(undo.ok()).toBeTruthy();
  expect((await state()).images.map(img => img.id)).toEqual(before.images.map(img => img.id));

  // The whole-chapter action carries the same size choice into its saved job.
  await page.reload();
  await page.getByRole("button", { name: "Split strips", exact: true }).click();
  await expect.poll(async () => (await state()).jobs.filter(j => j.kind === "reslice" && j.state === "completed").length,
    { timeout: 30000 }).toBe(2);
  const auto = await state();
  expect(auto.images.every(img => img.width === 800 && img.height <= 1320)).toBeTruthy();
  expect(auto.jobs.find(j => j.kind === "reslice").payload.sizing).toBe("pages");
  // At a 1.5x target, use a later 2.5x solid gap and continue with normal pages.
  const late = Buffer.alloc(800 * 5000 * 3, 40);
  for (let y = 0; y < 5000; y++) late[(y * 800 + 799) * 3] = 220;
  for (const top of [1990, 3190, 4390]) late.fill(255, top * 800 * 3, (top + 20) * 800 * 3);
  const lateUpload = await context.request.post(`${api}/images`, { multipart: {
    files: { name: "late-gap-strip.png", mimeType: "image/png", buffer:
      await sharp(late, { raw: { width: 800, height: 5000, channels: 3 } }).png().toBuffer() },
  } });
  expect(lateUpload.ok()).toBeTruthy();
  const lateBefore = await state();
  const lateStart = await context.request.post(`${api}/pages`, { data: {
    op: "reslice", sizing: "pages", imageIds: [lateBefore.images.at(-1).id],
  } });
  const { jobId: lateJobId } = await lateStart.json();
  await expect.poll(async () => (await state()).jobs.find(j => j.id === lateJobId)?.state,
    { timeout: 30000 }).toBe("completed");
  const lateState = await state();
  const latePages = lateState.images.filter(i => !lateBefore.images.some(p => p.id === i.id));
  expect(latePages.map(i => i.height)).toEqual([2000, 1200, 1200, 600]);
  expect(lateState.jobs.find(j => j.id === lateJobId).progress.manualSlices)
    .toEqual([{ imageId: latePages[0].id, top: 0, bottom: 2000, height: 2000 }]);
  expect(lateState.jobs.find(j => j.id === lateJobId).progress.forced).toEqual([]);
  // A strip with no solid gap stays intact while the chapter's safe splits finish.
  const noGap = Buffer.alloc(800 * 3600 * 3, 40);
  for (let y = 0; y < 3600; y++) noGap[(y * 800 + 799) * 3] = 220;
  const noGapUpload = await context.request.post(`${api}/images`, { multipart: {
    files: { name: "manual-strip.png", mimeType: "image/png", buffer:
      await sharp(noGap, { raw: { width: 800, height: 3600, channels: 3 } }).png().toBuffer() },
  } });
  expect(noGapUpload.ok()).toBeTruthy();
  const unsplit = await state();
  await page.reload();
  await page.getByRole("button", { name: "Split strips", exact: true }).click();
  await expect.poll(async () => (await state()).jobs.find(j => j.kind === "reslice")?.progress?.manualRequired,
    { timeout: 30000 }).toBe(true);
  const finished = await state();
  const warningJob = finished.jobs.find(j => j.kind === "reslice");
  expect(warningJob.state).toBe("completed");
  expect(warningJob.error).toBeFalsy();
  expect(warningJob.progress.message).toContain("oversized page(s) need manual splitting");
  expect(warningJob.progress.forced).toEqual([]);
  expect(finished.images.reduce((sum, i) => sum + i.height, 0))
    .toBe(unsplit.images.reduce((sum, i) => sum + i.height, 0));
  expect(finished.lines.map(l => [l.id, l.body, l.source])).toEqual(unsplit.lines.map(l => [l.id, l.body, l.source]));
  expect(finished.lines.every(l => !l.imageId || finished.images.some(i => i.id === l.imageId))).toBeTruthy();
  const oversized = finished.images.filter(i => i.height > 1320);
  expect(oversized.length).toBeGreaterThan(0);
  expect(warningJob.progress.manualSlices.map(s => s.imageId)).toEqual(oversized.map(i => i.id));
  expect(warningJob.progress.manualImageId).toBe(oversized[0].id);
  preview = await previewAfter(() => page.getByRole("button", { name: "Split manually", exact: true }).click());
  expect(preview.manualRequired).toBe(true);
  expect(preview.forced).toEqual([]);
  const selectedIndex = finished.images.findIndex(i => i.id === warningJob.progress.manualImageId);
  await expect(page.locator(".reslice-current-band span")).toHaveText(`This page · ${selectedIndex + 1}`);
  await expect(page.getByRole("button", { name: "Apply reslice cuts", exact: true })).toBeEnabled();
  await expect(page.getByText("oversized page(s) need manual splitting.", { exact: false })).toBeVisible();
  await page.screenshot({ path: "/tmp/komatose-reslice-manual.png" });
  expect(errors).toEqual([]);
  console.log("Browser reslice passed: safe page/custom/strip cuts, validation, manual editing, real slicing, undo, late safe gaps, per-page manual warnings, and unsplittable art without data loss.");
} finally {
  await browser.close();
}
