/** Run through scripts/test-browser.mjs; no model calls or live configuration changes. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, "chrome-linux64/chrome"))
    .find(path => existsSync(path)) || executablePath;
}
const choices = {
  codex: [{ id: "gpt-6-luna", label: "GPT-6-Luna" }],
  cursor: [
    { id: "claude-haiku-5-5-low", label: "Claude Haiku 5.5 Low" },
    { id: "claude-haiku-5-5-max", label: "Claude Haiku 5.5 Max" },
  ],
};
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
  // Discovery checks executable presence only. Node is the fixture executable;
  // catalog listing is stubbed below and nothing invokes a paid CLI agent.
  for (const id of ["codex", "cursor"]) {
    const response = await context.request.post(`${base}/api/admin/cli-tools`, { data: {
      action: "save", id, executable: process.execPath,
    } });
    expect(response.ok()).toBeTruthy();
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => { errors.push(error.message); console.error("PAGE ERROR", error.message); });
  await page.route("**/api/admin/models", async route => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body.action === "refresh") return route.fulfill({ json: {
        ok: true, adapter: body.adapter, at: Date.now(), models: choices[body.adapter] || [],
      } });
    }
    await route.continue();
  });
  const tableRow = label => page.locator("tr.m-row").filter({ has: page.getByText(label, { exact: true }) });
  await page.goto(`${base}/admin/models/list`);
  await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
  await page.waitForFunction(() => !!document.querySelector(".page-head"));
  // Default On this machine filter must include added hidden CLI models.
  for (const [adapter, models] of Object.entries(choices)) {
    await page.locator(".page-head").getByRole("button", { name: "Add model" }).click();
    const dialog = page.getByRole("dialog", { name: "Add model", exact: true });
    await dialog.getByRole("button", { name: "CLI agent", exact: true }).click();
    if (adapter !== "codex") await dialog.getByRole("button", { name: /^Cursor/ }).click();
    for (const model of models) await dialog.getByRole("checkbox", { name: new RegExp(model.id) }).check();
    await dialog.getByRole("button", { name: `Add ${models.length}`, exact: true }).click();
    await expect(dialog).toBeHidden();
    for (const model of models) {
      await expect(tableRow(model.label)).toBeVisible();
      await expect(tableRow(model.label)).toContainText("Ready · hidden from users");
      await expect(tableRow(model.label).locator("label.switch input")).toBeEnabled();
      await expect(tableRow(model.label).locator("label.switch input")).not.toBeChecked();
    }
  }
  await page.getByRole("button", { name: /^Hidden from users/ }).click();
  for (const model of Object.values(choices).flat()) await expect(tableRow(model.label)).toBeVisible();
  const luna = tableRow("GPT-6-Luna");
  await luna.locator("label.switch").click();
  await expect(luna).toHaveCount(0);
  await page.getByRole("button", { name: /^On this machine/ }).click();
  await expect(luna.locator("label.switch input")).toBeChecked();
  await luna.locator("label.switch").click();
  await expect(luna).toBeVisible();
  await expect(luna).toContainText("Ready · hidden from users");
  await page.reload();
  for (const model of Object.values(choices).flat()) await expect(tableRow(model.label)).toBeVisible();
  expect(errors).toEqual([]);
  console.log("CLI model registration passed: Codex Luna and Cursor Haiku appear immediately, hidden models stay listed, visibility switches work and rows survive reload.");
} finally {
  await browser.close();
}
