/** Run with: node scripts/test-browser.mjs scripts/check-browser-credits.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import sharp from "sharp";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
  }
}

const pre = await sharp({ create: { width: 120, height: 40, channels: 3, background: "#cc3344" } }).png().toBuffer();
const post = await sharp({ create: { width: 90, height: 30, channels: 3, background: "#3344cc" } }).png().toBuffer();

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Series credits", exact: true }).click();
  await page.getByRole("heading", { name: "Series credits" }).waitFor();
  await expect(page.getByRole("heading", { name: "Series credits" })).toBeVisible();
  await page.getByLabel("Upload pre-credits page").setInputFiles({
    name: "pre.png", mimeType: "image/png", buffer: pre,
  });
  await expect(page.getByText("pre.png", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText("Chapter is missing the series pre-credits page")).toBeVisible();
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Prepare", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Series credits", exact: true }).click();
  await page.getByRole("button", { name: "Add credits to this chapter" }).click();
  await expect(page.getByRole("button", { name: /pre-credits/ })).toBeVisible();
  await page.getByLabel("Upload post-credits page").setInputFiles({
    name: "post.png", mimeType: "image/png", buffer: post,
  });
  await page.getByRole("button", { name: "Add credits to this chapter" }).click();
  await expect(page.getByRole("button", { name: /post-credits/ })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText("Chapter is missing the series pre-credits page")).toHaveCount(0);
  await expect(page.getByText("Chapter is missing the series post-credits page")).toHaveCount(0);
  await expect(page.getByText("No reviewed regions")).toHaveCount(0);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
