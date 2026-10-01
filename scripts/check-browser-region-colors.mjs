/** Region labels, border/arrow styling, and the View → Region colors panel. */
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const candidates = readdirSync(cache)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => join(cache, n, "chrome-linux64/chrome"));
    executable = candidates.find((p) => existsSync(p)) || executable;
  }
}
const browser = await chromium.launch({ executablePath: executable, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([
  { name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" },
]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("PAGE ERROR", e.message);
});
const api = `${base}/api/episodes/fixture-episode`;
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const step = async (name) =>
  page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name, exact: true })
    .click();
const openColors = async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Region types & colours", exact: true }).click();
};

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await step("Translate");
  await page.locator(".pages > button").first().click();

  // The canvas receives resolvable color/label callbacks; this used to throw
  // "labelFor is not a function" and blank the studio.
  expect(errors).toEqual([]);

  // Labels render for the selected region only, clipped inside it.
  const labelClipId = async () => {
    const attr = await page.locator("g.region-label").locator("..").getAttribute("clip-path");
    return attr?.replace(/^url\(#region-label-clip-/, "").replace(/\)$/, "");
  };
  const regionButton = page.getByRole("button", { name: /^Region 1, Dialogue/ });
  await regionButton.click();
  await expect(page.locator("g.region-label")).toHaveCount(1);
  const label = page.locator("g.region-label");
  await expect(label.locator("text")).toHaveText(/^1 · Dialogue$/);
  const selectedId = (await state()).lines.find((l) => l.imageId === "fixture-page-0").id;
  expect(await labelClipId()).toBe(selectedId);
  const inside = await page.evaluate((id) => {
    const clip = document.querySelector(`#region-label-clip-${id} rect`);
    const box = document.querySelector(`rect[aria-label^="Region 1,"]`);
    return {
      clip: clip && [clip.getAttribute("x"), clip.getAttribute("y")],
      box: box && [box.getAttribute("x"), box.getAttribute("y")],
      labelInside: !!document.querySelector(`g[clip-path="url(#region-label-clip-${id})"] g.region-label`),
    };
  }, selectedId);
  expect(inside.labelInside).toBe(true);
  expect(inside.clip).toEqual(inside.box);

  // Moving the selection moves the one label; it never accumulates.
  await page.getByRole("button", { name: /^Region 2, Dialogue/ }).click();
  await expect(page.locator("g.region-label")).toHaveCount(1);
  await expect(label.locator("text")).toHaveText(/^2 · Dialogue$/);
  expect(await labelClipId()).not.toBe(selectedId);
  await regionButton.click();
  await expect(label.locator("text")).toHaveText(/^1 · Dialogue$/);

  // Region borders sit at 80% opacity.
  const strokeOpacity = await page
    .locator(`rect[aria-label^="Region 1,"]`)
    .getAttribute("stroke-opacity");
  expect(strokeOpacity).toBe("0.8");

  // Reading-flow arrows are black at 25% opacity, and only in Review.
  await expect(page.locator("path.flow-arrow")).toHaveCount(0);
  await step("Review");
  await page.locator(".pages > button").first().click();
  const arrows = await page.evaluate(() => ({
    count: document.querySelectorAll("path.flow-arrow").length,
    stroke: document.querySelector("path.flow-arrow")?.getAttribute("stroke"),
    opacity: document.querySelector("path.flow-arrow")?.getAttribute("stroke-opacity"),
    markerFill: document.querySelector("#region-flow-arrow path")?.getAttribute("fill"),
    markerOpacity: document.querySelector("#region-flow-arrow path")?.getAttribute("fill-opacity"),
  }));
  expect(arrows.count).toBeGreaterThan(0);
  expect(arrows.stroke).toBe("#000");
  expect(arrows.opacity).toBe("0.25");
  expect(arrows.markerFill).toBe("#000");
  expect(arrows.markerOpacity).toBe("0.25");

  // View → Region colors opens the per-user panel.
  await openColors();
  const dialog = page.getByRole("dialog", { name: "Region colors" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Dialogue color")).toBeVisible();
  await expect(dialog.getByLabel("SFX color")).toBeVisible();
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({ path: "/tmp/scan-acceptance/region-colors-dialog.png" });

  // Buttons use the shared HUD classes and stay inside the dialog on a phone.
  const buttonClasses = await dialog.locator("button").evaluateAll((nodes) =>
    nodes.map((node) => node.className),
  );
  expect(buttonClasses.length).toBeGreaterThan(0);
  expect(buttonClasses.every((name) => /btn-hud(?:-ghost)?/.test(name))).toBe(true);
  const dialogBox = await dialog.boundingBox();
  const overflow = await dialog.evaluate((el) =>
    [...el.querySelectorAll("button")].some((button) => {
      const box = button.getBoundingClientRect();
      const modal = el.getBoundingClientRect();
      return box.right > modal.right + 0.5 || box.left < modal.left - 0.5;
    }),
  );
  expect(overflow).toBe(false);
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/scan-acceptance/region-colors-dialog-narrow.png" });
  await page.setViewportSize({ width: 1500, height: 1000 });
  expect(dialogBox?.width).toBeGreaterThan(440);

  // A per-user override is saved on the account and used on the canvas.
  await dialog.getByLabel("Dialogue color").evaluate((el) => {
    el.value = "#123456";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await (await context.request.get(`${base}/api/me/settings`)).json()).regionColors).toEqual({
    '""': "#123456",
  });
  await expect
    .poll(async () =>
      page
        .locator(`rect[aria-label^="Region 1,"]`)
        .getAttribute("stroke"),
    )
    .toBe("#123456");

  // The series owner can add a dynamic region type.
  await openColors();
  await dialog.getByLabel("New region id").fill("sfx-2");
  await dialog.getByLabel("New region name").fill("Impact SFX");
  await dialog.getByRole("button", { name: "Add type", exact: true }).click();
  await dialog.getByRole("button", { name: "Save series types", exact: true }).click();
  await expect(dialog).toBeHidden();
  const savedKinds = (await state()).seriesDefaults.data.regionKinds;
  expect(savedKinds.some((kind) => kind.id === "sfx-2" && kind.label === "Impact SFX")).toBe(true);

  // Adding series types leaves the per-user colors in effect.
  await expect
    .poll(async () => page.locator(`rect[aria-label^="Region 1,"]`).getAttribute("stroke"))
    .toBe("#123456");

  // The new type shows up as a region choice and can be assigned.
  await page.getByRole("button", { name: /^Region 1, / }).click();
  const typeSelect = page.locator(`#region-card-${selectedId}`).getByLabel("Region type");
  await typeSelect.selectOption("sfx-2");
  await expect
    .poll(async () => (await state()).lines.find((l) => l.id === selectedId).lineType)
    .toBe("sfx-2");
  await expect(page.locator("g.region-label text")).toHaveText(/^1 · Impact SFX$/);

  // Removing a type keeps its existing regions labelled, selectable, and colorable.
  await openColors();
  const sfxRow = dialog.locator("li").filter({ hasText: "sfx-2" });
  await sfxRow.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Save series types", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await state()).seriesDefaults.data.regionKinds.some((k) => k.id === "sfx-2")).toBe(false);
  await expect(typeSelect.locator("option", { hasText: "sfx-2" })).toHaveCount(1);
  await expect(page.locator("g.region-label text")).toHaveText(/^1 · sfx-2$/);

  // The removed type is still offered to the color panel so its regions can be recolored.
  await openColors();
  await expect(dialog.getByLabel("sfx-2 color")).toBeVisible();
  await dialog.getByLabel("sfx-2 color").evaluate((el) => {
    el.value = "#0f0f0f";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await (await context.request.get(`${base}/api/me/settings`)).json()).regionColors).toEqual({
    '""': "#123456",
    "sfx-2": "#0f0f0f",
  });
  await expect
    .poll(async () => page.locator(`rect[aria-label^="Region 1,"]`).getAttribute("stroke"))
    .toBe("#0f0f0f");

  // The series editor reports bad input in the panel instead of saving it.
  await openColors();
  await dialog.getByLabel("New region id").fill('""');
  await dialog.getByLabel("New region name").fill("Duplicate");
  await dialog.getByRole("button", { name: "Add type", exact: true }).click();
  await expect(dialog.getByText("unique id", { exact: false })).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();

  // Series types are revision-guarded: a stale writer is rejected.
  const prefs = await state();
  const stale = await context.request.post(`${api}/workflow`, {
    data: {
      action: "preferences",
      scope: "series",
      expectedRevision: prefs.seriesDefaults.revision - 1,
      data: { regionKinds: null },
    },
  });
  expect(stale.status()).toBe(409);

  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Browser acceptance passed: region labels inside the selection only, 80% region borders, black 25% reading-flow arrows, per-user region colors saved from the View menu, dynamic series region types added, assigned, and removed without losing existing labels.",
  );
} finally {
  await page
    .screenshot({ path: "/tmp/scan-acceptance/browser-region-colors.png", fullPage: true })
    .catch(() => {});
  await browser.close();
}
