/** Run with: node scripts/test-browser.mjs scripts/check-browser-model-test-progress.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable =
      readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((name) => join(cache, name, "chrome-linux64/chrome"))
        .find((path) => existsSync(path)) || executable;
}

// Two ready rows, four untested jobs between them: enough to prove the run goes a few at a
// time instead of firing everything at once.
const rows = [
  { id: "fixture-chat", name: "Fixture Chat", slug: "fixture-chat", access: "local_http", disabled: false, qualificationAdapter: "general", implementedTasks: ["translate", "vision", "sourceReview", "advisory", "chapterReview", "compactNotes", "proofreadEnglish", "alternatives", "describe", "pageImageProofread"], capabilityFingerprints: { conversation: "fixture", translation: "fixture", transcription: "fixture", imageUnderstanding: "fixture" }, capabilities: {}, operations: ["translate", "describe"], probes: {} },
  { id: "fixture-vision", name: "Fixture Vision", slug: "fixture-vision", access: "local_http", disabled: false, qualificationAdapter: "general", implementedTasks: ["translate", "vision", "sourceReview", "advisory", "chapterReview", "compactNotes", "proofreadEnglish", "alternatives", "describe", "pageImageProofread"], capabilityFingerprints: { conversation: "fixture", translation: "fixture", transcription: "fixture", imageUnderstanding: "fixture" }, capabilities: {}, operations: ["vision", "advisory"], probes: {} },
];
const hub = () => ({
  ok: true,
  hardware: { llama: { devices: [] } },
  usage: [],
  catalogs: {},
  rows: rows.map((row) => ({ ...row, probes: structuredClone(row.probes) })),
  cliTools: [],
  installs: [],
  queue: [],
  torchVariant: "cpu",
  managed: [],
  reviewServers: [],
  editors: [],
  environments: [],
  defaults: {},
  report: { items: [], summary: { configured: 0, missing: 0, unavailable: 0 }, nextSteps: [] },
});

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([
    { name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  // Probes answer only when released, so the spinners are observable; each one that lands is
  // written back into the hub payload, exactly like the real endpoint saves its result.
  const held = [];
  let released = false;
  const record = (body) => {
    const row = rows.find((item) => item.id === body.id);
    if (row) {
      const checks = ['transcription', 'imageUnderstanding'].includes(body.check) ? ['transcription', 'imageUnderstanding'] : [body.check];
      for (const capability of checks) row.capabilities[capability] = { capability, fingerprint: 'fixture', outcome: 'passed', ok: true, at: Date.now(), ms: 12 };
    }
  };
  await page.route("**/api/admin/model-hub", (route) => route.fulfill({ json: hub() }));
  await page.route("**/api/admin/models", async (route) => {
    const body = route.request().postDataJSON();
    if (route.request().method() !== "POST" || body?.action !== "test")
      return route.fulfill({ json: { ok: true, rows } });
    if (!released) await new Promise((resolve) => held.push(resolve));
    record(body);
    return route.fulfill({ json: { ok: true, sample: { ok: true, ms: 12 } } });
  });
  const drain = () => {
    released = true;
    while (held.length) held.pop()();
  };

  await page.goto(`${base}/admin/models/jobs`);
  // Two general models need three requests each; image checks share a request.
  // The button renames itself to "Testing…" while its batch runs, so the locator
  // covers both of its states.
  const button = page.getByRole("button", { name: /Test \d+ untested|Testing…/ });
  await expect(button).toHaveText(/Test 6 untested/);

  await button.click();
  // Three at a time: cells spin, the model rows they belong to spin, the count sits beside
  // the button, and the button itself is visibly busy rather than silently dead.
  const busyCells = page.locator(".qualification-matrix td.cell .mx.testing");
  await expect(busyCells).toHaveCount(4);
  assert.deepEqual(
    (await busyCells.evaluateAll(cells => cells.map(cell => cell.getAttribute('title')))).sort(),
    ['conversation', 'translation', 'transcription', 'imageUnderstanding'].map(check => `Testing Fixture Chat · ${check}…`).sort(),
  );
  await expect(page.locator(".qualification-matrix td.cell .mx.testing .test-spin")).toHaveCount(4);
  await expect(page.locator(".qualification-matrix .row-spin")).toHaveCount(1);
  await expect(page.locator(".testing-note")).toContainText("0 of 6 tested");
  await expect(button).toBeDisabled();
  await expect(button).toContainText("Testing…");
  mkdirSync("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({ path: "/tmp/scan-acceptance/model-test-progress.png" });
  await page.locator("table.qualification-matrix").screenshot({ path: "/tmp/scan-acceptance/model-test-progress-grid.png" });

  drain();
  await expect(page.locator(".matrix .mx.testing")).toHaveCount(0);
  await expect(page.locator(".testing-note")).toHaveCount(0);
  // Six requests populate eight capability results and derive job availability.
  await expect(page.locator(".qualification-matrix td.cell .mx.on.untested")).toHaveCount(0);
  await expect(page.locator(".qualification-matrix td.cell .mx.on:not(.fail)")).toHaveCount(8);
  await expect(button).toHaveText(/Test 0 untested/);
  await expect(page.locator(".toast")).toContainText("Completed 6 checks — results are in the grid.");
  await page.screenshot({ path: "/tmp/scan-acceptance/model-test-progress-done.png" });

  await expect(page.locator('td[title="Available from Conversation + Translation"]').first()).toBeVisible();
  assert.equal(held.length, 0);
  assert.deepEqual(errors, []);
  console.log("Model test progress checks passed: spinners per cell and model row, live count, then results fill the grid.");
} finally {
  await browser.close();
}
