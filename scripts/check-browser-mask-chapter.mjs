/** UI acceptance without model calls; server and worker behavior have their own tests. */
import { chromium, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { join } from "node:path";
import assert from "node:assert/strict";
const base = process.env.SCAN_TEST_BASEURL,
  data = process.env.SCAN_TEST_DATA;
assert.ok(base && data, "Run with scripts/test-browser.mjs");
const db = new Database(join(data, "scan.db"));
db.prepare("DELETE FROM lines WHERE episode_id='fixture-episode'").run();
db.close();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.SCAN_TEST_CHROMIUM || "/usr/bin/chromium",
});
try {
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  await context.addCookies([
    {
      name: "scan_session",
      value: "fixture-local-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const page = await context.newPage(),
    errors = [],
    actions = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(
    "**/api/episodes/fixture-episode/workflow",
    async (route) => {
      const req = route.request();
      if (
        req.method() === "POST" &&
        req.postDataJSON()?.action === "mask-chapter"
      ) {
        actions.push(req.postDataJSON());
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ jobId: "fixture-chapter-mask" }),
        });
      }
      return route.continue();
    },
  );
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page
    .locator("aside.pages")
    .getByRole("button", { name: "Open page 1", exact: true })
    .click();
  const clean = page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Clean", exact: true });
  await expect(async () => {
    await clean.click();
    await expect(clean).toHaveClass(/active/);
  }).toPass();
  const button = page.locator('[data-find="mask-chapter"]');
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({
    action: "mask-chapter",
    maskEngine: "auto",
    expansion: 5,
  });
  await expect(
    page.getByText(
      "Detecting lettering on every chapter page. No regions are needed. Inspect the masks before cleaning.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/komatose-mask-chapter-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(button).toBeVisible();
  await page.screenshot({ path: "/tmp/komatose-mask-chapter-mobile.png" });
  expect(errors).toEqual([]);
  console.log("Mask chapter UI passed with no regions on desktop and mobile.");
} finally {
  await browser.close();
}
