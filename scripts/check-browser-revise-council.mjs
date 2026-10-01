/** Run with: node scripts/test-browser.mjs scripts/check-browser-revise-council.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

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

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  const card = page.locator("[id^='region-card-']").first();
  await card.dispatchEvent("contextmenu");
  const regionMenu = page.locator(".actions-menu");
  await regionMenu.waitFor();
  const regionItems = await regionMenu.getByRole("menuitem").allTextContents();
  for (const step of ["Prepare", "Translate", "Review", "Clean", "Typeset", "Export"]) {
    assert.equal(regionItems.includes(step), false, `region menu still lists ${step}`);
  }
  await page.locator(".menu-backdrop").click();
  await page.getByRole("button", { name: /^Open page / }).first().click({ button: "right" });
  await regionMenu.waitFor();
  const pageItems = await regionMenu.getByRole("menuitem").allTextContents();
  for (const step of ["Prepare", "Translate", "Review", "Clean", "Typeset", "Export"]) {
    assert.equal(pageItems.includes(step), false, `page menu still lists ${step}`);
  }
  await page.locator(".menu-backdrop").click();
  await card.getByRole("button", { name: "Review Translation", exact: true }).click();
  const revise = page.getByRole("dialog", { name: "Review Translation translation", exact: true });
  await revise.getByRole("heading", { name: "Review Translation", exact: true }).waitFor();
  await revise.getByRole("button", { name: "Council settings…", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await settings.getByRole("heading", { name: "Review Translation council", exact: true }).waitFor();
  assert.equal(
    await settings.getByRole("tab", { name: "Review Translation", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await settings.getByRole("button", { name: "Customize council", exact: true }).click();
  const first = settings.getByLabel("Translator 1", { exact: true });
  await first.waitFor();
  const chosen = await first.inputValue();
  assert.ok(chosen, "council needs a translator");
  await settings.getByRole("button", { name: "Add translator", exact: true }).click();
  await settings.getByLabel("Translator 2", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Remove translator 2", exact: true }).click();
  await settings.getByRole("button", { name: "Save", exact: true }).first().click();
  await settings.waitFor({ state: "hidden" });
  await revise.waitFor();
  const saved = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  assert.equal(saved.seriesDefaults.data.regionAi.reviseModels.length, 1);
  assert.equal(saved.seriesDefaults.data.regionAi.reviseModels[0].engine, chosen);
  assert.equal(saved.preferences.regionAi.reviseModels[0].engine, chosen);
  await revise.getByRole("button", { name: "Council settings…", exact: true }).click();
  await settings.getByLabel("Translator 1", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Use translation and proofreading", exact: true }).click();
  await settings.getByText("Until you save a council for this series, Review Translation uses:", { exact: true }).waitFor();
  await settings.getByRole("button", { name: "Save", exact: true }).first().click();
  await settings.waitFor({ state: "hidden" });
  const cleared = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  assert.deepEqual(cleared.seriesDefaults.data.regionAi.reviseModels, []);
  assert.deepEqual(cleared.preferences.regionAi.reviseModels, []);
  await revise.getByRole("button", { name: "Close revise English dialog" }).click();
  assert.deepEqual(errors, []);
  console.log("Revise English council settings passed");
} finally {
  await browser.close();
}
