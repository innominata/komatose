/** Run with: node scripts/test-browser.mjs scripts/check-browser-review.mjs */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium } from "@playwright/test";
import { checkRegionAi } from "./check-browser-region-ai.mjs";
import { checkReviewSafety } from "./check-browser-review-safety.mjs";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    executable = readdirSync(cache)
      .filter(name => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map(name => join(cache, name, "chrome-linux64/chrome"))
      .find(path => existsSync(path)) || executable;
  }
}
const fixture = JSON.parse(readFileSync("/tmp/scan-browser-env.json", "utf8"));
const db = new Database(fixture.db);
function insertSuggestions(lineId, revision, items) {
  for (const [body, kind, translation = ""] of items) {
    db.prepare("INSERT OR IGNORE INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(`${lineId}:${kind}:${body}`, "fixture-episode", lineId, revision, body, "fixture", kind, Date.now(), translation);
  }
}
const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true }).click();
  await checkRegionAi({ page, context, base, insertSuggestions });
  await checkReviewSafety({ page, context, base });
  assert.deepEqual(errors, []);
  console.log("AI review browser checks passed: explicit paid model selection, local-only sends, settings changes during preparation, right-click access, English before acceptance, paired saving, desktop/mobile layout, partial failure, and enquiry conflicts.");
} finally {
  await browser.close();
  db.close();
}
