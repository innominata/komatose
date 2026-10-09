/** Bulk region removal from Prepare, using the isolated browser fixture. */
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
page.on("pageerror", error => errors.push(error.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const remove = () => page.getByRole("region", { name: "Selected page actions" })
  .getByRole("button", { name: "Remove all regions…", exact: true });
const confirm = async (accept, text, action) => {
  const dialog = page.waitForEvent("dialog");
  const clicked = action();
  const prompt = await dialog;
  expect(prompt.message()).toContain(text);
  if (accept) await prompt.accept();
  else await prompt.dismiss();
  await clicked;
};

try {
  const before = await state();
  // Validate the entire selection before deleting anything.
  for (const imageIds of [[], "fixture-page-0", [null], ["fixture-page-0", "missing-page"]]) {
    const response = await context.request.post(`${api}/workflow`, { data: {
      action: "remove-selected-page-regions", imageIds,
    } });
    expect(response.status()).toBe(Array.isArray(imageIds) && imageIds.includes("missing-page") ? 404 : 400);
    expect((await state()).lines).toEqual(before.lines);
  }

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Prepare", exact: true }).click();
  const grid = page.locator(".organize");
  await grid.getByRole("checkbox", { name: "Select page 1", exact: true }).check();
  await expect(remove()).toBeEnabled();
  await confirm(false, "Remove all 3 regions from 1 selected page?", () => remove().click());
  expect((await state()).lines).toEqual(before.lines);
  await confirm(true, "Their text remains in revision history.", () => remove().click());
  await expect(remove()).toBeDisabled();
  const afterOne = await state();
  expect(afterOne.images).toEqual(before.images);
  expect(afterOne.lines).toEqual(before.lines.filter(line => line.imageId !== "fixture-page-0"));
  // The same action is available in the Edit page selection bar.
  await grid.getByRole("checkbox", { name: "Select page 2", exact: true }).click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Edit page", exact: true }).click();
  await expect(remove()).toBeEnabled();
  await confirm(true, "Remove all 3 regions from 2 selected pages?", () => remove().click());
  await expect(remove()).toBeDisabled();
  expect((await state()).lines).toEqual([]);
  expect((await state()).images).toEqual(before.images);
  await page.reload();
  expect((await state()).lines).toEqual([]);
  expect(errors).toEqual([]);
  console.log("Prepare bulk region removal passed: cancellation, selection scope, both views, validation and persistence.");
} finally {
  await browser.close();
}
