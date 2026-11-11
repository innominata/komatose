// Switching workflow step keeps the view at the same spot on the page. It used to jump
// back to the top of the page every time the step changed.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  const candidates = existsSync(cache)
    ? readdirSync(cache)
        .filter((n) => /^chromium-\d+$/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((n) => join(cache, n, "chrome-linux64/chrome"))
    : [];
  executable = candidates.find((p) => existsSync(p)) || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : executable);
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

/** The point of the current page at the centre of the canvas view, as fractions of the page. */
const viewSpot = () => page.evaluate(() => {
  const scroller = document.querySelector(".canvas-scroll");
  const el = scroller.querySelector("[data-active-page]") ?? scroller.querySelector(".canvas-page.overscroll");
  const s = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
  return { fx: (s.left + s.width / 2 - r.left) / r.width, fy: (s.top + s.height / 2 - r.top) / r.height };
});
const near = (a, b) => Math.abs(a.fx - b.fx) < 0.03 && Math.abs(a.fy - b.fy) < 0.03;

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  const nav = page.getByRole("navigation", { name: "Chapter workflow" });
  await nav.waitFor();
  await page.locator(".pages > button").first().click();
  for (const [from, to] of [["Typeset", "Clean"], ["Clean", "Translate"], ["Translate", "Typeset"]]) {
    await nav.getByRole("button", { name: from, exact: true }).click();
    await expect(page.locator(".canvas-scroll .canvas-page").first()).toBeVisible();
    await page.waitForTimeout(300);
    // Zoom in and scroll to the lower right part of the page.
    await page.evaluate(() => {
      const scroller = document.querySelector(".canvas-scroll");
      const el = scroller.querySelector("[data-active-page]") ?? scroller.querySelector(".canvas-page.overscroll");
      const s = scroller.getBoundingClientRect(), r = el.getBoundingClientRect();
      scroller.scrollBy({ left: r.left + r.width * 0.7 - (s.left + s.width / 2), top: r.top + r.height * 0.75 - (s.top + s.height / 2) });
    });
    await page.waitForTimeout(200);
    const before = await viewSpot();
    if (before.fy < 0.6) throw new Error(`Could not scroll down the page in ${from}: ${JSON.stringify(before)}`);
    await nav.getByRole("button", { name: to, exact: true }).click();
    await expect(page.locator(".canvas-scroll .canvas-page").first()).toBeVisible();
    await page.waitForTimeout(500);
    const after = await viewSpot();
    if (!near(before, after)) throw new Error(`${from} → ${to} moved the view from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
  }
  if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
  console.log("step scroll ok");
} finally {
  await browser.close();
}
