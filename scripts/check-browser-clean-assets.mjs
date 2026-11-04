import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import assert from "node:assert/strict";
const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run with scripts/test-browser.mjs");
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
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const api = `${base}/api/episodes/fixture-episode`,
    state = async () => (await context.request.get(`${api}/workflow`)).json();
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
  await page.locator('[data-find="clean-assets"]').click();
  const panel = page.getByRole("region", { name: "Cleaning assets" });
  const png = await sharp(
    Buffer.from(
      '<svg width="120" height="60"><rect x="0" y="0" width="120" height="60" rx="6" fill="#e22" fill-opacity=".8"/><text x="10" y="40" font-size="32" fill="white">TITLE</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  await panel.locator("input[type=file]").setInputFiles({
    name: "Title card.png",
    mimeType: "image/png",
    buffer: png,
  });
  await panel.getByRole("button", { name: "Insert", exact: true }).click();
  let saved;
  await expect
    .poll(async () => {
      saved = await state();
      return saved.pages[saved.images[0].id].data.placedAssets?.length;
    })
    .toBe(1);
  const imageId = saved.images[0].id,
    original = saved.pages[imageId].data.placedAssets[0];
  const graphic = page.locator(".placed-assets image").first();
  await graphic.scrollIntoViewIfNeeded();
  const box = await graphic.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 50,
    box.y + box.height / 2 + 20,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => {
      const s = await state();
      return s.pages[imageId].data.placedAssets[0].x;
    })
    .toBeGreaterThan(original.x + 10);
  const resize = page.locator(".placed-assets .handle:not(.rotate)").last();
  await resize.scrollIntoViewIfNeeded();
  const rb = await resize.boundingBox();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2 + 35, rb.y + rb.height / 2 + 20, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const s = await state();
      return s.pages[imageId].data.placedAssets[0].width;
    })
    .toBeGreaterThan(original.width + 10);
  await panel
    .getByRole("spinbutton", { name: "Graphic rotation", exact: true })
    .fill("30");
  await panel
    .getByRole("spinbutton", { name: "Graphic rotation", exact: true })
    .press("Tab");
  await expect
    .poll(async () => {
      const s = await state();
      return s.pages[imageId].data.placedAssets[0].rotation;
    })
    .toBe(30);
  await page.screenshot({ path: "/tmp/komatose-clean-assets-desktop.png" });
  await panel.locator("article").dragTo(page.locator(".canvas-page").last(), {
    targetPosition: { x: 200, y: 220 },
  });
  await expect
    .poll(async () => {
      const s = await state();
      return s.pages[imageId].data.placedAssets.length;
    })
    .toBe(2);

  const blue = await sharp({
    create: { width: 80, height: 50, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  await panel
    .getByRole("button", { name: "Replace Title card.png", exact: true })
    .click();
  await panel.locator("input[type=file]").setInputFiles({
    name: "New title.png",
    mimeType: "image/png",
    buffer: blue,
  });
  await expect(
    panel.getByRole("button", { name: "Delete New title.png", exact: true }),
  ).toBeVisible();
  const replaced = (await state()).pages[imageId].data.placedAssets[0];
  expect(replaced.hash).toBe(original.hash);
  await panel
    .getByRole("button", { name: "Delete New title.png", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Insert", exact: true }),
  ).toHaveCount(0);
  const src = await graphic.getAttribute("href");
  expect((await context.request.get(`${base}${src}`)).ok()).toBeTruthy();
  await page.reload();
  await expect(async () => {
    await clean.click();
    await expect(clean).toHaveClass(/active/);
  }).toPass();
  await page.locator('[data-find="clean-assets"]').click();
  await expect(page.locator(".placed-assets image")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Upload PNGs", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/komatose-clean-assets-mobile.png" });
  expect(errors).toEqual([]);
  console.log(
    "Clean assets browser passed: upload, insert, drag, resize, rotate, replace/delete library, retained placement and reload.",
  );
} finally {
  await browser.close();
}
