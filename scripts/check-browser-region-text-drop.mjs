/** Dropping reply text onto a region: canvas and region card, source vs English, Undo. */
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

/** A drag of plain text, as a browser makes for a selection dragged out of a reply. */
async function dropText(selector, text, at) {
  const dataTransfer = await page.evaluateHandle(t => { const d = new DataTransfer(); d.setData("text/plain", t); return d; }, text);
  const target = page.locator(selector).first();
  const box = await target.boundingBox();
  const point = at ? at(box) : { clientX: box.x + 12, clientY: box.y + 12 };
  await target.dispatchEvent("dragover", { dataTransfer, ...point });
  await target.dispatchEvent("drop", { dataTransfer, ...point });
}

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  const translate = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true });
  await expect(async () => { await translate.click(); await expect(translate).toHaveClass(/active/); }).toPass();
  await page.getByRole("complementary", { name: "Pages in chapter order" }).getByRole("button", { name: "Open page 1", exact: true }).click();
  const before = await state();
  const lines = before.lines.filter(l => l.imageId === before.images[0].id && l.x != null && l.sourceState !== "ignored")
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const [first] = lines;

  // Japanese dropped on the canvas region replaces its source.
  await dropText(".canvas-page", "「ここで待ってて。」", box => ({
    clientX: box.x + (first.x + first.w / 2) * box.width,
    clientY: box.y + (first.y + first.h / 2) * box.height,
  }));
  await expect.poll(async () => (await lineOf(first.id)).source, { timeout: 10000 }).toBe("ここで待ってて。");
  expect((await lineOf(first.id)).body).toBe(first.body);

  // The drop selects the region, so its card opens. English dropped on the card (outside its
  // text boxes) replaces its English and leaves the new source alone.
  await expect(page.locator(`#region-card-${first.id}`)).toHaveClass(/selected/);
  await dropText(`#region-card-${first.id} header`, "“I'll be back before sunrise.”");
  await expect.poll(async () => (await lineOf(first.id)).body, { timeout: 10000 }).toBe("I'll be back before sunrise.");
  expect((await lineOf(first.id)).source).toBe("ここで待ってて。");
  await page.screenshot({ path: "/tmp/komatose-region-text-drop.png" });

  // A collapsed row in the region list takes a drop as well.
  const second = lines[1];
  await dropText(`.rrow[aria-label^="#2 "]`, "Are you really leaving?");
  await expect.poll(async () => (await lineOf(second.id)).body, { timeout: 10000 }).toBe("Are you really leaving?");

  // Undo restores the previous English.
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect.poll(async () => (await lineOf(second.id)).body, { timeout: 10000 }).toBe(second.body);
  expect(errors).toEqual([]);
  console.log("Browser region text drop passed: Japanese on the canvas sets source, English on a card sets English, quotes are trimmed, and Undo restores.");
} finally {
  await browser.close();
}
