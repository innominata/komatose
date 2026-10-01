/** Run only with scripts/test-browser.mjs: isolated app, no real GPU models. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Use the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable =
      readdirSync(cache)
        .filter((name) => name.startsWith("chromium-"))
        .flatMap((name) => [
          join(cache, name, "chrome-linux64/chrome"),
          join(cache, name, "chrome-linux/chrome"),
        ])
        .find(existsSync) || executable;
}

const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
await context.addCookies([
  {
    name: "scan_session",
    value: "fixture-local-session",
    domain: "127.0.0.1",
    path: "/",
  },
]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const api = `${base}/api/admin/model-benchmark`;
try {
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(api)).status(), 401);
  assert.equal((await anonymous.request.get(`${api}?page=007`)).status(), 401);
  await anonymous.close();

  const listed = await (await context.request.get(api)).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.available, true, "fixtures/test-pages ships with the app");
  assert.deepEqual(
    listed.pages.map((item) => item.id),
    ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010"],
  );
  const setups = listed.detectors.map((item) => item.id);
  for (const id of ["rtdetr", "ctd", "paddle", "heuristic", "coo", "koharu", "rtdetr+coo+koharu"])
    assert.ok(setups.includes(id), `detector setup ${id}`);
  assert.ok(setups.includes(listed.chapterSetup));
  assert.equal(listed.baseline.official, 1);
  assert.ok(listed.ocrModels.every((row) => row.id !== "qwen3-vl-4b"));

  const image = await context.request.get(`${api}?page=007`);
  assert.equal(image.status(), 200);
  assert.equal(image.headers()["content-type"], "image/jpeg");
  assert.equal((await context.request.get(`${api}?page=007&lang=en`)).status(), 200);
  assert.equal((await context.request.get(`${api}?page=999`)).status(), 404);

  const retired = await context.request.post(api, { data: { kind: "ocr", models: ["qwen3-vl-4b"] } });
  assert.equal(retired.status(), 400);
  assert.equal((await context.request.post(api, { data: { kind: "ocr", detectors: ["nope"] } })).status(), 400);
  assert.equal((await context.request.post(api, { data: { kind: "translation", models: [] } })).status(), 400);
  assert.equal((await context.request.post(api, { data: {} })).status(), 400);
  assert.deepEqual(await (await context.request.post(api, { data: { action: "cancel" } })).json(), { ok: true, cancelled: false });

  const hubApi = `${base}/api/admin/model-hub`;
  assert.equal((await context.request.post(hubApi, { data: { action: "set-detector", setup: "heuristic+koharu" } })).status(), 400);
  const savedDetector = await (await context.request.post(hubApi, { data: { action: "set-detector", setup: "heuristic", conf: 0.35 } })).json();
  assert.deepEqual([savedDetector.detector.setup, savedDetector.detector.conf, savedDetector.detector.saved], ["heuristic", 0.35, true]);
  assert.equal((await context.request.get(`${api}`).then((res) => res.json())).chapterSetup, "heuristic");

  await page.goto(`${base}/admin/models/jobs`);
  const detectorField = page.getByRole("combobox", { name: "Text detector" });
  await expect(detectorField).toHaveValue("heuristic");
  await expect(page.getByRole("spinbutton", { name: "Detection confidence" })).toHaveValue("0.35");
  // The heuristic detector runs alone, so both add-ons are locked off.
  await expect(page.getByRole("checkbox", { name: "COO", exact: true })).toBeDisabled();
  const panel = page.getByRole("region", { name: "Benchmark" });
  await expect(panel.getByText("Give My Regards to Black Jack", { exact: false })).toBeVisible();
  await expect(panel.getByText("Text detectors")).toBeVisible();
  await expect(panel.getByText("Comic Text Detector", { exact: true }).first()).toBeVisible();
  await expect(panel.getByText("Koharu SAM-TS-L alone").first()).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /Gold boxes/ })).toBeChecked();
  // A fresh install has no saved run, so no result tables yet.
  await expect(panel.getByRole("table", { name: "Detection results" })).toHaveCount(0);
  const dataDir = process.env.SCAN_TEST_DATA;
  assert.ok(dataDir, "fixture data dir");
  const score = { targets: 1, found: 1, dialogueTargets: 1, dialogueFound: 1, sfxTargets: 0, sfxFound: 0, optionalTargets: 0, optionalFound: 0, detections: 1, correct: 1, neutral: 0, falseAlarms: 0, missed: [], falseIndexes: [], recall: 1, precision: 1, f1: 1 };
  const blank = { page: "007", ms: 1000, boxes: [], score };
  mkdirSync(join(dataDir, "run"), { recursive: true });
  const ocrPage = { page: "007", ms: 400, regions: 1, output: "", lines: [], noise: 0, outputChars: 0 };
  writeFileSync(join(dataDir, "run", "model-benchmark-ocr.json"), JSON.stringify({
    kind: "ocr", id: "saved", at: Date.UTC(2026, 8, 26), finishedAt: Date.UTC(2026, 8, 26), state: "done",
    progress: { done: 1, total: 1, step: "Finished" }, pages: ["007"],
    models: [
      { id: "alpha-ocr", name: "Alpha OCR", source: "gold", sourceLabel: "Gold boxes", state: "done", at: Date.UTC(2026, 8, 26), pages: [ocrPage], totals: { dialogue: 0.5, other: 0.2, noise: 0.3, lines: 2, exact: 0 } },
      { id: "zebra-ocr", name: "Zebra OCR", source: "gold", sourceLabel: "Gold boxes", state: "done", at: Date.UTC(2026, 8, 26), pages: [ocrPage], totals: { dialogue: 0.9, other: 0.1, noise: 0.05, lines: 2, exact: 1 } },
    ],
    detectors: [
      { id: "ctd", label: "Comic Text Detector", state: "done", at: Date.UTC(2024, 0, 2), pages: [blank], totals: { ...score, f1: 0.4, recall: 0.4, precision: 0.4 } },
      { id: "rtdetr", label: "RT-DETR", state: "done", at: Date.UTC(2026, 8, 26), pages: [blank], totals: score },
    ],
  }));
  writeFileSync(join(dataDir, "run", "model-benchmark-translation.json"), JSON.stringify({
    kind: "translation", id: "saved-tr", at: Date.UTC(2026, 8, 26), finishedAt: Date.UTC(2026, 8, 26), state: "done",
    progress: { done: 1, total: 1, step: "Finished" }, pages: ["009"],
    models: [
      { id: "alpha-tr", name: "Alpha Translate", state: "done", at: Date.UTC(2026, 8, 26), pages: [{ page: "009", ms: 100, lines: [] }], totals: { official: 0.2, literal: 0.4, meaning: 0.5, lines: 1, missing: 0 } },
      { id: "zeta-tr", name: "Zeta Translate", state: "done", at: Date.UTC(2026, 8, 26), pages: [{ page: "009", ms: 200, lines: [] }], totals: { official: 0.8, literal: 0.1, meaning: 0.9, lines: 1, missing: 0 } },
    ],
  }));
  await page.reload();
  const results = panel.getByRole("table", { name: "Detection results" });
  await expect(results).toBeVisible();
  await expect(results.locator("tbody tr").first()).toContainText("RT-DETR");
  await results.getByRole("button", { name: "Detector" }).click();
  await expect(results.locator("tbody tr").first()).toContainText("Comic Text Detector");
  await expect(results.getByRole("columnheader", { name: /Detector/ })).toHaveAttribute("aria-sort", "ascending");
  await results.getByRole("button", { name: "F1" }).click();
  await expect(results.locator("tbody tr").first()).toContainText("RT-DETR");
  await expect(results.getByRole("columnheader", { name: /F1/ })).toHaveAttribute("aria-sort", "descending");
  const ocrResults = panel.getByRole("table", { name: "OCR results" });
  await expect(ocrResults.locator("tbody tr").first()).toContainText("Zebra OCR");
  await ocrResults.getByRole("button", { name: "Model" }).click();
  await expect(ocrResults.locator("tbody tr").first()).toContainText("Alpha OCR");
  await expect(results.getByRole("row", { name: /Comic Text Detector/ })).toContainText("2024");
  await expect(results.getByRole("row", { name: /RT-DETR/ })).not.toContainText("2024");
  await expect(panel.getByText("earlier results stay listed")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run OCR benchmark" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Select all", exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Select none", exact: true }).click();
  await expect(panel.getByRole("checkbox", { name: /Comic Text Detector/ }).first()).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Run OCR benchmark" })).toBeDisabled();
  await expect(panel.getByRole("img", { name: "Page 007" })).toBeVisible();
  await panel.getByRole("tab", { name: "005" }).click();
  await expect(panel.getByText("No lettering to read on this page.")).toBeVisible();
  await expect(panel.getByText(/qwen3-vl-4b/)).toHaveCount(0);

  await panel.getByRole("tab", { name: "Translation" }).click();
  await expect(panel.getByText("Translation models")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Run translation benchmark" })).toBeVisible();
  const trResults = panel.getByRole("table", { name: "Translation results" });
  await expect(trResults.locator("tbody tr").first()).toContainText("Zeta Translate");
  await expect(trResults.locator("tbody tr").last()).toContainText("Official English");
  await trResults.getByRole("button", { name: "Model" }).click();
  await expect(trResults.locator("tbody tr").first()).toContainText("Alpha Translate");
  await expect(trResults.locator("tbody tr").last()).toContainText("Official English");
  await panel.getByRole("button", { name: "Select none", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Run translation benchmark" })).toBeDisabled();
  await expect(panel.getByText("Official English", { exact: true })).toBeVisible();
  await expect(panel.getByText("研修医というのは要するに見習いだ")).toBeVisible();
  await expect(panel.getByText("Interns are basically apprentices.")).toBeVisible();
  await expect(panel.getByRole("img", { name: "Page 009, official English" })).toBeVisible();
  assert.deepEqual(errors, []);
  console.log("Benchmark panel is on Admin → Models → Jobs & defaults");
} finally {
  await browser.close();
}
