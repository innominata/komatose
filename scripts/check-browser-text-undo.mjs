/**
 * Ctrl+Z inside a text box undoes typing in that box only, and outside a text box it only
 * undoes changes to the page on screen.
 */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
const lineOf = async id => (await state()).lines.find(l => l.id === id);
const undoKey = () => page.keyboard.press("Control+z");

const value = loc => loc.inputValue();
const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.getAttribute("data-undo-key") || document.activeElement?.tagName);

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  const nav = page.getByRole("navigation", { name: "Chapter workflow" });
  await nav.waitFor();
  const translate = nav.getByRole("button", { name: "Translate", exact: true });
  await expect(async () => { await translate.click(); await expect(translate).toHaveClass(/active/); }).toPass();
  const pages = page.getByRole("complementary", { name: "Pages in chapter order" });
  const openPage = async n => { await pages.getByRole("button", { name: `Open page ${n}`, exact: true }).click(); await page.waitForTimeout(600); };
  await openPage(1);
  const before = await state();
  const [first, second] = before.images;
  const onPage = id => before.lines.filter(l => l.imageId === id && l.x != null && l.sourceState !== "ignored")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [a, b] = onPage(first.id);
  const other = onPage(second.id)[0];

  // 1. Each text box undoes its own typing. Chrome's shared history used to jump to the
  //    English box once the source box ran out of steps.
  await page.locator(`.rrow[aria-label^="#1 "]`).first().click().catch(() => {});
  const eng = page.locator(`#english-${a.id}`);
  const src = page.locator(`[data-undo-key="source-${a.id}"]`);
  const engBefore = await value(eng), srcBefore = await value(src);
  await eng.click(); await eng.press("End");
  await eng.pressSequentially(" later", { delay: 30 });
  await page.waitForTimeout(1300);
  await src.click(); await src.press("End");
  await src.pressSequentially("ABC", { delay: 30 });
  await page.waitForTimeout(1300);
  await src.pressSequentially("DEF", { delay: 30 });
  await page.keyboard.press("Control+z");
  expect(await value(src)).toBe(`${srcBefore}ABC`);
  await page.keyboard.press("Control+z");
  expect(await value(src)).toBe(srcBefore);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+z");
  expect(await value(src)).toBe(srcBefore);
  expect(await value(eng)).toBe(`${engBefore} later`);
  expect(await active()).toBe(`source-${a.id}`);
  await page.keyboard.press("Control+Shift+z");
  expect(await value(src)).toBe(`${srcBefore}ABC`);
  // The undone value saves like typing does.
  await expect.poll(async () => (await lineOf(a.id)).source, { timeout: 10000 }).toBe(`${srcBefore}ABC`);
  // Undo in the English box steps back a word at a time and leaves the source alone.
  await eng.click();
  await page.keyboard.press("Control+z");
  expect(await value(eng)).toBe(engBefore);
  expect(await value(src)).toBe(`${srcBefore}ABC`);
  await expect.poll(async () => (await lineOf(a.id)).body, { timeout: 10000 }).toBe(engBefore);

  // 2. Outside a text box, Ctrl+Z only restores regions deleted from the page on screen,
  //    even when a later deletion happened on another page.
  expect((await context.request.delete(`${api}/lines/${b.id}`)).ok()).toBe(true);
  await page.waitForTimeout(50);
  expect((await context.request.delete(`${api}/lines/${other.id}`)).ok()).toBe(true);
  await page.reload();
  await nav.waitFor();
  await expect(async () => { await translate.click(); await expect(translate).toHaveClass(/active/); }).toPass();
  await openPage(1);
  await page.locator(".canvas-page").first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press("Control+z");
  await expect.poll(async () => !!(await lineOf(b.id)), { timeout: 10000 }).toBe(true);
  expect(!!(await lineOf(other.id))).toBe(false);
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+z");
  await expect(page.getByText("Nothing deleted on this page to undo.")).toBeVisible();
  expect(!!(await lineOf(other.id))).toBe(false);
  await openPage(2);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press("Control+z");
  await expect.poll(async () => !!(await lineOf(other.id)), { timeout: 10000 }).toBe(true);

  // 3. Prepare: Ctrl+Z skips a page edit made to another page, and undoes one on this page.
  const nudge = await context.request.post(`${api}/pages`, { data: { op: "nudge", imageId: second.id, dx: 1, dy: 0, fill: "white" } });
  expect(nudge.ok(), await nudge.text()).toBe(true);
  const undoCount = async () => (await (await context.request.get(`${api}/pages`)).json()).undoCount;
  const counted = await undoCount();
  const prepare = nav.getByRole("button", { name: /Prepare/ });
  await expect(async () => { await prepare.first().click(); await expect(prepare.first()).toHaveClass(/active/); }).toPass();
  await openPage(1);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  await page.keyboard.press("Control+z");
  await expect(page.getByText(/Nothing to undo on this page/)).toBeVisible();
  expect(await undoCount()).toBe(counted);
  await openPage(2);
  await page.evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
  page.once("dialog", d => d.accept());
  await page.keyboard.press("Control+z");
  await expect.poll(undoCount, { timeout: 10000 }).toBe(counted - 1);

  expect(errors).toEqual([]);
  console.log("Browser text undo passed: each text box undoes and redoes only its own typing and saves the result, and Ctrl+Z outside text restores only the current page's deleted regions or Prepare page edits.");
} finally {
  await browser.close();
}
