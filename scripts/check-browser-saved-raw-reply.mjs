/** Proofread Raw opens a page's saved raw reply; Replies can delete one. No model calls. */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
const root = process.env.SCAN_TEST_DATA;
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, "chrome-linux64/chrome"))
    .find(p => existsSync(p)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const dialogs = [];
page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const proofreads = async () => (await state()).jobs.filter(j => j.kind === "page-proofread");

try {
  const before = await state();
  const imageId = before.images[0].id;
  const db = new Database(join(root, "scan.db"));
  db.prepare(`INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at)
    VALUES('saved-raw','fixture-episode','page-proofread','completed',?,?,?,?)`).run(
    JSON.stringify({ imageId, mode: "raw" }),
    JSON.stringify({ critique: "Saved raw reading: panel 1 says ここで待って (Wait here)." }),
    Date.now() - 60_000, Date.now() - 60_000);
  db.close();
  const jobsBefore = (await proofreads()).length;

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  const translate = page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true });
  await expect(async () => { await translate.click(); await expect(translate).toHaveClass(/active/); }).toPass();
  await page.getByRole("complementary", { name: "Pages in chapter order" }).getByRole("button", { name: "Open page 1", exact: true }).click();

  // Proofread Raw opens the saved reply instead of sending the page again.
  const raw = page.locator('[data-find="proofread-raw"]');
  await expect(raw).toHaveAttribute("title", /Open this page’s saved raw reply/);
  await raw.click();
  await expect(page.locator(".saved-proofread-window")).toContainText("Saved raw reading: panel 1 says");
  await expect(page.getByRole("button", { name: "Proofread again", exact: true })).toBeVisible();
  expect((await proofreads()).length).toBe(jobsBefore);
  await page.screenshot({ path: "/tmp/komatose-saved-raw-reply.png" });

  // Delete it from the Replies tab: the window closes and the reply is gone.
  await page.locator('[data-find="tab-proofread-replies"]').click();
  await page.getByRole("button", { name: /^Delete Raw reply from / }).click();
  expect(dialogs.at(-1)).toMatch(/Delete the Raw reply.*cannot be undone/s);
  await expect.poll(async () => (await proofreads()).some(j => j.id === "saved-raw")).toBe(false);
  await expect(page.locator(".saved-proofread-window")).toHaveCount(0);
  await expect(page.getByText("No saved replies for this page yet.")).toBeVisible();
  await expect(raw).not.toHaveAttribute("title", /Open this page’s saved raw reply/);

  // A reply that no longer exists is reported, not silently accepted.
  const refused = await context.request.post(`${api}/workflow`, { data: { action: "delete-proofread-reply", jobId: "missing-reply" } });
  expect(refused.status()).toBe(404);
  expect(errors).toEqual([]);
  console.log("Browser saved raw reply passed: Proofread Raw opens the saved reply without a new job, and Replies deletes it.");
} finally {
  await browser.close();
}
