/** Typeset English box: Format button and Ctrl-click line breaks. No model calls. */
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

try {
  const before = await state();
  const line = before.lines.filter(l => l.imageId === before.images[0].id && l.x != null).sort((a, b) => a.sortOrder - b.sortOrder)[0];
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.locator(".pages > button").first().click();
  const typeset = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Typeset", exact: true });
  await expect(async () => { await typeset.click(); await expect(typeset).toHaveClass(/active/); }).toPass();
  await page.getByRole("button", { name: /^Region 1(,.*)?$/ }).dispatchEvent("click");
  const box = page.getByLabel("English · manual breaks");
  await box.fill('  "Wait, I can do this. Really?! Watch me..."  ');
  await page.locator('[data-find="format-english"]').click();
  await expect(box).toHaveValue("Wait,\nI can do this.\nReally?!\nWatch me...");
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).body, { timeout: 10000 })
    .toBe("Wait,\nI can do this.\nReally?!\nWatch me...");

  // Ctrl-click a space: that space becomes a line break.
  await box.fill("I can do this");
  const point = await box.evaluate((area) => {
    // Measure where the space after "can" sits, with a mirror of the textarea's text.
    const style = getComputedStyle(area), mirror = document.createElement("div");
    for (const key of ["font", "padding", "border", "width", "lineHeight", "letterSpacing", "whiteSpace", "wordWrap"]) mirror.style[key] = style[key];
    mirror.style.position = "fixed"; mirror.style.visibility = "hidden"; mirror.style.whiteSpace = "pre-wrap";
    const rect = area.getBoundingClientRect();
    mirror.style.left = `${rect.left}px`; mirror.style.top = `${rect.top}px`;
    mirror.textContent = "I can";
    const mark = document.createElement("span"); mark.textContent = " "; mirror.append(mark);
    document.body.append(mirror);
    const r = mark.getBoundingClientRect(); mirror.remove();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.keyboard.down("Control");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Control");
  await expect(box).toHaveValue("I can\ndo this");
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).body, { timeout: 10000 }).toBe("I can\ndo this");
  // The Geometry rail's Auto buttons run Shape & mask's actions without leaving the Text tab.
  const rail = page.getByRole("toolbar", { name: "Tools" });
  const bounds = rail.getByRole("button", { name: "Set polygon to region bounds", exact: true });
  const fit = rail.getByRole("button", { name: "Fit bubble (enclosed interior)", exact: true });
  await expect(bounds).toBeVisible();
  await expect(fit).toBeVisible();
  await bounds.click();
  await expect.poll(async () => JSON.stringify((await state()).regions[line.id]?.data.polygon), { timeout: 10000 })
    .toBe(JSON.stringify([{ x: line.x, y: line.y }, { x: line.x + line.w, y: line.y }, { x: line.x + line.w, y: line.y + line.h }, { x: line.x, y: line.y + line.h }]));
  const traced = page.waitForRequest(r => r.url() === `${api}/workflow` && r.postDataJSON()?.action === "geometry");
  await fit.click();
  expect((await traced).postDataJSON()).toMatchObject({ lineId: line.id, method: "opencv" });
  await expect(page.locator(".ts-insp")).toContainText("English · manual breaks");
  await page.screenshot({ path: "/tmp/komatose-lettering-breaks.png" });
  // Without a selected region there is nothing to fit, so the buttons go away.
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
  console.log("Browser lettering breaks passed: Format breaks after punctuation and strips quotes; Ctrl-click a space breaks the line there; the rail's Auto buttons set region bounds and fit the bubble.");
} finally {
  await browser.close();
}
