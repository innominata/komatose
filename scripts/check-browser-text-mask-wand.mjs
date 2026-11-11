// Typeset text mask wand: in Wand mode the text mask brush and erase tools send a
// click (with tolerance and grow) instead of a stroke, and the server saves the mask.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  const candidates = existsSync(cache)
    ? readdirSync(cache)
        .filter((n) => /^chromium-\d+$/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((n) => join(cache, n, "chrome-linux64/chrome"))
    : [];
  executable = candidates.find((p) => existsSync(p)) || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : executable);
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const wandResponses = [];
page.on("response", async (r) => {
  if (r.request().method() !== "POST" || !r.url().endsWith("/workflow")) return;
  const body = JSON.parse(r.request().postData() || "{}");
  if (body.wand) wandResponses.push({ body, status: r.status(), json: await r.json().catch(() => ({})) });
});

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  const nav = page.getByRole("navigation", { name: "Chapter workflow" });
  await nav.waitFor();
  await page.locator(".pages > button").first().click();
  await nav.getByRole("button", { name: "Typeset", exact: true }).click();
  const region = page.getByRole("button", { name: /^Region 1(,.*)?$/ });
  await expect(region).toBeVisible();
  await region.click();
  const box = await region.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.getByRole("button", { name: "Text mask brush (B)" }).click();
  await page.locator('[data-find="text-mask-wand"]').click();
  await expect(page.getByLabel("Wand tolerance", { exact: true })).toBeVisible();
  await page.getByLabel("Wand tolerance value").fill("40");
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => wandResponses.length).toBe(1);
  const add = wandResponses[0];
  if (add.status !== 200 || add.body.wand.erase || add.body.wand.tolerance !== 40 || !add.json.doc?.data?.textMask)
    throw new Error(`Wand mask sent ${JSON.stringify(add.body)} and got ${add.status} ${JSON.stringify(add.json).slice(0, 200)}`);

  // Erase keeps Wand mode; the click unmasks the same area.
  await page.getByRole("button", { name: "Erase text mask (E)" }).click();
  await expect(page.locator('[data-find="text-mask-wand"]')).toHaveAttribute("aria-pressed", "true");
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => wandResponses.length).toBe(2);
  const erase = wandResponses[1];
  if (erase.status !== 200 || !erase.body.wand.erase)
    throw new Error(`Wand erase sent ${JSON.stringify(erase.body)} and got ${erase.status}`);

  if (errors.length) throw new Error(`Page errors: ${errors.join("; ")}`);
  console.log("text mask wand ok");
} finally {
  await browser.close();
}
