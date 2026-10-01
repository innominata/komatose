/** Transient debug: run the add-local flow and dump the toast. */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
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
const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const posts = [];
page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/admin/")) posts.push(`${r.url().replace(base, "")} ${r.postData()}`); });
page.on("response", async (r) => { if (r.request().method() === "POST" && r.url().includes("/api/admin/") && r.status() >= 400) posts.push(`FAIL ${r.status()} ${r.url().replace(base, "")} ${await r.text().catch(() => "")}`); });
await page.goto(`${base}/admin/models/list`);
await page.waitForTimeout(5000);
await page.getByRole("button", { name: /add model/i }).click();
const dialog = page.getByRole("dialog", { name: /^add model$/i });
await dialog.getByRole("button", { name: /^local model$/i }).click();
await dialog.getByRole("radio", { name: /Other llama\.cpp model/ }).click();
await dialog.getByLabel(/^name$/i).fill("Browser local fixture");
await dialog.getByLabel(/^model id$/i).fill("browser-managed-fixture");
await dialog.getByRole("button", { name: /^add model$/i }).click();
await page.waitForTimeout(4000);
console.log("DIALOG OPEN:", await dialog.isVisible().catch(() => false));
console.log("POSTS:", JSON.stringify(posts, null, 1));
console.log("TOASTS:", await page.locator(".toasts").ariaSnapshot().catch((e) => String(e)));
console.log("ERRORS:", JSON.stringify(errors));
await browser.close();
