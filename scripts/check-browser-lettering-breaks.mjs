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

  // Aa re-cases shouted lettering: sentence starts and I keep their capitals.
  await box.fill("WAIT, I CAN DO THIS. REALLY?!");
  await page.locator('[data-find="sentence-case"]').click();
  await expect(box).toHaveValue("Wait, I can do this. Really?!");
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).body, { timeout: 10000 }).toBe("Wait, I can do this. Really?!");

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
  // Changing the region type refits the lettering in the same save; the browser sends no
  // separate fit that could race it and fit the old type.
  const fits = [];
  page.on("request", r => { if (r.url() === `${api}/workflow` && r.method() === "POST" && r.postDataJSON()?.action === "fit") fits.push(r); });
  const hadLayout = !!(await state()).regions[line.id]?.data.layout;
  console.log("type change on a region", hadLayout ? "with" : "without", "a fitted layout");
  const typeSave = page.waitForResponse(r => r.url().endsWith(`/lines/${line.id}`) && r.request().method() === "PATCH" &&
    JSON.parse(r.request().postData() || "{}").lineType === "()");
  await page.locator(".ts-insp").getByRole("combobox", { name: "Region type" }).selectOption("()");
  const saved = await (await typeSave).json();
  expect(saved.line.lineType).toBe("()");
  // The fixture's thought style names a font this series lacks, so the refit reports why it
  // could not run; with the font present the save returns the refitted region instead.
  if (!hadLayout) {
    // Nothing is fitted yet, so the type change only re-bases the style for the first fit.
    // A region with its own style gets the re-based style back, so the browser shows it.
    expect(saved.fitError).toBeUndefined();
    if (saved.doc) {
      expect(saved.doc.data.layout).toBeFalsy();
      await expect.poll(async () => (await state()).regions[line.id].revision).toBe(saved.doc.revision);
    }
  } else if (saved.doc) {
    expect(saved.doc.data.layout).toBeTruthy();
    await expect.poll(async () => (await state()).regions[line.id].revision).toBe(saved.doc.revision);
  } else {
    expect(saved.fitError).toMatch(/font/i);
    await expect(page.getByText(`Saved, but the lettering was not refitted: ${saved.fitError}`)).toBeVisible();
  }
  expect(fits).toEqual([]);
  await page.screenshot({ path: "/tmp/komatose-lettering-breaks.png" });
  // Without a selected region there is nothing to fit, so the buttons go away.
  await page.keyboard.press("Escape");

  // Review's English box has the same Format button and Ctrl-click break.
  const review = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Review", exact: true });
  await expect(async () => { await review.click(); await expect(review).toHaveClass(/active/); }).toPass();
  await page.getByRole("button", { name: /^Region 1(,.*)?$/ }).dispatchEvent("click");
  const reviewBox = page.locator(`#english-${line.id}`);
  await reviewBox.fill('"Fine. Go on, then!"');
  await reviewBox.locator("xpath=ancestor::div[contains(@class,'field')][1]").locator('[data-find="format-english"]').click();
  await expect(reviewBox).toHaveValue("Fine.\nGo on,\nthen!");
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).body, { timeout: 10000 }).toBe("Fine.\nGo on,\nthen!");
  await reviewBox.fill("GO ON. I'M HERE");
  await reviewBox.locator("xpath=ancestor::div[contains(@class,'field')][1]").locator('[data-find="sentence-case"]').click();
  await expect(reviewBox).toHaveValue("Go on. I'm here");
  await reviewBox.fill("I can do this");
  const reviewPoint = await reviewBox.evaluate((area) => {
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
  await page.mouse.click(reviewPoint.x, reviewPoint.y);
  await page.keyboard.up("Control");
  await expect(reviewBox).toHaveValue("I can\ndo this");
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).body, { timeout: 10000 }).toBe("I can\ndo this");

  // Corner handles keep a wide grab area: a drag starting 10 px off the corner still resizes.
  const handle = page.getByRole("button", { name: "Resize region corner 3" });
  const hb = await handle.boundingBox();
  expect(hb.width).toBeGreaterThanOrEqual(26);
  const boxBefore = (await state()).lines.find(l => l.id === line.id);
  await page.mouse.move(hb.x + hb.width / 2 + 10, hb.y + hb.height / 2 + 10);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 40, hb.y + hb.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await state()).lines.find(l => l.id === line.id).w, { timeout: 10000 }).toBeGreaterThan(boxBefore.w);

  // A / D step through pages and W opens the next page not marked done; typing in a box does not.
  const selectedPage = () => page.locator(".pages > button").evaluateAll(buttons => buttons.findIndex(b => b.classList.contains("selected")));
  const startPage = await selectedPage();
  await reviewBox.press("d");
  expect(await selectedPage()).toBe(startPage);
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("d");
  await expect.poll(selectedPage).toBe(startPage + 1);
  await page.keyboard.press("a");
  await expect.poll(selectedPage).toBe(startPage);
  await page.keyboard.press("w");
  await expect.poll(selectedPage).not.toBe(startPage);
  expect(errors).toEqual([]);
  console.log("Browser lettering breaks passed: Format breaks after punctuation and strips quotes; Ctrl-click a space breaks the line there; the rail's Auto buttons set region bounds and fit the bubble; Aa re-cases shouting; Review's English box formats, re-cases and breaks the same way; corner handles grab from 10 px away; A, D and W change pages.");
} finally {
  await browser.close();
}
