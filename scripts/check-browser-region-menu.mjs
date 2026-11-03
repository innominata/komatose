// Region right-click menu items act on the region that was right-clicked.
// Closing the menu clears the region it was opened on, so each item must read
// the region before closing; reading it after threw and the item did nothing.
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
const posts = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().endsWith("/workflow")) posts.push(JSON.parse(r.postData() || "{}"));
});

const openMenu = async () => {
  const region = page.getByRole("button", { name: /^Region 1(,.*)?$/ });
  const box = await region.boundingBox();
  await region.dispatchEvent("contextmenu", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, button: 2 });
};

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.locator(".pages > button").first().click();
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Region 1(,.*)?$/ })).toBeVisible();

  await openMenu();
  await page.locator('[data-find="detect-region-lettering"]').click();
  await expect.poll(() => posts.find((p) => p.action === "mask")?.focusLineId).toBe("fixture-line-0-0");

  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Typeset", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Region 1(,.*)?$/ })).toBeVisible();
  await openMenu();
  await page.getByRole("menuitem", { name: "Approve geometry", exact: true }).click();
  const approve = await expect.poll(() => posts.find((p) => p.action === "region" && p.data?.geometryApproved)).toBeTruthy()
    .then(() => posts.find((p) => p.action === "region" && p.data?.geometryApproved));
  if (approve.id !== "fixture-line-0-0" || !(approve.expectedRevision > 0))
    throw new Error(`Approve geometry sent ${JSON.stringify(approve)}`);

  if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
  console.log("region menu ok");
} finally {
  await browser.close();
}
