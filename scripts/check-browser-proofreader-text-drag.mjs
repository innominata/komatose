/** Drag selected text out of a saved proofreader reply onto a canvas region and a region card, with real mouse moves. No model calls. */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
const root = process.env.SCAN_TEST_DATA;
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
page.on("console", m => { if (m.type() === "error") console.log("console:", m.text()); });
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const lineOf = async id => (await state()).lines.find(l => l.id === id);

/** Select `text` inside `container` and drag the selection to (x, y) with the real mouse. */
async function dragSelection(container, text, x, y) {
  const start = await container.evaluate((el, wanted) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(wanted);
      if (at < 0) continue;
      node.parentElement.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.setStart(node, at); range.setEnd(node, at + wanted.length);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      const r = range.getClientRects()[0];
      return { x: r.left + Math.min(r.width / 2, 20), y: r.top + r.height / 2 };
    }
    return null;
  }, text);
  if (!start) throw new Error(`"${text}" not found in the reply`);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 5, { steps: 4 });
  // As slowly as a person drags, so studio refreshes land mid-drag.
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(start.x + 20 + (x - start.x - 20) * i / 8, start.y + 5 + (y - start.y - 5) * i / 8);
    await page.waitForTimeout(500);
  }
  await page.mouse.up();
}

try {
  const before = await state();
  const imageId = before.images[0].id;
  const db = new Database(join(root, "scan.db"));
  db.prepare(`INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at)
    VALUES('drag-raw','fixture-episode','page-proofread','completed',?,?,?,?)`).run(
    JSON.stringify({ imageId, mode: "raw" }),
    JSON.stringify({ critique: "Panel 1 reads ここで待ってて and the English is Wait right here. Panel 2 reads 여기서 기다려 or Stay put." }),
    Date.now() - 60_000, Date.now() - 60_000);
  db.prepare(`INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at)
    VALUES('drag-english','fixture-episode','page-proofread','completed',?,?,?,?)`).run(
    JSON.stringify({ imageId }),
    JSON.stringify({ critique: "**Region 1** should read *Hold on a sec.* and region 2 could be Over here, quick!" }),
    Date.now() - 30_000, Date.now() - 30_000);
  db.close();
  const lines = before.lines.filter(l => l.imageId === imageId && l.x != null && l.sourceState !== "ignored").sort((a, b) => a.sortOrder - b.sortOrder);
  const [first, second] = lines;

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  const translate = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true });
  await expect(async () => { await translate.click(); await expect(translate).toHaveClass(/active/); }).toPass();
  await page.getByRole("complementary", { name: "Pages in chapter order" }).getByRole("button", { name: "Open page 1", exact: true }).click();
  await page.locator('[data-find="proofread-raw"]').click();
  const reply = page.locator(".saved-proofread-window");
  await expect(reply).toContainText("ここで待ってて");
  // Park the window in the lower left, clear of region 1 and the right panel.
  await page.evaluate(() => { const w = document.querySelector('.saved-proofread-window'); Object.assign(w.style, { left: '10px', top: '600px', width: '560px', height: '300px' }); });

  // Japanese dragged onto a canvas region sets its source.
  const canvas = await page.locator(".canvas-page").first().boundingBox();
  await dragSelection(reply.locator(".body"), "ここで待ってて", canvas.x + (first.x + first.w / 2) * canvas.width, canvas.y + (first.y + first.h / 2) * canvas.height);
  await expect.poll(async () => (await lineOf(first.id)).source, { timeout: 10000 }).toBe("ここで待ってて");

  // English dragged onto a region card (outside its text boxes) sets its English.
  const card = page.locator(`#region-card-${first.id} header`);
  const cb = await card.boundingBox();
  await dragSelection(reply.locator(".body"), "Wait right here", cb.x + 12, cb.y + cb.height / 2);
  await expect.poll(async () => (await lineOf(first.id)).body, { timeout: 10000 }).toBe("Wait right here");
  // Review: Korean onto the second region on the canvas, English onto its card.
  const review = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Review", exact: true });
  await expect(async () => { await review.click(); await expect(review).toHaveClass(/active/); }).toPass();
  if (!(await reply.isVisible())) { await page.locator('[data-find="proofread-raw"]').click(); }
  await page.evaluate(() => { const w = document.querySelector('.saved-proofread-window'); Object.assign(w.style, { left: '10px', top: '600px', width: '560px', height: '300px' }); });
  const canvas2 = await page.locator(".canvas-page").first().boundingBox();
  await dragSelection(reply.locator(".body"), "여기서 기다려", canvas2.x + (second.x + second.w / 2) * canvas2.width, canvas2.y + (second.y + second.h / 2) * canvas2.height);
  await expect.poll(async () => (await lineOf(second.id)).source, { timeout: 10000 }).toBe("여기서 기다려");
  const card2 = page.locator(`#region-card-${second.id} header`);
  await card2.waitFor();
  const cb2 = await card2.boundingBox();
  await dragSelection(reply.locator(".body"), "Stay put", cb2.x + 12, cb2.y + cb2.height / 2);
  await expect.poll(async () => (await lineOf(second.id)).body, { timeout: 10000 }).toBe("Stay put");
  // The live Page proofreader window (Proofread English), opened from the Jobs bar.
  await page.locator(".saved-proofread-window header button").last().click().catch(() => {});
  await expect(async () => {
    for (const b of await page.getByRole("button", { name: "Open critique" }).all()) {
      if (await page.locator(".page-proofread-window").filter({ hasText: "Over here, quick!" }).count()) break;
      await b.dispatchEvent("click");
    }
    await expect(page.locator(".page-proofread-window")).toContainText("Over here, quick!", { timeout: 1000 });
  }).toPass({ timeout: 10000 });
  const live = page.locator(".page-proofread-window");
  await expect(live).toContainText("Over here, quick!");
  await page.evaluate(() => { const w = document.querySelector('.page-proofread-window'); Object.assign(w.style, { left: '10px', top: '100px', width: '560px', height: '880px' }); });
  const card3 = page.locator(`#region-card-${second.id} header`);
  const cb3 = await card3.boundingBox();
  await dragSelection(live.locator(".critique"), "Over here, quick!", cb3.x + 12, cb3.y + cb3.height / 2);
  await expect.poll(async () => (await lineOf(second.id)).body, { timeout: 10000 }).toBe("Over here, quick!");
  const canvas3 = await page.locator(".canvas-page").first().boundingBox();
  await dragSelection(live.locator(".critique"), "Hold on a sec.", canvas3.x + (first.x + first.w / 2) * canvas3.width, canvas3.y + (first.y + first.h / 2) * canvas3.height);
  await expect.poll(async () => (await lineOf(first.id)).body, { timeout: 10000 }).toBe("Hold on a sec.");
  expect(errors).toEqual([]);
  console.log("Browser proofreader text drag passed: a real drag from a saved reply sets a canvas region's source, in Translate and Review, Japanese and Korean, and a card takes English.");
} catch (e) {
  await page.screenshot({ path: "/tmp/komatose-proofreader-text-drag.png" });
  throw e;
} finally {
  await browser.close();
}
