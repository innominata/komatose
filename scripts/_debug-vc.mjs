/** Transient debug: dump the Vision picker options in the AI model settings dialog. */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assertish(base);
function assertish(v) { if (!v) throw new Error("fixture runner required"); }
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, "chrome-linux64/chrome"))
      .find((path) => existsSync(path)) || executable;
}

const CHAT = ["translate", "vision", "describe", "proofreadEnglish", "chapterReview", "advisory", "compactNotes", "alternatives", "pageImageProofread"];
const row = (id, label, group, operations, extra = {}) => ({
  id, label, available: extra.available !== false, group, operations, pageImageOnly: extra.pageImageOnly, reason: extra.reason, access: extra.access,
});
const engineList = () => [
  row("qwen3.8-27b-q4", "Qwen 3.8 27B", "Local models", CHAT),
  row("hayai-ocr-v2", "Hayai OCR v2", "Local models", ["vision"]),
  row("grok-4.6", "Grok 4.6", "CLI agents", CHAT, { available: false, reason: "CLI executable not found", access: "cli" }),
  row("proofreader-a", "Proofreader A", "Proofreaders", ["pageImageProofread"], { pageImageOnly: true }),
];

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
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
  console.log("SAVE:", saved.status(), (await saved.text()).slice(0, 200));
  const after = await state();
  console.log("PREFS vision:", JSON.stringify(after.preferences?.regionAi?.vision), "proofread:", JSON.stringify(after.preferences?.regionAi?.proofread));

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.route("**/api/ai/engines", route => {
    const engines = engineList();
    return route.fulfill({ json: {
      engines, rows: engines,
      translationEngines: engines.filter((i) => i.operations.includes("translate")),
      sourceReviewEngines: engines.filter((i) => !i.pageImageOnly),
      localReviewModels: [{ id: "hayai-ocr-v2", label: "Hayai OCR v2" }],
      transcriptionModels: engines.filter((i) => i.operations.includes("vision") && !i.pageImageOnly),
    } });
  });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForTimeout(4000);
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  await page.getByRole("heading", { name: "Translate the chapter" }).waitFor();
  await page.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await dialog.getByRole("tab", { name: "Vision", exact: true }).click();
  const dump = async (label) => {
    const sel = dialog.getByLabel(label, { exact: true });
    const n = await sel.count();
    console.log(label, "count:", n);
    if (n) console.log(label, "html:", (await sel.first().evaluate((el) => el.outerHTML)).slice(0, 1500));
  };
  await dump("AI Vision / Read area");
  await dialog.getByRole("tab", { name: "Proofreading", exact: true }).click();
  await dump("Proofreading (English / page images)");
} finally {
  await browser.close();
}
