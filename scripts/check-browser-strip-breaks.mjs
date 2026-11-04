/** Long-strip break editor: synthetic artwork in the isolated fixture; no model calls. */
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
page.on("dialog", async dialog => { confirmations.push(dialog.message()); await dialog.accept(); });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const isLayout = r => r.url() === `${api}/pages` && r.request().postDataJSON()?.op === "strip-layout";

/** Scroll a strip row into the middle of the canvas and return its screen position. */
async function stripPoint(y, height) {
  return page.evaluate(([y, height]) => {
    const scroller = document.querySelector(".strip-scroll"), strip = document.querySelector(".strip");
    const box = () => strip.getBoundingClientRect();
    scroller.scrollTop += box().top + (y / height) * box().height - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
    const b = box();
    return { x: b.left + b.width / 2, y: b.top + (y / height) * b.height };
  }, [y, height]);
}
const breakValues = () => page.locator('.break[role="slider"]').evaluateAll(els => els.map(el => Number(el.getAttribute("aria-valuenow"))));

try {
  // Flat colour is a solid band, so give every row a contrasting pixel, then paint three
  // white gutters centred on 1200, 2400 and 3600.
  const W = 800, H = 4800, raw = Buffer.alloc(W * H * 3, 40);
  for (let y = 0; y < H; y++) raw[(y * W + 799) * 3] = 220;
  for (const top of [1190, 2390, 3590]) raw.fill(255, top * W * 3, (top + 20) * W * 3);
  const upload = await context.request.post(`${api}/images`, { multipart: {
    files: { name: "long-strip.png", mimeType: "image/png",
      buffer: await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() },
  } });
  expect(upload.ok()).toBeTruthy();
  const before = await state();
  const mode = await context.request.post(`${api}/workflow`, { data: { action: "preferences", scope: "series",
    expectedRevision: before.seriesDefaults.revision, data: { pageMode: "strip" } } });
  expect(mode.ok()).toBeTruthy();
  const strip = before.images.at(-1);

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  const loaded = page.waitForResponse(isLayout).then(r => r.json());
  await page.getByRole("complementary", { name: "Pages in chapter order" })
    .getByRole("button", { name: `Open page ${before.images.length}`, exact: true }).click();
  let layout = await loaded;
  const top = layout.pages.find(p => p.id === strip.id).top;
  await expect(page.locator(".strip-page")).toHaveCount(layout.pages.length);
  await expect(page.locator('.break[role="slider"]')).toHaveCount(layout.pages.length - 1);
  await expect(page.locator('[data-find="floating-reslice-strip"]')).toHaveCount(0);
  for (const y of [1200, 2400, 3600]) expect(layout.bands.some(b => b.top <= top + y && b.bottom > top + y)).toBeTruthy();
  await stripPoint(layout.pages[1].top, layout.height);
  await page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Add page break (A)" }).click();
  await page.screenshot({ path: "/tmp/komatose-strip-breaks-boundary.png" });
  await page.keyboard.press("Escape");

  // Split strips only proposes breaks; no job starts until Reslice strip.
  await page.getByRole("combobox", { name: "Strip slice size" }).selectOption("pages");
  layout = await page.waitForResponse(isLayout).then(r => r.json());
  const jobsBefore = (await state()).jobs.filter(j => j.kind === "reslice").length;
  await page.getByRole("button", { name: "Split strips", exact: true }).click();
  await expect.poll(breakValues).toEqual(layout.autoCuts);
  await expect(page.locator('[data-find="floating-reslice-strip"]')).toBeVisible();
  expect((await state()).jobs.filter(j => j.kind === "reslice").length).toBe(jobsBefore);
  await page.screenshot({ path: "/tmp/komatose-strip-breaks-split.png" });
  await page.getByRole("button", { name: "Reset page breaks" }).click();
  await expect(page.locator('[data-find="floating-reslice-strip"]')).toHaveCount(0);

  // The + tool adds a break that snaps into the nearby gutter.
  await page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Add page break (A)" }).click();
  let p = await stripPoint(top + 1210, layout.height);
  await page.mouse.click(p.x, p.y);
  await expect.poll(breakValues).toContain(top + 1200);
  // Delete removes the focused break.
  await page.locator(`.break[aria-valuenow="${top + 1200}"]`).focus();
  await page.keyboard.press("Delete");
  await expect.poll(breakValues).not.toContain(top + 1200);
  p = await stripPoint(top + 1200, layout.height);
  await page.mouse.click(p.x, p.y);
  await expect.poll(breakValues).toContain(top + 1200);

  // Drag it down to the next gutter, in Select mode.
  await page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Select (V)" }).click();
  p = await stripPoint(top + 1200, layout.height);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  const to = await page.evaluate(([y, height]) => {
    const b = document.querySelector(".strip").getBoundingClientRect();
    return b.top + (y / height) * b.height;
  }, [top + 2395, layout.height]);
  await page.mouse.move(p.x, (p.y + to) / 2, { steps: 4 });
  await page.mouse.move(p.x, to, { steps: 4 });
  await page.mouse.up();
  await expect.poll(breakValues).toContain(top + 2400);
  expect(await breakValues()).not.toContain(top + 1200);
  await expect(page.locator(".strip-summary")).toContainText(`${layout.pages.length} → ${layout.pages.length + 1} pages`);
  await page.screenshot({ path: "/tmp/komatose-strip-breaks-edit.png" });

  const sent = page.waitForRequest(r => r.url() === `${api}/pages` && r.postDataJSON()?.op === "apply-breaks");
  await page.getByRole("button", { name: "Reslice strip", exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(confirmations.at(-1)).toContain("Apply the edited page breaks");
  expect(body.breaks).toEqual([...layout.pages.slice(1).map(pg => pg.top), top + 2400]);
  await expect.poll(async () => {
    const job = (await state()).jobs.find(j => j.kind === "reslice");
    if (job?.state === "failed") throw new Error(job.error || JSON.stringify(job.progress));
    return job?.state;
  }, { timeout: 30000 }).toBe("completed");
  const after = await state();
  expect(after.images.length).toBe(before.images.length + 1);
  expect(after.images.slice(0, -2).map(i => [i.id, i.updatedAt])).toEqual(before.images.slice(0, -1).map(i => [i.id, i.updatedAt]));
  expect(after.images.at(-2).id).toBe(strip.id);
  expect(after.images.slice(-2).map(i => i.height)).toEqual([2400, 2400]);
  // The editor reloads onto the new pages with no pending edits.
  await expect(page.locator('.break[role="slider"]')).toHaveCount(after.images.length - 1);
  await expect(page.locator('[data-find="floating-reslice-strip"]')).toHaveCount(0);

  const undoDetails = await (await context.request.get(`${api}/pages`)).json();
  expect(undoDetails.undo.confirmation).toContain("Restore the previous page boundaries");
  const undo = await context.request.post(`${api}/pages`, { data: { op: "undo", undoToken: undoDetails.undo.token } });
  expect(undo.ok()).toBeTruthy();
  expect((await state()).images.map(i => [i.id, i.height])).toEqual(before.images.map(i => [i.id, i.height]));
  await expect(page.locator('.break[role="slider"]')).toHaveCount(before.images.length - 1);
  expect(errors).toEqual([]);
  console.log("Browser strip breaks passed: whole-chapter strip, Split strips proposal, add/snap/delete/drag, Reset, apply as a job keeping untouched pages, and undo.");
} finally {
  await browser.close();
}
