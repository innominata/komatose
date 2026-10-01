import { checkRegionAi } from "./check-browser-region-ai.mjs";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
function insertSuggestions(lineId, revision, items) {
  const env = JSON.parse(readFileSync("/tmp/scan-browser-env.json", "utf8"));
  const db = new Database(env.db);
  const now = Date.now();
  for (const [body, kind, translation = ""] of items) {
    db.prepare(
      "INSERT OR IGNORE INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      `${lineId}:${kind}:${body}`,
      "fixture-episode",
      lineId,
      revision,
      body,
      "fixture",
      kind,
      now,
      translation,
    );
  }
  db.close();
}
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
try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();
  await expect(page.getByRole("button", { name: "Rebuild and restart", exact: true })).toBeVisible();
  {
    // The reslice preview stitches the selected page with its neighbours. Its resolution is
    // the point: scaling by the long edge (the old rule) collapsed a tall strip to a few
    // dozen pixels across, and the canvas then stretched that over the whole column.
    const state = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
    const source = state.images[1];
    await page.getByRole("complementary", { name: "Pages in chapter order" }).getByRole("button", { name: "Open page 2", exact: true }).click();
    await page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Reslice strips", exact: true }).click();
    const artwork = page.locator(".canvas-page img.artwork");
    await expect.poll(async () => (await artwork.getAttribute("src"))?.slice(0, 22)).toBe("data:image/jpeg;base64");
    const preview = await artwork.evaluate((el) => ({ w: el.naturalWidth, h: el.naturalHeight }));
    if (preview.w !== source.width)
      throw new Error(`reslice preview is ${preview.w}px wide, expected the native ${source.width}px`);
    if (preview.h < source.height * 2)
      throw new Error(`reslice preview only stitched ${preview.h}px of ${source.height * 2}px`);
    await expect(page.locator(".reslice-current-band span")).toHaveText(`This page · 2`);
    // The window opens on the pages' boundary, so the tool scrolls to the selected page.
    const aligned = await page.locator(".canvas-scroll").evaluate((sc) => {
      const band = sc.querySelector(".reslice-current-band");
      const pad = parseFloat(getComputedStyle(sc).paddingTop) || 0;
      return Math.round(pad + band.offsetTop - sc.scrollTop);
    });
    if (aligned < 0 || aligned > 24)
      throw new Error(`the reslice preview opened ${aligned}px away from the selected page`);
    // Leaving the tool must hand the canvas back to the plain page image.
    await page.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: "Select (V)", exact: true }).click();
    await expect.poll(async () => (await artwork.getAttribute("src"))?.slice(0, 22)).not.toBe("data:image/jpeg;base64");
    await expect(page.locator(".reslice-current-band")).toHaveCount(0);
  }
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  const staleLine = (await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json()).lines.find(
    (l) => l.id === "fixture-line-0-1",
  );
  insertSuggestions(staleLine.id, (staleLine.revision ?? 0) - 1, [
    ["Stale after edit", "translation"],
  ]);
  // The studio pulls new suggestions from the chapter refresh that a live event
  // triggers; a raw fixture insert has no event behind it, so reload instead.
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.getByRole("complementary", { name: "Pages in chapter order" }).waitFor();
  await page.locator(".pages > button").first().click();
  await expect(page.getByText("Stale after edit")).toBeVisible({ timeout: 8000 });
  await expect(
    page
      .locator(".suggestion", { hasText: "Stale after edit" })
      .getByText("The region changed since this suggestion"),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept anyway", exact: true })).toHaveCount(0);
  await page
    .locator(".suggestion", { hasText: "Stale after edit" })
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await expect.poll(async () => {
    const state = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
    return state.lines.find((l) => l.id === "fixture-line-0-1").body;
  }).toBe("Stale after edit");
  const palette = page.getByRole("toolbar", { name: "Tools" });
  await expect(palette.getByRole("button", { name: "Draw region (R)", exact: true })).toBeVisible();
  const pageState = async () => (await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json());
  const beforeCount = (await pageState()).lines.filter(l => l.imageId === "fixture-page-0").length;
  let drawnTranscribe;
  await page.route("**/api/episodes/fixture-episode/ai-transcribe", async route => {
    if (route.request().method() !== "POST") return route.continue();
    drawnTranscribe = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await palette.getByRole("button", { name: "Draw region (R)", exact: true }).click();
  const canvas = page.getByRole("application", { name: "Page regions and cleaning mask" });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("page canvas is not visible");
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.58);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.82, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => drawnTranscribe?.lineId).toBeTruthy();
  await page.unroute("**/api/episodes/fixture-episode/ai-transcribe");
  await expect.poll(async () => (await pageState()).lines.filter(l => l.imageId === "fixture-page-0").length).toBe(beforeCount + 1);
  await expect(page.getByRole("button", { name: new RegExp(`^Region ${beforeCount + 1}(,.*)?$`) })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`#region-card-${drawnTranscribe.lineId}`)).toHaveClass(/selected/);
  await page.getByRole("group", { name: "Run on" }).getByRole("button", { name: "Whole chapter", exact: true }).click();
  await expect(page.getByRole("button", { name: "Transcribe chapter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Translate chapter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fill missing source & English", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Text detection", exact: true }).click();
  const detectorSelect = page.getByRole("combobox", { name: "Text detector", exact: true });
  await expect(detectorSelect).toBeVisible();
  await expect(detectorSelect.locator("option").first()).toHaveText(/^Default · /);
  await expect(detectorSelect.locator('option[value="ctd+koharu"]')).toHaveCount(1);
  await expect(page.getByRole("spinbutton", { name: "Detection confidence", exact: true })).toBeVisible();
  await expect(page.getByText("Transcribe runs the selected vision models", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Proofread edited English", exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Retry uncertain image reading", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "More", exact: true }).click();
  let autoRequests = 0;
  let transcribeBody;
  await page.route("**/api/episodes/fixture-episode/ai-transcribe", async route => {
    if (route.request().method() !== "POST") return route.continue();
    autoRequests++;
    transcribeBody = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.getByRole("button", { name: "Transcribe chapter", exact: true }).click();
  await expect.poll(() => autoRequests).toBe(1);
  // The server resolves the chapter's setup, so the client must not pin one.
  expect(transcribeBody.detector).toBeUndefined();
  expect(transcribeBody.detectorSetup).toBeUndefined();
  expect(transcribeBody.detectConf).toBeUndefined();
  await page.unroute("**/api/episodes/fixture-episode/ai-transcribe");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(page.locator(".pages > button").first()).toHaveAttribute("aria-label", "Open page 1");
  await page
    .getByRole("button", { name: "Renumber pages", exact: true })
    .click();
  await page.getByText("Numbering is current.", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "Credits", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Series credits" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add credits to this chapter" })).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await page.locator(".pages > button").first().click();
  // The desktop palette owns page commands and can float, then pin as a panel.
  await expect(palette.getByRole("button", { name: "Draw region (R)", exact: true })).toBeVisible();
  await expect(palette.getByRole("button", { name: "Reorder reading flow (O)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Transcribe page", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Translate page", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fill missing source & English", exact: true })).toBeVisible();
  await expect(page.locator(".bilingual").getByRole("button", { name: "Translate page", exact: true })).toHaveCount(0);
  let pageTranslation;
  await page.route("**/api/episodes/fixture-episode/ai-translate", async route => {
    if (route.request().method() !== "POST") return route.continue();
    pageTranslation = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.getByRole("button", { name: "Translate page", exact: true }).click();
  await expect.poll(() => pageTranslation?.imageIds).toEqual(["fixture-page-0"]);
  await page.unroute("**/api/episodes/fixture-episode/ai-translate");
  const pinned = await palette.boundingBox();
  const imagePanel = await page.locator(".canvas-stage").boundingBox();
  if (!pinned || !imagePanel) throw new Error("tools and the page must be measurable");
  if (pinned.x + pinned.width > imagePanel.x + 1)
    throw new Error("tools must sit beside the page, not over it");
  await page.locator(".studio-top").getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Properties panel", exact: true }).click();
  await expect(page.locator(".bilingual")).toHaveCount(0);
  await page.locator(".studio-top").getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Properties panel", exact: true }).click();
  await expect(page.locator(".bilingual")).toBeVisible();
  const firstRegion = page.locator("article").filter({ hasText: "Needs work" }).first();
  await expect(firstRegion.getByRole("button", { name: "Needs work", exact: true })).toBeVisible();
  await expect(firstRegion.getByRole("button", { name: "Suggest alternative", exact: true })).toBeVisible();
  await expect(page.locator(".ed-options")).toHaveCount(0);
  await expect(page.getByLabel("Region type", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Page view" }).getByRole("button", { name: "Compare source", exact: true })).toBeVisible();
  await checkRegionAi({ page, context, base, insertSuggestions });
  let suggestBody;
  await page.route("**/api/episodes/fixture-episode/ai-translate", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    if (body?.action !== "suggest-alternatives") return route.continue();
    suggestBody = body;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ jobId: "suggest-fixture" }),
    });
  });
  await firstRegion.getByRole("button", { name: "Suggest alternative", exact: true }).click();
  await expect.poll(() => suggestBody?.action).toBe("suggest-alternatives");
  if (typeof suggestBody?.lineId !== "string" || !suggestBody.lineId)
    throw new Error("Suggest alternative did not send a region id");
  await page.unroute("**/api/episodes/fixture-episode/ai-translate");
  const firstCard = page.locator("#region-card-fixture-line-0-0");
  await firstCard.getByRole("button", { name: /^#\d/ }).click();
  await firstCard.getByLabel("English", { exact: true }).fill("Wait here, please.");
  const secondCard = page.locator("#region-card-fixture-line-0-1");
  await secondCard.getByRole("button", { name: /^#\d/ }).click();
  await secondCard.getByLabel("English", { exact: true }).fill("Are you really leaving?");
  await expect
    .poll(
      async () => {
        const data = await (
          await context.request.get(
            `${base}/api/episodes/fixture-episode/workflow`,
          )
        ).json();
        return data.lines
          .filter((l) =>
            ["fixture-line-0-0", "fixture-line-0-1"].includes(l.id),
          )
          .map((l) => l.body);
      },
      { timeout: 15000 },
    )
    .toEqual(["Wait here, please.", "Are you really leaving?"]);
  await page.getByText("All text saved", { exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await page.locator(".pages > button").first().click();
  const persistedFirst = page.locator("#region-card-fixture-line-0-0");
  await persistedFirst.getByRole("button", { name: /^#\d/ }).click();
  if ((await persistedFirst.getByLabel("English", { exact: true }).inputValue()) !== "Wait here, please.")
    throw new Error("First region did not persist");
  const persistedSecond = page.locator("#region-card-fixture-line-0-1");
  await persistedSecond.getByRole("button", { name: /^#\d/ }).click();
  if ((await persistedSecond.getByLabel("English", { exact: true }).inputValue()) !== "Are you really leaving?")
    throw new Error("Second region did not persist");
  await persistedFirst.getByRole("button", { name: /^#\d/ }).click();
  // A failed request retains a draft across navigation and an explicit retry.
  const lineUrl = `${base}/api/episodes/fixture-episode/lines/fixture-line-0-0`;
  await page.route(lineUrl, (route) => route.abort("failed"));
  await page
    .getByLabel("English", { exact: true })
    .first()
    .fill("Recovered after a failed save.");
  await page.getByRole("button", { name: "Retry save", exact: true }).waitFor();
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true })
    .click();
  await page.locator(".pages > button").first().click();
  await page.locator("#region-card-fixture-line-0-0").getByRole("button", { name: /^#\d/ }).click();
  await expect(page.getByLabel("English", { exact: true }).first()).toHaveValue(
    "Recovered after a failed save.",
  );
  await page.unroute(lineUrl);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await page.getByText("All text saved", { exact: true }).waitFor();
  // Simulate a collaborator committing while this browser's request is in flight.
  await page.route(
    lineUrl,
    async (route) => {
      const local = route.request().postDataJSON();
      const other = await context.request.patch(lineUrl, {
        data: {
          body: "Collaborator version",
          expectedRevision: local.expectedRevision,
        },
      });
      if (!other.ok()) throw new Error(await other.text());
      await route.continue();
    },
    { times: 1 },
  );
  await page
    .getByLabel("English", { exact: true })
    .first()
    .fill("My concurrent draft");
  await expect(page.getByRole("button", {
    name: "Save my draft over this reviewed version",
    exact: true,
  })).toBeVisible({ timeout: 8000 });
  const conflictState = await (
    await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)
  ).json();
  if (
    conflictState.lines.find((l) => l.id === "fixture-line-0-0").body !==
    "Collaborator version"
  )
    throw new Error("Conflicting draft overwrote the newer saved line");
  await page.getByRole("button", { name: "Keep the saved version", exact: true }).click();
  await expect(page.getByLabel("English", { exact: true }).first()).toHaveValue(
    "Collaborator version",
  );
  const workflowUrl = `${base}/api/episodes/fixture-episode/workflow`;
  const beforeApprove = await (await context.request.get(workflowUrl)).json();
  const approveLine = beforeApprove.lines.find((l) => l.id === "fixture-line-0-0");
  insertSuggestions(approveLine.id, approveLine.revision, [
    ["Leftover after approve", "translation"],
    ["Proofread after approve", "proofread"],
  ]);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  await page.locator("#region-card-fixture-line-0-0").getByRole("button", { name: /^#\d/ }).click();
  await expect(page.getByText("Leftover after approve")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("Proofread after approve")).toBeVisible();
  await page.getByRole("button", { name: "Approve & next", exact: true }).first().click();
  await expect(page.getByText("Leftover after approve")).toHaveCount(0);
  await expect(page.getByText("Proofread after approve")).toHaveCount(0);
  await expect.poll(async () => {
    const state = await (await context.request.get(workflowUrl)).json();
    return state.lines.find(l => l.id === "fixture-line-0-0").status;
  }).toBe("approved");
  await expect.poll(async () => {
    const state = await (await context.request.get(workflowUrl)).json();
    return state.suggestions.filter((s) => s.line_id === "fixture-line-0-0" && s.state === "pending").length;
  }).toBe(0);
  await expect(page.locator("article.selected")).toHaveAttribute("id", "region-card-fixture-line-0-1");
  const acceptLine = (await (await context.request.get(workflowUrl)).json()).lines.find((l) => l.id === "fixture-line-0-1");
  insertSuggestions(acceptLine.id, acceptLine.revision, [
    ["Chosen alternative", "translation"],
    ["Other alternative", "translation"],
  ]);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  await page.locator("#region-card-fixture-line-0-1").getByRole("button", { name: /^#\d/ }).click();
  await expect(page.getByText("Chosen alternative")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText("Other alternative")).toBeVisible();
  await page
    .locator(".suggestion", { hasText: "Chosen alternative" })
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await expect.poll(async () => {
    const state = await (await context.request.get(workflowUrl)).json();
    return state.suggestions
      .filter((s) => s.line_id === "fixture-line-0-1")
      .map((s) => `${s.body}:${s.state}`)
      .sort();
  }).toEqual(["Chosen alternative:accepted", "Other alternative:rejected", "Stale after edit:accepted"]);
  await expect(page.getByText("Other alternative")).toHaveCount(0);
  const state = async () =>
    await (await context.request.get(workflowUrl)).json();
  const operation = async (data) => {
    const r = await context.request.post(workflowUrl, { data });
    if (!r.ok()) throw new Error(await r.text());
    return r.json();
  };
  const invalid = await context.request.post(
    `${base}/api/episodes/fixture-episode/lines`,
    { data: { imageId: "a-page-from-another-chapter", body: "Bad reference" } },
  );
  if (invalid.status() !== 400)
    throw new Error("Foreign page reference was accepted");
  let pageDoc = (
    await operation({ action: "prepare", imageId: "fixture-page-0" })
  ).doc;
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Clean", exact: true }).click();
  await palette.getByRole("button", { name: "Mask brush (B)", exact: true }).click();
  const brushSizes = page.getByRole("toolbar", { name: "Brush size" });
  await expect(brushSizes.getByRole("button", { name: "Brush 8 pixels", exact: true })).toBeVisible();
  await expect(brushSizes.getByRole("button", { name: "Brush 32 pixels", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sampled flat fill", exact: true })).toBeDisabled();
  let maskCommand;
  await page.route(workflowUrl, async route => {
    if (route.request().method() !== "POST") return route.continue();
    maskCommand = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "palette-mask-fixture" }) });
  });
  await page.locator(".stage-actions").getByRole("button", { name: "Detect lettering", exact: true }).click();
  await expect.poll(() => maskCommand?.action).toBe("mask");
  expect(maskCommand.detect).toBe(true);
  expect(maskCommand.imageId).toBe("fixture-page-0");
  await page.unroute(workflowUrl);
  await expect(page.locator(".bilingual").getByRole("button", { name: "Generate lettering mask", exact: true })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  const mask = await operation({
    action: "mask",
    imageId: "fixture-page-0",
    expectedRevision: pageDoc.revision,
    strokes: [{ points: [{ x: 0.78, y: 0.16 }], radius: 8 }],
  });
  await expect
    .poll(
      async () => (await state()).jobs.find((j) => j.id === mask.jobId)?.state,
      { timeout: 60000 },
    )
    .toBe("completed");
  pageDoc = (await state()).pages["fixture-page-0"];
  const maskHash = pageDoc.data.mask;
  if (!pageDoc.data.maskApproved)
    throw new Error("Committing mask edits did not implicitly approve the saved mask");
  const clean = await operation({
    action: "clean",
    imageId: "fixture-page-0",
    expectedRevision: pageDoc.revision,
    method: "flat",
  });
  await expect
    .poll(
      async () => (await state()).jobs.find((j) => j.id === clean.jobId)?.state,
      { timeout: 60000 },
    )
    .toBe("completed");
  pageDoc = (await state()).pages["fixture-page-0"];
  const cleanHash = pageDoc.data.cleaned;
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo saved edit (Ctrl+Z)", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await state()).pages["fixture-page-0"].data.cleaned).toBeFalsy();
  pageDoc = (await state()).pages["fixture-page-0"];
  if (pageDoc.data.cleaned)
    throw new Error("Cleaning undo did not restore prior artwork");
  pageDoc = (
    await operation({
      action: "page",
      imageId: "fixture-page-0",
      expectedRevision: pageDoc.revision,
      data: {},
      history: "redo",
    })
  ).doc;
  if (pageDoc.data.cleaned !== cleanHash || pageDoc.data.mask !== maskHash)
    throw new Error("Redo lost cleaning or removal mask");
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({
    path: "/tmp/scan-acceptance/bilingual.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Typeset", exact: true })
    .click();
  await expect(page.getByRole("toolbar", { name: "Page view" }).getByRole("button", { name: "Compare source", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Auto-fit all text", exact: true })).toBeVisible();
  await page.locator(".stage-actions").getByRole("button", { name: /^More/ }).click();
  await expect(page.getByRole("menuitem", { name: "Reset page to series defaults", exact: true })).toBeVisible();
  await page.locator(".stage-actions").getByRole("button", { name: /^More/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Typography", exact: true }).click();
  const typesetTypeDialog = page.getByRole("dialog", { name: "Series Type Settings" });
  await expect(typesetTypeDialog).toBeVisible();
  await typesetTypeDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(typesetTypeDialog).toBeHidden();
  await expect(page.locator(".bilingual").getByRole("button", { name: "Translate page", exact: true })).toHaveCount(0);
  await expect(page.locator(".bilingual").getByRole("button", { name: "Review translations", exact: true })).toHaveCount(0);
  await expect(page.locator(".bilingual").getByText("Optional page tools", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Suggest alternative", exact: true })).toHaveCount(0);
  const fontsPage = await context.newPage();
  await fontsPage.goto(`${base}/series/fixture-series#type`);
  await fontsPage.getByLabel("Upload TTF or OTF", { exact: true }).setInputFiles("/usr/share/fonts/gnu-free/FreeSans.ttf");
  await fontsPage.getByRole("button", { name: "Add font", exact: true }).click();
  await fontsPage.locator("p").filter({ hasText: "FreeSans · Regular" }).first().waitFor();
  await fontsPage.getByRole("button", { name: "Type Settings…", exact: true }).click();
  const seriesTypeDialog = fontsPage.getByRole("dialog", { name: "Series Type Settings" });
  await expect(seriesTypeDialog).toBeVisible();
  await seriesTypeDialog.getByRole("button", { name: /SFX/ }).click();
  await seriesTypeDialog.getByLabel("Size (pt)").fill("8");
  await seriesTypeDialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect(seriesTypeDialog).toBeHidden();
  await expect
    .poll(async () => {
      const data = await (await context.request.get(`${base}/api/series/fixture-series`)).json();
      return data.typeStyles?.["::"]?.size;
    })
    .toBe(8);
  await fontsPage.close();
  // The studio loads its font list once; reload so the upload above shows up.
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".pages > button").first().waitFor();
  await page.locator(".pages > button").first().click();
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Typeset", exact: true }).click();
  const regionOne = page.getByRole("button", { name: /^Region 1(,.*)?$/ });
  await expect(regionOne).toBeVisible();
  await regionOne.click();
  await expect(page.getByLabel("Region type", { exact: true }).first()).toBeVisible();
  await regionOne.dispatchEvent("contextmenu");
  const regionTypeItem = page.getByRole("menuitem", { name: "Region type", exact: true });
  await regionTypeItem.hover();
  await regionTypeItem.click();
  const regionTypeMenu = page.getByRole("menu", { name: "Region type" });
  await expect(regionTypeMenu.getByRole("menuitem", { name: "SFX", exact: true })).toBeVisible();
  await expect(regionTypeMenu.getByRole("menuitem", { name: "Note", exact: true })).toBeVisible();
  await regionTypeMenu.getByRole("menuitem", { name: "Dialogue", exact: true }).click();
  await page.screenshot({
    path: "/tmp/scan-acceptance/type-before-fit.png",
    fullPage: true,
  });

  await page.getByRole("tab", { name: "Style", exact: true }).click();
  await page.getByLabel("Font face", { exact: true }).selectOption({ label: "FreeSans · Regular" });
  await expect(page.getByRole("button", { name: "Auto-fit", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Reset to series style", exact: true }).click();
  await expect(page.getByLabel("Font face", { exact: true })).toHaveValue("");
  await page.getByLabel("Font face", { exact: true }).selectOption({ label: "FreeSans · Regular" });
  await expect(page.getByRole("button", { name: "Auto-fit", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Auto-fit", exact: true }).click();
  await page.getByRole("tab", { name: "Text", exact: true }).click();
  await page.getByText("pt · 72 DPI · Fitted", { exact: false }).waitFor();
  await page.screenshot({
    path: "/tmp/scan-acceptance/typeset.png",
    fullPage: true,
  });
  // The visible toolbar action fits the whole page, including unselected regions.
  const beforeBulk = await state();
  const pageTargets = beforeBulk.lines.filter(l => l.imageId === "fixture-page-0" && l.placed && l.sourceState !== "ignored" && l.body.trim());
  const fontId = beforeBulk.fonts.find(f => f.familyName === "FreeSans").id;
  await operation({ action: "preferences", expectedRevision: beforeBulk.chapter.revision,
    data: { styles: Object.fromEntries(pageTargets.map(l => [l.lineType, { fontId }])) } });
  const lockedRegion = beforeBulk.regions[pageTargets[0].id];
  await operation({ action: "region", id: pageTargets[0].id, expectedRevision: lockedRegion.revision, data: { locked: true } });
  const lockedBefore = (await state()).regions[pageTargets[0].id];
  const bulkResponse = page.waitForResponse(response => {
    if (!response.url().endsWith("/workflow") || response.request().method() !== "POST") return false;
    const data = response.request().postDataJSON();
    return data.action === "typeset-all" && data.scope === "page" && data.imageId === "fixture-page-0";
  });
  await page.locator(".stage-actions").getByRole("button", { name: "Auto-fit all text", exact: true }).click();
  const bulk = await (await bulkResponse).json();
  await expect.poll(async () => (await state()).jobs.find(j => j.id === bulk.jobId)?.state, { timeout: 60000 }).toBe("completed");
  const afterBulk = await state();
  const bulkJob = afterBulk.jobs.find(j => j.id === bulk.jobId);
  expect(bulkJob.progress.errors).toEqual([]);
  expect(bulkJob.progress.completed).toBe(pageTargets.length - 1);
  expect(bulkJob.progress.skipped).toBe(1);
  expect(afterBulk.regions[pageTargets[0].id]).toEqual(lockedBefore);
  for (const target of pageTargets.slice(1)) expect(afterBulk.regions[target.id].data.layout).toBeTruthy();
  for (const other of beforeBulk.lines.filter(l => l.imageId !== "fixture-page-0"))
    expect(afterBulk.regions[other.id]).toEqual(beforeBulk.regions[other.id]);
  const jobsToggle = page.locator(".jobs-toggle");
  if ((await jobsToggle.getAttribute("aria-expanded")) === "false") await jobsToggle.click();
  await expect(jobsToggle).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  // Resolve the readiness blockers the way the panel offers them: drop the empty
  // drawn region, prepare the stale page, approve cleaning/geometry/translations,
  // fit the untouched page, then stamp every step complete.
  await operation({ action: "remove-blank-regions" });
  await operation({ action: "prepare", imageId: "fixture-page-1" });
  for (const imageId of ["fixture-page-0", "fixture-page-1"]) {
    const doc = (await state()).pages[imageId];
    await operation({
      action: "page",
      imageId,
      expectedRevision: doc.revision,
      data: { cleanApproved: true },
    });
  }
  await operation({ action: "approve-all-translations" });
  const fitJob = await operation({ action: "typeset-all", scope: "chapter" });
  await expect
    .poll(
      async () => (await state()).jobs.find((j) => j.id === fitJob.jobId)?.state,
      { timeout: 60000 },
    )
    .toBe("completed");
  expect((await state()).jobs.find((j) => j.id === fitJob.jobId).progress.errors).toEqual([]);
  // Fitting derives geometry for polygon-less regions and marks it for review,
  // so approve the geometry only after the typeset pass has run.
  await operation({ action: "approve-all-geometry" });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".pages > button").first().waitFor();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Export", exact: true })
    .click();
  const markAll = page.getByRole("button", { name: "Mark every page complete", exact: true });
  await expect(markAll).toBeEnabled({ timeout: 15000 });
  page.once("dialog", (dialog) => dialog.accept());
  await markAll.click();
  await expect
    .poll(
      async () => (await state()).issues.filter((i) => i.code === "step-complete").length,
      { timeout: 15000 },
    )
    .toBe(0);
  await page.getByLabel("Label as draft").check();
  await expect(page.getByRole("button", { name: "Generate ZIP", exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Generate ZIP", exact: true }).click();
  const downloads = page.locator(".jobs-toggle");
  if (await downloads.getAttribute("aria-expanded") === "false") await downloads.click();
  await page
    .getByRole("link", {
      name: "Download DRAFT-chapter-1-png.zip",
      exact: true,
    })
    .first()
    .waitFor({ timeout: 30000 });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    "Browser acceptance passed: separate AI model settings, independent source review with partial failures, enquiry context defaults, source/English action cards and conflicts, chat continuity, floating palette persistence, relocated page/cleaning commands, View panels, automatic translation entry point, optional tools, approve-and-next order, independent saves, durable failed-save retry, concurrent conflict, page ownership, mask/clean jobs, undo/redo, numbering, fonts, fitting, draft PNG export.",
  );
} finally {
  await page
    .screenshot({
      path: "/tmp/scan-acceptance/browser-last.png",
      fullPage: true,
    })
    .catch(() => {});
  await browser.close();
}
