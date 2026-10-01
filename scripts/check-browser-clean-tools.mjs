import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const candidates = readdirSync(cache)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => join(cache, n, "chrome-linux64/chrome"));
    executable = candidates.find((p) => existsSync(p)) || executable;
  }
}

const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
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
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("PAGE ERROR", e.message);
});

const workflowUrl = `${base}/api/episodes/fixture-episode/workflow`;
const operation = async (data) => {
  const r = await context.request.post(workflowUrl, { data });
  if (!r.ok()) throw new Error(await r.text());
  return r.json();
};
const state = async () => (await context.request.get(workflowUrl)).json();

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await page.locator(".pages > button").first().click();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Clean", exact: true })
    .click();
  const palette = page.getByRole("toolbar", { name: "Tools" });
  // The region rect sits under the canvas svg (pointer-events none unless the
  // select tool is up), so a real mouse click would hit the svg instead —
  // dispatch the click straight on the rect to select the region.
  await page.getByRole("button", { name: /^Region 1(,.*)?$/ }).dispatchEvent("click");
  await expect(page.getByRole("button", { name: /Fit bubble/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Set polygon to region bounds", exact: true })).toHaveCount(0);
  await expect(palette.getByRole("button", { name: "Draw polygon", exact: true })).toHaveCount(0);
  await expect(palette.getByRole("button", { name: "Fill speech bubble (F)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Clone stamp (C)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Blur (L)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Restore (H)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Paint raw (S)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Grow mask (G)", exact: true })).toBeVisible();
  // The brush presets live in their own floating toolbar, which opens once a
  // brush-size tool (Blur here) is picked.
  const brushSize = page.getByRole("toolbar", { name: "Brush size" });
  await palette.getByRole("button", { name: "Blur (L)", exact: true }).click();
  await expect(brushSize).toBeVisible();
  await expect(brushSize.getByRole("button", { name: "Brush 8 pixels", exact: true })).toBeVisible();
  await expect(brushSize.getByRole("button", { name: "Brush 32 pixels", exact: true })).toBeVisible();
  await brushSize.getByRole("button", { name: "Brush 16 pixels", exact: true }).click();
  await expect(brushSize.getByRole("button", { name: "Brush 16 pixels", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(palette.getByRole("button", { name: "Blur (L)", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await palette.getByRole("button", { name: "Restore (H)", exact: true }).click();
  await expect(palette.getByRole("button", { name: "Restore (H)", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await palette.getByRole("button", { name: "Paint raw (S)", exact: true }).click();
  await expect(palette.getByRole("button", { name: "Paint raw (S)", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Sampled flat fill", exact: true })).toBeDisabled();

  let pageDoc = (await operation({ action: "prepare", imageId: "fixture-page-0" })).doc;
  const mask = await operation({
    action: "mask",
    imageId: "fixture-page-0",
    expectedRevision: pageDoc.revision,
    strokes: [{ points: [{ x: 0.78, y: 0.16 }], radius: 8 }],
  });
  await expect
    .poll(async () => (await state()).jobs.find((j) => j.id === mask.jobId)?.state, {
      timeout: 60000,
    })
    .toBe("completed");
  pageDoc = (await state()).pages["fixture-page-0"];
  pageDoc = (
    await operation({
      action: "page",
      imageId: "fixture-page-0",
      expectedRevision: pageDoc.revision,
      data: { maskApproved: false },
    })
  ).doc;
  if (pageDoc.data.maskApproved) throw new Error("Could not clear mask approval for the UI check");
  const posts = [];
  const interceptWorkflow = async (route) => {
    const req = route.request();
    try {
      if (req.method() === "GET" && new URL(req.url()).searchParams.has("backend")) {
        return route.fulfill({
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            bigLama: false,
            sam: false,
            codex: { available: true, reason: "fixture" },
            devices: [],
            errors: [],
          }),
        });
      }
      if (req.method() === "POST") {
        const data = req.postDataJSON() || {};
        posts.push(data);
        if (data.method === "codex") {
          return route.fulfill({
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId: "fixture-codex-clean" }),
          });
        }
      }
      await route.continue();
    } catch {
      await route.continue().catch(() => {});
    }
  };
  await context.route("**/api/episodes/fixture-episode/workflow**", interceptWorkflow);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".pages > button").first().click();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Clean", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Sampled flat fill", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Codex · reconstruct artwork", exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Codex · reconstruct artwork", exact: true }).click();
  const promptDialog = page.getByRole("dialog", { name: "Codex reconstruction", exact: true });
  await expect(promptDialog).toBeVisible();
  await promptDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(promptDialog).toBeHidden();
  await expect.poll(() => posts.some((item) => item.action === "clean" && item.method === "codex")).toBe(false);
  await page.getByRole("button", { name: "Codex · reconstruct artwork", exact: true }).click();
  await expect(promptDialog).toBeVisible();
  await promptDialog.getByLabel("Extra notes").fill("redraw the missing finger properly");
  await promptDialog.getByRole("button", { name: "Reconstruct", exact: true }).click();
  await expect(promptDialog).toBeHidden();
  await expect.poll(() =>
    posts.some(
      (item) =>
        item.action === "clean" &&
        item.method === "codex" &&
        String(item.prompt || "").includes("redraw the missing finger properly"),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Sampled flat fill", exact: true }).click();
  await expect
    .poll(() => posts.some((item) => item.action === "page" && item.data?.maskApproved === true))
    .toBe(true);
  await expect.poll(() => posts.some((item) => item.action === "clean" && item.method === "flat")).toBe(
    true,
  );
  await expect(page.getByRole("button", { name: "Undo saved edit (Ctrl+Z)", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  await page.getByRole("button", { name: "Undo saved edit (Ctrl+Z)", exact: true }).click();
  await expect.poll(() => posts.some((item) => item.action === "page" && item.history === "undo"), {
    timeout: 15000,
  }).toBe(
    true,
  );

  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await page.locator("#region-card-fixture-line-0-0").getByRole("button", { name: "AI Review", exact: true }).click();
  const review = page.getByRole("dialog", { name: "AI source review", exact: true });
  await expect(review.getByRole("button", { name: "View crop at 1×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "View crop at 2×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "View crop at 4×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Brush 8 pixels", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "View crop at 2×", exact: true }).click();
  await expect(review.getByRole("button", { name: "View crop at 2×", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await review.getByRole("button", { name: "Close AI dialog" }).click();

  if (errors.length) throw new Error(errors.join("\n"));
  console.log("clean tools and review zoom checks passed");
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  await browser.close();
}
