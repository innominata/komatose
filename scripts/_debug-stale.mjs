/** Debug: why doesn't the stale suggestion card render? */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable = readdirSync(cache)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((n) => join(cache, n, "chrome-linux64/chrome"))
      .find((p) => existsSync(p)) || executable;
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 300)));
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").nth(1).click();
  await page.waitForTimeout(600);

  const state = await (await context.request.get(workflow)).json();
  const line = state.lines.find((l) => l.id === "fixture-line-0-1");
  console.log("line:", JSON.stringify(line && { id: line.id, imageId: line.imageId, revision: line.revision, body: line.body }));
  console.log("pages sidebar buttons:", await page.locator(".pages > button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label") || b.title || b.textContent?.trim())));
  console.log("images order:", JSON.stringify((state.images || []).map((i) => ({ id: i.id, pageNumber: i.pageNumber }))));
  console.log("line on screen:", await page.getByText("Are you really going?").count());

  const env = JSON.parse(readFileSync("/tmp/scan-browser-env.json", "utf8"));
  const db = new Database(env.db);
  db.prepare(
    "INSERT OR IGNORE INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(`${line.id}:translation:Stale after edit`, "fixture-episode", line.id, (line.revision ?? 0) - 1, "Stale after edit", "fixture", "translation", Date.now(), "stale translation");
  db.close();

  const after = await (await context.request.get(workflow)).json();
  const sugg = (after.suggestions || []).filter((s) => s.line_id === line.id);
  console.log("payload suggestions for line:", JSON.stringify(sugg));

  await page.waitForTimeout(1500);
  console.log("dom .suggestion count:", await page.locator(".suggestion").count());
  console.log("dom suggestion texts:", await page.locator(".suggestion").allTextContents());
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1500);
    const n = await page.locator(".suggestion").count();
    console.log(`t+${(i + 1) * 1.5}s .suggestion count:`, n);
    if (n) break;
  }
  console.log("pageerrors:", errors);
  await page.screenshot({ path: "/tmp/scan-acceptance/debug-stale.png" });
} finally {
  await browser.close();
}
