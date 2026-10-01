/** Run with: node scripts/test-browser.mjs scripts/check-browser-models.mjs */
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
const row = (id, label, group, operations, extra = {}) => ({
  id, label, available: extra.available !== false, group, operations, ...extra,
});
let koEnAvailable = false;
const engineList = () => [
  row("qwen3.8-27b-q4", "Qwen 3.8 27B", "Local models", CHAT),
  row("qwen3-vl-8b", "Qwen3-VL", "Local models", ["describe", "vision", "advisory"]),
  row("hy-mt2-manga-v5", "Hy-MT2 1.8B Manga v5", "Local models", ["translate"]),
  row("imsbee-ko-en-translator", "Imsbee Ko→En Translator", "Local models", ["translate"], {
    available: koEnAvailable,
    reason: koEnAvailable ? "Installed" : "Not installed. Run python3 scripts/install-translation-models.py",
  }),
  row("hayai-ocr-v2", "Hayai OCR v2", "Local models", ["vision"]),
  row("paddleocr-vl-1.6", "PaddleOCR-VL-1.6", "Local models", ["vision"]),
  row("grok-4.6", "Grok 4.6", "CLI agents", CHAT, { access: "cli" }),
  row("composer-2.5", "Composer 2.5", "CLI agents", CHAT, { access: "cli" }),
  row("gpt-5.4", "GPT-5.4", "CLI agents", CHAT, { access: "cli" }),
  row("proofreader-a", "Proofreader A", "Proofreaders", ["pageImageProofread"], { pageImageOnly: true }),
  row("proofreader-b", "Proofreader B", "Proofreaders", ["pageImageProofread"], { pageImageOnly: true }),
];

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  // Chat rows ship as Setup presets now, not seeds: this fixture adds one so
  // the legacy "qwen" engine in saved preferences resolves the way it does on
  // a machine whose operator added a local chat model.
  const chat = await context.request.post(`${base}/api/admin/models`, {
    data: {
      action: "add-local", name: "Qwen 3.8 27B", slug: "qwen3.8-27b-q4",
      baseUrl: "http://127.0.0.1:18080/v1",
    },
  });
  assert.ok(chat.ok());
  // The mocked engine list includes the CLI rows a real machine gets from CLI
  // discovery; register them server-side so preference saves (grok-4.6,
  // composer-2.5, gpt-5.4) validate against actual registry rows.
  for (const [adapter, slug, label] of [
    ["grok", "grok-4.6", "Grok 4.6"],
    ["cursor", "composer-2.5", "Composer 2.5"],
    ["codex", "gpt-5.4", "GPT-5.4"],
  ]) {
    const added = await context.request.post(`${base}/api/admin/models`, {
      data: { action: "add-cli", adapter, slug, label },
    });
    assert.ok(added.ok(), `add-cli ${slug} should register a row`);
  }
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  const state = async () => (await context.request.get(workflow)).json();
  const originalModels = {
    translate: { engine: "qwen", model: "saved-local-model" },
    vision: { engine: "qwen", model: "saved-local-model" },
    describe: { engine: "cursor", model: "caption-model" },
    proofread: { engine: "codex", model: "proofreader-model" },
    enquire: { engine: "grok", model: "enquiry-model" },
    reviewers: [{ engine: "grok", model: "reviewer-model" }],
  };
  const saved = await context.request.post(workflow, { data: {
    action: "preferences", expectedRevision: (await state()).chapter.revision,
    data: { regionAi: originalModels },
  } });
  assert.ok(saved.ok());
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  await page.route("**/api/ai/engines", route => {
    const engines = engineList();
    return route.fulfill({
      json: {
        engines,
        rows: engines,
        translationEngines: engines.filter((item) => item.operations.includes("translate")),
        transcriptionModels: engines.filter((item) => ["hayai-ocr-v2", "paddleocr-vl-1.6", "qwen3-vl-8b"].includes(item.id) || item.operations.includes("vision")),
        localReviewModels: [
          { id: "hayai-ocr-v2", label: "Hayai OCR v2" },
          { id: "paddleocr-vl-1.6", label: "PaddleOCR-VL-1.6" },
        ],
      },
    });
  });
  await page.route(/\/api\/episodes\/fixture-episode\/ai-(transcribe|translate)$/, async route => {
    if (route.request().method() === "POST") {
      calls.push({ kind: route.request().url().split("ai-").at(-1), ...route.request().postDataJSON() });
      await route.fulfill({ status: 202, json: { ok: true } });
    } else await route.fulfill({ json: { engines: engineList() } });
  });
  async function openChapter() {
    await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
    await page.waitForFunction(() => document.body.dataset.studioReady === "1");
    await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
    await page.locator(".pages > button").first().click();
    await page.getByRole("group", { name: "Run on" }).getByRole("button", { name: "Whole chapter", exact: true }).click();
    await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
    await page.getByRole("tab", { name: "Translation", exact: true }).click();
    await page.getByRole("combobox", { name: "Translation model", exact: true }).first().waitFor();
  }
  await openChapter();
  const engine = page.getByRole("combobox", { name: "Translation model", exact: true }).first();
  await expect(engine).toHaveValue("qwen3.8-27b-q4");
  await engine.selectOption("grok-4.6");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect.poll(async () => (await state()).preferences.regionAi.translate).toEqual({ engine: "grok-4.6", model: "" });
  const changed = (await state()).preferences.regionAi;
  assert.equal(changed.vision.engine, "qwen3.8-27b-q4");
  assert.equal(changed.vision.model, "saved-local-model");
  assert.equal(changed.describe.engine, "cursor");
  assert.equal(changed.describe.model, "caption-model");
  assert.equal(changed.proofread.engine, "codex");
  assert.equal(changed.proofread.model, "proofreader-model");

  async function run(kind, chosenEngine) {
    const before = calls.length;
    await page.getByRole("button", { name: kind === "transcribe" ? "Transcribe chapter" : "Translate chapter", exact: true }).click();
    await expect.poll(() => calls.length).toBe(before + 1);
    assert.equal(calls.at(-1).kind, kind);
    if (kind === "translate") assert.equal(calls.at(-1).engine, chosenEngine);
  }
  await run("transcribe");
  await run("translate", "grok-4.6");
  await openChapter();
  await expect(engine).toHaveValue("grok-4.6");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await run("translate", "grok-4.6");

  await page.route(workflow, async route => {
    if (route.request().method() === "POST")
      await route.fulfill({ status: 409, json: { error: "Fixture settings conflict" } });
    else await route.continue();
  });
  await openChapter();
  await engine.selectOption("composer-2.5");
  await expect(page.getByRole("alert")).toContainText("Fixture settings conflict");
  await expect(engine).toHaveValue("grok-4.6");
  await page.unroute(workflow);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await run("translate", "grok-4.6");

  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  // The dialog opens on its first tab (Profiles): the vision field lives on the
  // Vision tab, so select it before reaching for its label.
  await dialog.getByRole("tab", { name: "Read Text / OCR", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Read Text / OCR", exact: true }).selectOption("composer-2.5");
  // The dialog renders the Save/Cancel actions in both its header and its
  // footer: click the footer pair, the canonical one.
  await dialog.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await state()).preferences.regionAi.translate.engine).toBe("grok-4.6");
  await run("transcribe");
  await run("translate", "grok-4.6");

  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  await engine.selectOption("hy-mt2-manga-v5");
  await expect.poll(async () => (await state()).preferences.regionAi.translate)
    .toEqual({ engine: "hy-mt2-manga-v5", model: "" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await run("translate", "hy-mt2-manga-v5");
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  const imsbee = engine.locator('option[value="imsbee-ko-en-translator"]');
  await expect(imsbee).toHaveAttribute("disabled", "");
  const beforeImsbee = await engine.inputValue();
  await engine.selectOption("imsbee-ko-en-translator").catch(() => {});
  await expect(engine).toHaveValue(beforeImsbee);
  koEnAvailable = true;
  await page.getByRole("button", { name: "Refresh translation models", exact: true }).first().click();
  await expect.poll(async () => imsbee.evaluate((el) => el instanceof HTMLOptionElement && el.disabled)).toBe(false);
  await engine.selectOption("imsbee-ko-en-translator");
  await expect.poll(async () => (await state()).preferences.regionAi.translate)
    .toEqual({ engine: "imsbee-ko-en-translator", model: "" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await run("translate", "imsbee-ko-en-translator");

  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Prepare", exact: true }).click();
  await page.getByRole("button", { name: "Organize", exact: true }).waitFor();
  await page.getByRole("button", { name: "Description model…", exact: true }).click();
  const describeDialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await describeDialog.getByLabel("Page description", { exact: true }).selectOption("qwen3-vl-8b");
  await describeDialog.locator("footer").getByRole("button", { name: "Save", exact: true }).click();
  await expect(describeDialog).toBeHidden();
  await expect.poll(async () => (await state()).preferences.regionAi.describe)
    .toEqual({ engine: "qwen3-vl-8b", model: "" });

  await page.route("**/api/admin/models", async route => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { ok: true, models: [], adapter: "cursor", at: Date.now() } });
      return;
    }
    await route.fulfill({
      json: {
        ok: true,
        rows: engineList().map((item) => ({
          ...item, name: item.label, slug: item.id, seeded: true, probeable: item.id !== "proofreader-a" && item.id !== "proofreader-b",
          probeOperations: item.id === "proofreader-a" || item.id === "proofreader-b" ? [] : ["translate"], operationsLocked: true,
          probes: {},
        })),
        catalogs: { cursor: { adapter: "cursor", at: Date.now(), models: [{ id: "composer-2.5", label: "Composer 2.5" }] } },
      },
    });
  });
  // /admin/settings redirects to Jobs & defaults: the admin Test buttons and the
  // benchmark live on the Jobs grid now.
  await page.goto(`${base}/admin/settings`);
  await expect(page.getByRole("heading", { name: "Jobs & defaults" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Benchmark" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Test \d+ untested/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Test failed \(/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Test all \(/ })).toBeVisible();

  // Picker visibility moved to Models → list: the "Users can pick" switch column
  // and the bulk bar it feeds. Render-only, so nothing billed is clicked.
  await page.goto(`${base}/admin/models/list`);
  await expect(page.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Users can pick" })).toBeVisible();
  await page.locator("table.mtable tbody tr.m-row .keep input[type=checkbox]").first().check();
  await expect(page.getByRole("button", { name: "Show to users" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide from users" })).toBeVisible();
  await page.locator("table.mtable").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/scan-acceptance/admin-models-grid.png", fullPage: false });

  assert.deepEqual(errors, []);
  console.log("Model browser checks passed: named-row picker persists, specialists are rows, failed saves recover, vision/description stay separate, admin Test buttons and picker show/hide controls render without billed clicks.");
} finally {
  await browser.close();
}
