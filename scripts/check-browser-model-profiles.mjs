/** Run with: node scripts/test-browser.mjs scripts/check-browser-model-profiles.mjs */
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
  if (existsSync(cache)) {
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
  }
}

const CHAT = ["translate", "vision", "describe", "proofreadEnglish", "chapterReview", "advisory", "compactNotes", "alternatives", "pageImageProofread"];
const engines = [
  { id: "qwen3.8-27b-q4", label: "Qwen 3.8 27B", available: true, group: "Local models", operations: CHAT },
  { id: "qwen3-vl-8b", label: "Qwen3-VL", available: true, group: "Local models", operations: ["describe", "vision", "advisory"] },
  { id: "hayai-ocr-v2", label: "Hayai OCR v2", available: true, group: "Local models", operations: ["vision"] },
  { id: "paddleocr-vl-1.6", label: "PaddleOCR-VL-1.6", available: true, group: "Local models", operations: ["vision"] },
  { id: "grok-4.6", label: "Grok 4.6", available: true, group: "CLI agents", operations: CHAT, access: "cli" },
  { id: "composer-2.5", label: "Composer 2.5", available: true, group: "CLI agents", operations: CHAT, access: "cli" },
  { id: "proofreader-a", label: "Proofreader A", available: true, group: "Proofreaders", operations: ["pageImageProofread"], pageImageOnly: true },
  { id: "proofreader-b", label: "Proofreader B", available: true, group: "Proofreaders", operations: ["pageImageProofread"], pageImageOnly: true },
];

const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{
  name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
}]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/ai/engines", (route) => route.fulfill({
  json: {
    engines,
    rows: engines,
    translationEngines: engines.filter((item) => item.operations.includes("translate")),
    transcriptionModels: engines.filter((item) => item.operations.includes("vision")),
    localReviewModels: [
      { id: "hayai-ocr-v2", label: "Hayai OCR v2" },
      { id: "paddleocr-vl-1.6", label: "PaddleOCR-VL-1.6" },
    ],
  },
}));

const workflow = `${base}/api/episodes/fixture-episode/workflow`;
const profilesApi = `${base}/api/model-profiles`;
const state = async () => (await context.request.get(workflow)).json();

try {
  const seeded = await context.request.post(workflow, {
    data: {
      action: "preferences",
      scope: "series",
      expectedRevision: (await state()).seriesDefaults.revision,
      data: {
        regionAi: {
          translate: { engine: "qwen3.8-27b-q4", model: "" },
          describe: { engine: "qwen3-vl-8b", model: "" },
          vision: { engine: "qwen3-vl-8b", model: "" },
          proofread: { engine: "qwen3.8-27b-q4", model: "" },
          enquire: { engine: "composer-2.5", model: "" },
          reviewers: [{ engine: "hayai-ocr-v2", model: "" }],
          transcriptionModels: ["hayai-ocr-v2", "paddleocr-vl-1.6"],
        },
      },
    },
  });
  assert.ok(seeded.ok(), await seeded.text());

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.getByRole("group", { name: "Run on" }).getByRole("button", { name: "Whole chapter", exact: true }).click();
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await expect(dialog.getByRole("heading", { name: "Model profiles" })).toBeVisible();

  // Profiles is the default tab: save the current selections as a profile.
  await dialog.getByLabel("Profile name", { exact: true }).fill("Local only");
  await dialog.getByRole("button", { name: "Save as profile", exact: true }).click();
  const savedSelect = dialog.getByLabel("Saved model profile", { exact: true });
  await expect.poll(async () => savedSelect.inputValue()).not.toBe("");
  await expect(savedSelect.locator("option:checked")).toHaveText("Local only");

  // Each task's model lives on its own tab of the settings dialog.
  const proofread = dialog.getByLabel("Proofreading (English / page images)", { exact: true });
  const describe = dialog.getByLabel("Page description", { exact: true });
  await dialog.getByRole("tab", { name: "Proofreading", exact: true }).click();
  await expect(proofread).toHaveValue("qwen3.8-27b-q4");
  await proofread.selectOption("proofreader-a");
  await expect(proofread).toHaveValue("proofreader-a");
  await dialog.getByRole("tab", { name: "Description", exact: true }).click();
  await expect(describe).toHaveValue("qwen3-vl-8b");
  const beforeApply = (await state()).preferences.regionAi;
  assert.equal(beforeApply.proofread.engine, "qwen3.8-27b-q4");

  await dialog.getByRole("tab", { name: "Profiles", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply profile", exact: true }).click();
  await dialog.getByRole("tab", { name: "Proofreading", exact: true }).click();
  await expect(proofread).toHaveValue("qwen3.8-27b-q4");
  await dialog.getByRole("tab", { name: "Description", exact: true }).click();
  await expect(describe).toHaveValue("qwen3-vl-8b");
  await expect.poll(async () => (await state()).preferences.regionAi.proofread).toEqual({
    engine: "qwen3.8-27b-q4",
    model: "",
  });
  await expect.poll(async () => (await state()).preferences.regionAi.describe).toEqual({
    engine: "qwen3-vl-8b",
    model: "",
  });

  await dialog.getByRole("tab", { name: "Profiles", exact: true }).click();
  const localId = await savedSelect.inputValue();
  await dialog.getByRole("button", { name: "Delete profile", exact: true }).click();
  await expect(savedSelect).toHaveValue("");
  const listed = await (await context.request.get(profilesApi)).json();
  assert.equal(listed.profiles.some((item) => item.id === localId), false);

  const broken = await context.request.post(profilesApi, {
    data: {
      action: "save",
      name: "Missing models",
      selections: {
        translate: { engine: "deleted-row", model: "" },
        proofread: { engine: "qwen3.8-27b-q4", model: "" },
        reviewers: [{ engine: "hayai-ocr-v2", model: "" }],
        transcriptionModels: ["missing-ocr"],
      },
    },
  });
  assert.ok(broken.ok(), await broken.text());
  await dialog.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const again = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await again.getByLabel("Saved model profile", { exact: true }).selectOption({ label: "Missing models" });
  await expect(again.getByRole("alert")).toContainText("deleted-row is not in the model registry");
  await expect(again.getByRole("alert")).toContainText("missing-ocr is not in the model registry");
  await expect(again.getByRole("button", { name: "Apply profile", exact: true })).toBeDisabled();
  await expect.poll(async () => (await state()).preferences.regionAi.translate).toEqual({
    engine: "qwen3.8-27b-q4",
    model: "",
  });
  await again.getByRole("button", { name: "Cancel", exact: true }).first().click();

  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Prepare", exact: true }).click();
  await page.getByRole("button", { name: "Organize", exact: true }).waitFor();
  await page.getByRole("button", { name: "Description model…", exact: true }).click();
  const describeDialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await expect(describeDialog.getByRole("heading", { name: "Model profiles" })).toHaveCount(0);
  await describeDialog.getByRole("button", { name: "Cancel", exact: true }).first().click();

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("model profile save/apply/delete checks passed");
} finally {
  await browser.close();
}
