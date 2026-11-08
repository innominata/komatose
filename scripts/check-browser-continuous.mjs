/**
 * Continuous view: outside Prepare, a long-strip chapter shows every page in one scrolling
 * column. Scrolling a page to the middle, or clicking it, makes it the current page.
 */
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
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const shot = process.env.SCAN_TEST_SHOTS;

const scroller = page.locator(".canvas-scroll");
const counter = page.locator('[data-find="viewbar"] .vb-txt').first();
/** Scrolls so the given fraction down page n sits in the middle of the view. */
const centrePage = (id, at = 0.5) => page.evaluate(([id, at]) => {
  const s = document.querySelector(".canvas-scroll");
  const el = s.querySelector(`:scope > [data-page-id="${id}"]`);
  const r = el.getBoundingClientRect(), b = s.getBoundingClientRect();
  s.scrollTop += r.top + r.height * at - (b.top + b.height / 2);
}, [id, at]);
/** The current page covers the middle of the view. */
const activeCoversMiddle = () => page.evaluate(() => {
  const s = document.querySelector(".canvas-scroll"), el = s.querySelector("[data-active-page]");
  const r = el.getBoundingClientRect(), b = s.getBoundingClientRect(), mid = b.top + b.height / 2;
  return r.top <= mid && r.bottom > mid;
});

try {
  // The fixture chapter has two pages; add three tall strip pages, each a different grey.
  for (const shade of [90, 150, 210]) {
    const upload = await context.request.post(`${api}/images`, { multipart: {
      files: { name: `strip-${shade}.png`, mimeType: "image/png",
        buffer: await sharp({ create: { width: 800, height: 2400, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer() },
    } });
    expect(upload.ok()).toBeTruthy();
  }
  const before = await state();
  const mode = await context.request.post(`${api}/workflow`, { data: { action: "preferences", scope: "series",
    expectedRevision: before.seriesDefaults.revision, data: { pageMode: "strip" } } });
  expect(mode.ok()).toBeTruthy();
  const images = before.images;
  const n = images.length;
  expect(n).toBeGreaterThan(3);

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  const nav = page.getByRole("navigation", { name: "Chapter workflow" });
  await nav.waitFor();
  const goStep = async name => {
    const button = nav.getByRole("button", { name, exact: true });
    await expect(async () => { await button.click(); await expect(button).toHaveClass(/active/); }).toPass();
  };
  await goStep("Clean");
  await page.getByRole("complementary", { name: "Pages in chapter order" })
    .getByRole("button", { name: "Open page 1", exact: true }).click();

  // 1. Every page is in the column, the first one current, and the view opens on it.
  await expect(scroller).toHaveClass(/continuous/);
  await expect(scroller.locator(":scope > [data-page-id]")).toHaveCount(n);
  await expect(scroller.locator("[data-active-page]")).toHaveAttribute("data-page-id", images[0].id);
  await expect(counter).toHaveText(`Page 1 / ${n}`);
  await expect.poll(activeCoversMiddle).toBe(true);
  // Nearby previews draw their artwork; far ones stay blank placeholders.
  await expect(scroller.locator(`[data-page-id="${images[1].id}"] img.artwork`)).toHaveCount(1);
  if (shot) await page.screenshot({ path: `${shot}/continuous-clean.png` });

  // Wheel scrolling moves the view smoothly through the pages, down and back up. Chrome's
  // scroll anchoring used to follow the reused current-page element and leap a page on at
  // every change of page, racing to the end of the chapter.
  {
    const sb = await scroller.boundingBox();
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    let prev = await scroller.evaluate(s => s.scrollTop);
    const seen = new Set();
    for (let i = 0; i < 50; i++) {
      await page.mouse.wheel(0, i < 30 ? 250 : -250);
      await page.waitForTimeout(80);
      const now = await scroller.evaluate(s => s.scrollTop);
      expect(Math.abs(now - prev), `wheel step ${i} moved the view ${now - prev}px`).toBeLessThanOrEqual(260);
      prev = now;
      seen.add(await counter.textContent());
    }
    expect(seen.size).toBeGreaterThan(2);
  }

  // 2. Scrolling another page to the middle makes it current, without moving the view.
  await centrePage(images[2].id);
  await expect(counter).toHaveText(`Page 3 / ${n}`);
  await expect(scroller.locator("[data-active-page]")).toHaveAttribute("data-page-id", images[2].id);
  const top = await scroller.evaluate(s => s.scrollTop);
  await page.waitForTimeout(300);
  expect(Math.abs(await scroller.evaluate(s => s.scrollTop) - top)).toBeLessThan(2);
  await expect(scroller.locator(":scope > [data-page-id]")).toHaveCount(n);

  // 3. The page buttons scroll the column to the page they open.
  await page.locator('[data-find="viewbar"]').getByRole("button", { name: "Next page", exact: true }).click();
  await expect(counter).toHaveText(`Page 4 / ${n}`);
  await expect.poll(activeCoversMiddle).toBe(true);

  // The mask brush paints the current page; its draft stays with that page when the view
  // scrolls on to the next one and back.
  // A newly uploaded page is prepared the first time it opens; the editor waits for that.
  await expect.poll(async () => {
    const st = await state();
    const img = st.images.find(i => i.id === images[3].id);
    return st.pages[img.id]?.data.preparedAt === img.updatedAt;
  }, { timeout: 30000 }).toBe(true);
  await page.waitForTimeout(500);
  const active = scroller.locator("[data-active-page]");
  const ab = await active.boundingBox();
  const sb = await scroller.boundingBox();
  const y0 = sb.y + sb.height / 2 - 40;
  await page.mouse.move(ab.x + ab.width * 0.3, y0);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(ab.x + ab.width * (0.3 + i * 0.05), y0 + i * 10);
  await page.mouse.up();
  await expect(active.locator("#removal-mask polyline")).toHaveCount(1);
  await expect(counter).toHaveText(`Page 4 / ${n}`);
  await centrePage(images[4].id);
  await expect(counter).toHaveText(`Page 5 / ${n}`);
  await expect(scroller.locator("[data-active-page] #removal-mask polyline")).toHaveCount(0);
  await centrePage(images[3].id);
  await expect(counter).toHaveText(`Page 4 / ${n}`);
  await expect(scroller.locator("[data-active-page] #removal-mask polyline")).toHaveCount(1);

  // 4. Translate: clicking a region on a preview page opens that page and selects the region.
  await goStep("Translate");
  await expect(scroller).toHaveClass(/continuous/);
  const target = before.lines.filter(l => l.imageId === images[1].id && l.x != null && l.sourceState !== "ignored")
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  expect(target).toBeTruthy();
  await centrePage(images[1].id, (target.y + target.h / 2));
  await expect(counter).toHaveText(`Page 2 / ${n}`);
  await centrePage(images[0].id, 0.9);
  await expect(counter).toHaveText(`Page 1 / ${n}`);
  const preview = scroller.locator(`[data-page-id="${images[1].id}"]`);
  await expect(preview).not.toHaveAttribute("data-active-page");
  const box = await preview.boundingBox();
  await page.mouse.click(box.x + (target.x + target.w / 2) * box.width, box.y + (target.y + target.h / 2) * box.height);
  await expect(counter).toHaveText(`Page 2 / ${n}`);
  await expect(page.locator(`#region-card-${target.id}`)).toHaveClass(/selected/);
  if (shot) await page.screenshot({ path: `${shot}/continuous-translate.png` });

  // 5. The Scroll button switches to one page at a time, and the choice is remembered.
  const toggle = page.locator('[data-find="view-continuous"]');
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(scroller).not.toHaveClass(/continuous/);
  await expect(scroller.locator(".canvas-page")).toHaveCount(1);
  await page.reload();
  await nav.waitFor();
  await goStep("Translate");
  await expect(page.locator('[data-find="view-continuous"]')).toHaveAttribute("aria-pressed", "false");
  await expect(scroller.locator(".canvas-page")).toHaveCount(1);
  await page.locator('[data-find="view-continuous"]').click();
  await expect(scroller).toHaveClass(/continuous/);

  // 6. Prepare keeps its own strip editor.
  await goStep("Prepare");
  await expect(page.locator('[data-find="view-continuous"]')).toHaveCount(0);

  expect(errors).toEqual([]);
  console.log("Browser continuous view passed: every page scrolls smoothly in one column outside Prepare, the page in the middle or the one clicked becomes current, clicking a preview region selects it, the mask brush paints the current page and its draft stays with that page, and the view can be switched off and remembered.");
} finally {
  await browser.close();
}
