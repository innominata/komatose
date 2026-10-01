/** Run with: node scripts/test-browser.mjs scripts/check-browser-provider-catalog.mjs */
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
  id, label, available: extra.available !== false, group, operations, pageImageOnly: extra.pageImageOnly, reason: extra.reason, access: extra.access,
});
let grokAvailable = false;
let grokReason = "CLI executable not found";
let omitProofreader = false;
const engineList = () => [
  row("qwen3.8-27b-q4", "Qwen 3.8 27B", "Local models", CHAT),
  row("review-qualified", "Review Qualified", "Remote models", CHAT, { access: "remote_http" }),
  row("hy-mt2-manga-v5", "Hy-MT2 1.8B Manga v5", "Local models", ["translate"]),
  row("hayai-ocr-v2", "Hayai OCR v2", "Local models", ["vision"]),
  row("grok-4.6", "Grok 4.6", "CLI agents", CHAT, { available: grokAvailable, reason: grokReason, access: "cli" }),
  row("gpt-5.4", "GPT-5.4", "CLI agents", CHAT, { access: "cli" }),
  row("composer-2.5", "Composer 2.5", "CLI agents", CHAT, { access: "cli" }),
  ...omitProofreader ? [] : [
    row("proofreader-a", "Proofreader A", "Proofreaders", ["pageImageProofread"], { pageImageOnly: true }),
    row("proofreader-b", "Proofreader B", "Proofreaders", ["pageImageProofread"], { pageImageOnly: true }),
  ],
];

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  const state = async () => (await context.request.get(workflow)).json();
  const originalModels = {
    translate: { engine: "proofreader-a", model: "" },
    vision: { engine: "proofreader-a", model: "" },
    describe: { engine: "qwen", model: "qwen3.8-27b-q4" },
    proofread: { engine: "proofreader-a", model: "" },
    enquire: { engine: "proofreader-a", model: "" },
    reviewers: [{ engine: "qwen", model: "hayai-ocr-v2" }],
  };
  const saved = await context.request.post(workflow, { data: {
    action: "preferences", expectedRevision: (await state()).chapter.revision,
    data: { regionAi: originalModels },
  } });
  assert.ok(saved.ok(), await saved.text());
  const added = await context.request.post(`${base}/api/admin/models`, {
    data: {
      action: "add-remote",
      id: "review-qualified",
      name: "Review Qualified",
      slug: "review-model",
      baseUrl: "https://remote.example/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      operations: CHAT,
    },
  });
  assert.ok(added.ok(), await added.text());

  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/api/ai/engines", route => {
    const engines = engineList();
    return route.fulfill({
      json: {
        engines,
        rows: engines,
        translationEngines: engines.filter((item) => item.operations.includes("translate")),
        sourceReviewEngines: engines.filter((item) => !item.pageImageOnly),
        localReviewModels: [{ id: "hayai-ocr-v2", label: "Hayai OCR v2" }],
        transcriptionModels: engines.filter((item) => item.operations.includes("vision") && !item.pageImageOnly),
      },
    });
  });
  await page.route(/\/api\/episodes\/fixture-episode\/ai-(transcribe|translate)$/, async route => {
    if (route.request().method() === "POST") {
      calls.push({ kind: route.request().url().split("ai-").at(-1), ...route.request().postDataJSON() });
      await route.fulfill({ status: 202, json: { ok: true } });
    } else await route.fulfill({ json: { engines: engineList() } });
  });
  await page.route("**/api/episodes/fixture-episode/region-ai", async route => {
    if (route.request().method() === "POST") {
      calls.push({ kind: "enquire", ...route.request().postDataJSON() });
      await route.fulfill({ json: { answer: "should not run", cards: [] } });
    } else await route.continue();
  });
  await page.route("**/api/episodes/fixture-episode/page-proofread", async route => {
    if (route.request().method() === "POST") {
      calls.push({ kind: "page-proofread", ...route.request().postDataJSON() });
      await route.fulfill({ json: { ok: true, jobId: "fixture-page-proofread" } });
    } else await route.continue();
  });

  async function openTranslate() {
    await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
    await page.waitForFunction(() => document.body.dataset.studioReady === "1");
    await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
    await page.locator(".pages > button").first().click();
    await page.getByRole("group", { name: "Run on" }).getByRole("button", { name: "Whole chapter", exact: true }).click();
    await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
    await page.getByRole("tab", { name: "Translation", exact: true }).click();
  }

  await openTranslate();
  const engine = page.getByRole("combobox", { name: "Translation model", exact: true }).first();
  const translate = page.getByRole("button", { name: "Translate chapter", exact: true });
  const transcribe = page.getByRole("button", { name: "Transcribe chapter", exact: true });
  await expect(engine).toHaveValue("proofreader-a");
  await expect(page.getByRole("status").filter({ hasText: "only for Proofread raw + typeset images" }).first()).toBeVisible();
  await expect(translate).toBeDisabled();
  await expect(transcribe).toBeEnabled();
  const before = calls.length;
  await translate.click({ force: true }).catch(() => {});
  assert.equal(calls.length, before);

  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await transcribe.click();
  await expect.poll(() => calls.some((call) => call.kind === "transcribe")).toBe(true);

  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await expect(dialog).toBeVisible();
  // The vision picker lives on the Vision tab of the settings dialog.
  await dialog.getByRole("tab", { name: "Read Text / OCR", exact: true }).click();
  const vision = dialog.getByRole("combobox", { name: "Read Text / OCR", exact: true });
  await expect(vision).toHaveValue("proofreader-a");
  await expect(dialog.getByText("Proofreader A is only for Proofread raw + typeset images.").first()).toBeVisible();
  const grokVision = vision.locator('option[value="grok-4.6"]');
  await expect.poll(async () => grokVision.evaluate((el) => el instanceof HTMLOptionElement && el.disabled)).toBe(true);
  await dialog.getByRole("button", { name: "Cancel" }).first().click();

  grokAvailable = true;
  grokReason = "CLI installed; authentication is checked by the CLI when run";
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Read Text / OCR", exact: true }).click();
  await expect.poll(async () => grokVision.evaluate((el) => el instanceof HTMLOptionElement && el.disabled)).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).first().click();

  omitProofreader = true;
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  await page.getByRole("button", { name: "Refresh translation models", exact: true }).first().click();
  await expect(engine).toHaveValue("proofreader-a");
  await expect(page.getByText(/unknown until model status refreshes|only for Proofread raw \+ typeset images/).first()).toBeVisible();
  await expect(translate).toBeDisabled();
  omitProofreader = false;
  await page.getByRole("button", { name: "Refresh translation models", exact: true }).first().click();
  await expect(engine).toBeEnabled();

  await engine.selectOption("qwen3.8-27b-q4");
  await expect.poll(async () => (await state()).preferences.regionAi.translate).toEqual({ engine: "qwen3.8-27b-q4", model: "" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(translate).toBeEnabled();
  const afterSwitch = calls.length;
  await translate.click();
  await expect.poll(() => calls.length).toBe(afterSwitch + 1);
  assert.equal(calls.at(-1).engine, "qwen3.8-27b-q4");

  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  await engine.selectOption("hy-mt2-manga-v5");
  await expect.poll(async () => (await state()).preferences.regionAi.translate)
    .toEqual({ engine: "hy-mt2-manga-v5", model: "" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await translate.click();
  await expect.poll(() => calls.at(-1)?.engine).toBe("hy-mt2-manga-v5");

  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  await page.getByRole("tab", { name: "Translation", exact: true }).click();
  await engine.selectOption("review-qualified");
  await expect.poll(async () => (await state()).preferences.regionAi.translate)
    .toEqual({ engine: "review-qualified", model: "" });
  await expect(translate).toBeEnabled();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await translate.click();
  await expect.poll(() => calls.at(-1)?.engine).toBe("review-qualified");

  await page.getByRole("button", { name: "Open page 1", exact: true }).click();
  const card = page.locator("#region-card-fixture-line-0-0");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /^#\d/ }).click();
  await card.getByRole("button", { name: "Enquire", exact: true }).click();
  const enquire = page.getByRole("dialog", { name: "Enquire about region", exact: true });
  await expect(enquire).toBeVisible();
  const chatEngine = enquire.getByLabel("Chat", { exact: true });
  await expect(chatEngine).toHaveValue("proofreader-a");
  const send = enquire.getByRole("button", { name: "Send", exact: true });
  await enquire.getByLabel("Your question").fill("What does this line mean?");
  await expect(send).toBeDisabled();
  const enquireBefore = calls.filter((call) => call.kind === "enquire").length;
  await send.click({ force: true }).catch(() => {});
  assert.equal(calls.filter((call) => call.kind === "enquire").length, enquireBefore);
  await chatEngine.selectOption("qwen3.8-27b-q4");
  await expect(send).toBeEnabled();
  await enquire.getByRole("button", { name: "Close AI dialog" }).click();

  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Review", exact: true }).click();
  const pageProofread = page.getByRole("button", { name: "Proofread raw + typeset images", exact: true });
  await expect(pageProofread).toBeEnabled();
  const proofBefore = calls.filter((call) => call.kind === "page-proofread").length;
  await pageProofread.click();
  await expect.poll(() => calls.filter((call) => call.kind === "page-proofread").length).toBe(proofBefore + 1);

  assert.deepEqual(errors, []);
  console.log("Provider catalog browser checks passed: Proofreaders cannot translate or enquire, page-image proofread still runs, refresh updates live availability, specialists are named rows, live remote rows can be selected and run.");
} finally {
  await browser.close();
}
