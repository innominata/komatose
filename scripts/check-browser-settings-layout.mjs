/** Run with: node scripts/test-browser.mjs scripts/check-browser-settings-layout.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executable = readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => join(cache, name, "chrome-linux64/chrome"))
    .find((path) => existsSync(path)) || executable;
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
await page.context().addCookies([{
  name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
}]);

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const drawer = page.locator('[data-find="settings-drawer"]');
  await drawer.getByRole("button", { name: "AI models", exact: true }).click();
  const dialog = drawer.getByRole("dialog", { name: "AI model settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Translation", exact: true })).toBeVisible();
  const desktop = await drawer.boundingBox();
  assert.ok(desktop && desktop.width >= 1490, `Settings width: ${desktop?.width}`);
  await expect(dialog.getByRole("tab", { name: "Review Translation", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "Transcription", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Transcription models" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  await page.screenshot({ path: "/tmp/komatose-settings-desktop.png" });

  await page.setViewportSize({ width: 390, height: 760 });
  await expect(drawer.getByRole("combobox", { name: "Settings section" })).toHaveValue("models");
  await dialog.getByRole("combobox", { name: "Model task" }).selectOption("translate");
  await expect(dialog.getByRole("heading", { name: "Translation", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: "/tmp/komatose-settings-mobile.png" });
  console.log("Settings layout checks passed");
} finally {
  await browser.close();
}
