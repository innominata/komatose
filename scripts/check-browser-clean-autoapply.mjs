/** Fill rectangle, auto-apply settings, compare with unsaved strokes, and Auto-fit's reset prompt. */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
// The fixture root has no cleaning worker. This check runs real flat fills, so it borrows
// the repository's worker and Python environment; the worker starts on first use.
const fixtureRoot = dirname(process.env.SCAN_TEST_DATA || "");
for (const name of ["ocr", ".venv-workflow"])
  if (process.env.SCAN_TEST_DATA && existsSync(resolve(name)) && !existsSync(join(fixtureRoot, name)))
    symlinkSync(resolve(name), join(fixtureRoot, name));
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const dialogs = [];
page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const pageData = async id => (await state()).pages[id].data;
const palette = page.getByRole("toolbar", { name: "Tools" });
const canvas = page.getByRole("application", { name: "Page regions and cleaning mask" });

/** Drag across the canvas between page fractions. */
/** Opening Clean briefly marks the studio busy; repeat the gesture until it takes. */
async function dragUntil(action, from, to) {
  await expect(async () => {
    const sent = page.waitForRequest(r => r.url() === `${api}/workflow` && r.postDataJSON()?.action === action, { timeout: 2000 });
    await drag(from, to);
    await sent;
  }).toPass({ timeout: 20000 });
}
async function drag(from, to) {
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 6 });
  await page.mouse.up();
}

try {
  const before = await state();
  const imageId = before.images[0].id;
  const region = before.lines.filter(l => l.imageId === imageId && l.x != null).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.locator(".pages > button").first().click();
  const clean = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Clean", exact: true });
  await expect(async () => { await clean.click(); await expect(clean).toHaveClass(/active/); }).toPass();
  await canvas.waitFor();

  // 1. Fill rectangle applies a sampled flat fill at once and leaves the mask alone.
  const start = await pageData(imageId);
  await palette.getByRole("button", { name: "Fill rectangle (sampled flat fill) (Q)", exact: true }).click();
  await dragUntil("rect-fill", [0.36, 0.06], [0.46, 0.11]);
  await expect.poll(async () => (await pageData(imageId)).cleanBase, { timeout: 30000 }).not.toBe(start.cleanBase);
  const filled = await pageData(imageId);
  expect(filled.cleanMethod).toBe("flat");
  expect(filled.cleaned).toBeFalsy();
  expect(filled.mask).toBe(start.mask);
  // ...and Undo steps back.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await pageData(imageId)).cleanBase, { timeout: 15000 }).toBe(start.cleanBase);

  // 1b. Bubble fill clicks queue: a click while one is filling waits its turn instead of failing.
  const bubbles = before.lines.filter(l => l.imageId === imageId && l.x != null).sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 2);
  const fills = [];
  page.on("response", r => { if (r.url() === `${api}/workflow` && r.request().postDataJSON()?.action === "bubble-fill") fills.push(r.status()); });
  const revisionBeforeFills = (await state()).pages[imageId].revision;
  // Hold the first fill briefly so the second click certainly lands while it runs.
  let held = false;
  await page.route(`${api}/workflow`, async route => {
    if (!held && route.request().method() === "POST" && route.request().postDataJSON()?.action === "bubble-fill") {
      held = true;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await palette.getByRole("button", { name: "Fill speech bubble (F)", exact: true }).click();
  const area = await canvas.boundingBox();
  for (const b of bubbles)
    await page.mouse.click(area.x + (b.x + b.w / 2) * area.width, area.y + (b.y + b.h / 2) * area.height);
  await expect(page.getByText(/Queued\. 1 bubble fill waiting\./)).toBeVisible();
  // A fill sent with a revision the previous fill moved on is retried once by the studio (409, then 200).
  await expect.poll(() => fills.filter(status => status === 200).length, { timeout: 30000 }).toBe(2);
  expect(fills.every(status => status === 200 || status === 409)).toBe(true);
  await expect(page.getByText("Filled 2 speech bubbles", { exact: false })).toBeVisible();
  await page.unroute(`${api}/workflow`);
  // Each queued click saved its own edit. (The fixture's bubbles are already blank, so the
  // pixels match; the revisions show both fills ran.)
  expect((await state()).pages[imageId].revision).toBe(revisionBeforeFills + 2);

  // 2. The Cleaning settings tab saves auto-apply choices for this user.
  await page.locator('[data-find="settings"]').click();
  await page.locator('[data-find="set-clean"]').click();
  await page.locator('[data-find="clean-settings"]').getByRole("checkbox", { name: "Sampled flat fill" }).check();
  await expect.poll(async () => (await (await context.request.get(`${base}/api/me/settings`)).json()).autoApplyClean).toContain("flat");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();

  // 3. Cleaning with an auto-apply method keeps the result as soon as it finishes.
  await palette.getByRole("button", { name: "Mask brush (B)", exact: true }).click();
  await drag([region.x + region.w * 0.3, region.y + region.h * 0.5], [region.x + region.w * 0.7, region.y + region.h * 0.5]);
  const cleansBefore = (await state()).jobs.filter(j => j.kind === "clean").length;
  await page.locator('[data-find="clean-method"]').getByRole("button", { name: "Sampled flat fill", exact: true }).click();
  // Applied: the run finished, nothing waits for Keep result, and the mask was used up.
  await expect.poll(async () => {
    const s = await state(), data = s.pages[imageId].data;
    const job = s.jobs.filter(j => j.kind === "clean");
    return job.length > cleansBefore && job[0].state === "completed" && !data.cleaned && !data.mask && !!data.cleanBase;
  }, { timeout: 60000 }).toBe(true);

  // 4. Compare methods saves and approves unsaved strokes, then opens.
  await palette.getByRole("button", { name: "Mask brush (B)", exact: true }).click();
  await drag([region.x + region.w * 0.3, region.y + region.h * 0.4], [region.x + region.w * 0.7, region.y + region.h * 0.4]);
  await palette.getByRole("button", { name: "Select (V)", exact: true }).click();
  await page.getByRole("button", { name: /^Region 1(,.*)?$/ }).dispatchEvent("click");
  await page.getByRole("button", { name: "Compare methods on this region…" }).click();
  await expect(page.locator("#cc-title")).toHaveText(/Compare cleaning · region/, { timeout: 30000 });
  const masked = await pageData(imageId);
  expect(masked.mask).toBeTruthy();
  expect(masked.maskApproved).toBe(true);
  await page.screenshot({ path: "/tmp/komatose-clean-autoapply.png" });
  await page.locator("dialog.cc").getByRole("button", { name: /^(Cancel|Close)/ }).click();

  // 5. Auto-fit warns that it resets region styles, then resets and refits.
  const typeset = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Typeset", exact: true });
  await expect(async () => { await typeset.click(); await expect(typeset).toHaveClass(/active/); }).toPass();
  const reset = page.waitForRequest(r => r.url() === `${api}/workflow` && r.postDataJSON()?.action === "reset-styles");
  await page.locator('[data-find="autofit-all"]').click();
  expect((await reset).postDataJSON()).toMatchObject({ scope: "page", imageId });
  expect(dialogs.at(-1)).toMatch(/resets the text style of every unlocked region on this page to the series defaults/);
  await page.waitForRequest(r => r.url() === `${api}/workflow` && r.postDataJSON()?.action === "typeset-all");
  expect(errors).toEqual([]);
  console.log("Browser clean auto-apply passed: Fill rectangle applies and undoes, bubble fills queue, Cleaning settings save, auto-apply keeps a flat fill, Compare approves unsaved strokes, and Auto-fit resets styles after warning.");
} finally {
  await browser.close();
}
