/** Walk every Find an action entry and confirm it lands on its target. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const dumped = spawnSync(
  process.execPath,
  ["--import", "tsx", "--eval", "import { STUDIO_ACTIONS } from './src/lib/studioActions.ts'; process.stdout.write(JSON.stringify(STUDIO_ACTIONS))"],
  { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
);
assert.equal(dumped.status, 0, dumped.stderr);
const actions = JSON.parse(dumped.stdout);

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

const browser = await chromium.launch({ executablePath: executable, headless: true });
const misses = [];
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.locator(".pages > button").first().click();

  for (const action of actions) {
    await page.keyboard.press("Control+k");
    const finder = page.getByRole("dialog", { name: "Find an action" });
    const box = finder.getByRole("textbox", { name: "Find an action" });
    await box.fill(action.label);
    await page.waitForFunction((label) => [...document.querySelectorAll(".finder [role=option] span")].some((el) => el.textContent?.trim() === label), action.label, { timeout: 3000 }).catch(() => {});
    const options = finder.getByRole("option");
    const count = await options.count();
    let option = null;
    for (let i = 0; i < count; i++) {
      const text = (await options.nth(i).locator("span").first().innerText()).trim();
      if (text === action.label) {
        option = options.nth(i);
        break;
      }
    }
    if (!option) {
      misses.push(`${action.label}: no finder result`);
      await page.keyboard.press("Escape");
      continue;
    }
    await option.click();
    const landed = await page.waitForFunction((item) => {
      const flash = item.find
        ? document.querySelector(`[data-find="${CSS.escape(item.find)}"].studio-flash`)
        : true;
      const menuRoot = document.querySelector(".actions-menu, .more-menu, .issues-pop, .keys-dialog");
      const menuHit = !item.go.menuFind || (menuRoot?.textContent || "").includes(item.go.menuFind);
      return !!flash && menuHit;
    }, action, { timeout: 4000 }).then(() => true).catch(() => false);
    if (!landed) misses.push(`${action.id} ${action.label} find=${action.find || "-"} menu=${action.go.menuFind || "-"}`);
    if (await page.getByRole("button", { name: "Close settings", exact: true }).count())
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
    if (await page.getByRole("button", { name: "Close keyboard shortcuts", exact: true }).count())
      await page.getByRole("button", { name: "Close keyboard shortcuts", exact: true }).click();
    await page.keyboard.press("Escape");
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}

if (misses.length) {
  console.error(misses.join("\n"));
  process.exit(1);
}
console.log(`Studio catalog walk passed: ${actions.length} actions open their target.`);
