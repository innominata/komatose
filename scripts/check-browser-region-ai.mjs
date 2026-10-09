import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";

export async function checkRegionAi({
  page,
  context,
  base,
  insertSuggestions,
}) {
  const api = `${base}/api/episodes/fixture-episode`;
  const before = await (await context.request.get(`${api}/workflow`)).json();
  const original = before.lines.find((l) => l.id === "fixture-line-0-0");
  const card = page.locator("#region-card-fixture-line-0-0");
  const goTranslate = async () => {
    await page.waitForFunction(() => document.body.dataset.studioReady === "1");
    await page
      .getByRole("navigation", { name: "Chapter workflow" })
      .getByRole("button", { name: "Translate", exact: true })
      .click();
    await page.locator(".pages > button").first().click();
  };
  const CHAT = ["translate", "vision", "describe", "proofreadEnglish", "chapterReview", "advisory", "compactNotes", "alternatives", "pageImageProofread"];
  const row = (id, label, group, operations, extra = {}) => ({
    id, label, available: extra.available !== false, group, operations, pageImageOnly: extra.pageImageOnly, access: extra.access,
  });
  const fixtureEngines = [
    row("qwen3.8-27b-q4", "Qwen 3.8 27B", "Local models", CHAT, { access: "local_http" }),
    row("qwen3-vl-8b", "Qwen3-VL", "Local models", ["describe", "vision", "advisory"], { access: "local_http" }),
    row("hayai-ocr-v2", "Hayai OCR v2", "Local models", ["vision", "sourceReview"], { access: "local_http" }),
    row("paddleocr-vl-1.6", "PaddleOCR-VL-1.6", "Local models", ["vision", "sourceReview"], { access: "local_http" }),
    row("grok-4.6", "Grok 4.6", "CLI agents", CHAT, { access: "cli" }),
    row("composer-2.5", "Composer 2.5", "CLI agents", CHAT, { access: "cli" }),
  ];
  await page.route("**/api/ai/engines", (route) =>
    route.fulfill({
      json: {
        engines: fixtureEngines,
        rows: fixtureEngines,
        sourceReviewEngines: fixtureEngines,
        transcriptionModels: fixtureEngines.filter((item) => item.operations.includes("vision")),
      },
    }),
  );
  await page.locator(".pages > button").first().click();
  await page
    .getByRole("button", { name: "AI model settings…", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "AI model settings",
    exact: true,
  });
  await settings.getByRole("tab", { name: "Read Text / OCR", exact: true }).click();
  await settings.getByRole("combobox", { name: "Read Text / OCR", exact: true }).selectOption("qwen3-vl-8b");
  await settings.getByRole("tab", { name: "Review Transcription", exact: true }).click();
  await settings.getByRole("button", { name: "Add reviewer", exact: true }).click();
  await settings.getByLabel("Reviewer 1", { exact: true }).selectOption("paddleocr-vl-1.6");
  await settings.getByRole("button", { name: "Add reviewer", exact: true }).click();
  await settings.getByLabel("Reviewer 2", { exact: true }).selectOption("hayai-ocr-v2");
  await settings.locator("button.save").first().click();
  await expect(settings).toBeHidden();
  const saved = await (await context.request.get(`${api}/workflow`)).json();
  expect(saved.preferences.regionAi.vision).toEqual({ engine: "qwen3-vl-8b", model: "" });
  expect(saved.preferences.regionAi.reviewers).toEqual([
    { engine: "paddleocr-vl-1.6", model: "" },
    { engine: "hayai-ocr-v2", model: "" },
  ]);
  const grokSave = await context.request.post(`${api}/workflow`, {
    data: {
      action: "preferences",
      scope: "series",
      expectedRevision: saved.seriesDefaults.revision,
      data: {
        regionAi: {
          ...saved.preferences.regionAi,
          reviewers: [
            ...saved.preferences.regionAi.reviewers,
            { engine: "grok", model: "reviewer-grok-fixture" },
          ],
        },
      },
    },
  });
  expect(grokSave.ok()).toBe(true);
  await page.reload({ waitUntil: "networkidle" });
  await goTranslate();
  const glossarySave = await context.request.patch(`${base}/api/series/fixture-series`, {
    data: {
      glossary: [
        { source: "待って", translation: "Wait" },
        { source: "ここで", translation: "Right here" },
        { source: "誰も", translation: "Nobody" },
        { source: "太郎", translation: "Taro" },
      ],
    },
  });
  expect(glossarySave.ok()).toBe(true);
  await card.getByRole("button", { name: /^#\d/ }).click();
  const chips = card.getByRole("list", { name: "Glossary terms in source" });
  await expect(chips.locator("li").filter({ hasText: "待って" })).toBeVisible();
  await expect(chips.locator("li").filter({ hasText: "ここで" })).toBeVisible();
  await expect(chips.locator("li")).toHaveCount(2);
  await expect(chips.locator("li").filter({ hasText: "待って" })).toHaveClass(/present/);
  await expect(chips.locator("li").filter({ hasText: "ここで" })).toHaveClass(/missing/);
  await expect(chips.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Enter characters", exact: true })).toBeVisible();
  const requests = [];
  await page.route(
    "**/api/episodes/fixture-episode/region-ai",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const b = route.request().postDataJSON();
      requests.push(b);
      if (b.action === "detect-mask") {
        await route.fulfill({
          json: {
            mask:
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          },
        });
        return;
      }
      if (b.action === "review") {
        const model = b.reviewers[0];
        const id = model.model || model.engine;
        if (id === "reviewer-grok-fixture") {
          await route.fulfill({
            json: {
              results: [
                {
                  model,
                  answer: "Grok reading of the crop.",
                  cards: [],
                },
              ],
            },
          });
          return;
        }
        if (id === "hayai-ocr-v2") {
          await new Promise((r) => setTimeout(r, 400));
          await route.fulfill({
            json: {
              results: [
                {
                  model,
                  error: "Fixture reviewer unavailable",
                  cards: [],
                },
              ],
            },
          });
          return;
        }
        insertSuggestions(b.lineId, b.expectedRevision, [
          ["待って——！", "source-review", "Hold on!"],
        ]);
        await route.fulfill({
          json: {
            results: [
              {
                model,
                answer: "The long dash is visible.",
                cards: [
                  {
                    id: `${b.lineId}:source-review:待って——！`,
                    target: "source",
                    body: "待って——！",
                    translation: "Hold on!",
                    reason: "Reviewer one: visible glyphs",
                  },
                ],
              },
            ],
          },
        });
        return;
      }
      if (b.action === "revise") {
        const body = b.selected ? "Hold it right there!" : "Hold still!";
        insertSuggestions(b.lineId, b.expectedRevision, [[body, "revise"]]);
        await route.fulfill({
          json: {
            label: b.model?.engine || "fixture",
            cards: [
              {
                id: `${b.lineId}:revise:${body}`,
                target: "body",
                body,
                reason: "Fixture revision",
              },
            ],
          },
        });
        return;
      }
      const cards =
        b.history.length === 1
          ? [
              { target: "source", body: "待って！", kind: "source-enquiry" },
              { target: "body", body: "Please wait.", kind: "enquiry" },
            ]
          : [];
      insertSuggestions(
        b.lineId,
        b.expectedRevision,
        cards.map((c) => [c.body, c.kind]),
      );
      await route.fulfill({
        json: {
          answer:
            "This is a direct request to wait; please softens the tone.",
          cards: cards.map((c) => ({
            id: `${b.lineId}:${c.kind}:${c.body}`,
            target: c.target,
            body: c.body,
            reason: "Tone and context",
          })),
        },
      });
    },
  );
  await card.getByRole("button", { name: "Review Transcription", exact: true }).click();
  const review = page.getByRole("dialog", {
    name: "AI source review",
    exact: true,
  });
  await expect(review.getByLabel("Mask crop with detected text", { exact: true })).toBeChecked();
  await expect
    .poll(() => requests.some((item) => item.action === "detect-mask"))
    .toBe(true);
  await review.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const modelSettings = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await expect(modelSettings).toBeVisible();
  await modelSettings.getByRole("tab", { name: "Review Transcription", exact: true }).click();
  await expect(modelSettings.getByRole("heading", { name: "Review Transcription" })).toBeVisible();
  await modelSettings.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(modelSettings).toBeHidden();
  await expect(review).toBeVisible();
  await expect(
    review.getByText("Not run automatically. Use Run to request reviewer-grok-fixture.", { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("button", { name: "Run reviewer-grok-fixture", exact: true }),
  ).toBeEnabled();
  await expect(review.getByRole("button", { name: "Detect text", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Brush", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Erase", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "View crop at 1×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "View crop at 2×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "View crop at 4×", exact: true })).toBeVisible();
  await expect(review.getByRole("button", { name: "Brush 8 pixels", exact: true })).toBeVisible();
  await expect(
    review.getByText("The long dash is visible.", { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByText("Review failed: Fixture reviewer unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(review.getByText("Waiting for response…")).toHaveCount(0);
  await expect(review.getByRole("button", { name: "Resubmit", exact: true })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Enter characters", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Enter characters", exact: true }).click();
  await expect(review.getByRole("region", { name: "Character entry", exact: true })).toBeVisible();
  await expect(review.getByRole("log", { name: "Reviewer responses", exact: true })).toHaveCount(0);
  await expect(review.getByLabel("Characters", { exact: true })).toHaveValue(original.source);
  await review.getByRole("button", { name: "あ a", exact: true }).click();
  await expect(review.getByLabel("Characters", { exact: true })).toHaveValue(`${original.source}あ`);
  await expect(review.getByRole("group", { name: "Glossary kanji" })).toContainText("太郎");
  await expect(review.getByRole("group", { name: "Glossary kanji" })).toContainText("待って");
  await expect(review.getByRole("group", { name: "Glossary kanji" })).not.toContainText("ここで");
  await review.getByRole("button", { name: "Katakana", exact: true }).click();
  await expect(review.getByRole("button", { name: "ア a", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Hiragana", exact: true }).click();
  await review.getByRole("button", { name: "Diacritic", exact: true }).click();
  await expect(review.getByRole("button", { name: "が ga", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Diacritic", exact: true }).click();
  await review.getByRole("button", { name: "Digraph", exact: true }).click();
  await expect(review.getByRole("button", { name: "きゃ kya", exact: true })).toBeVisible();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review.getByRole("button", { name: "Enter characters", exact: true })).toBeVisible();
  await expect(review.getByRole("log", { name: "Reviewer responses", exact: true })).toBeVisible();
  await expect(review.locator(".review-crop")).toBeVisible();
  await expect(review.locator(".action-card").getByText("English translation", { exact: true })).toBeVisible();
  await expect(review.locator(".action-card").getByText("Hold on!", { exact: true })).toBeVisible();
  const reviewBounds = await review.boundingBox();
  expect(reviewBounds.width).toBeGreaterThan(1200);
  expect(reviewBounds.height).toBeGreaterThan(850);
  const responseBounds = await review.getByRole("log").boundingBox();
  expect(responseBounds.height).toBeGreaterThan(650);
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({ path: "/tmp/scan-acceptance/region-review.png", fullPage: true });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(review.getByRole("button", { name: "Close AI dialog" })).toBeVisible();
  expect(await review.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await review.locator(".translation").scrollIntoViewIfNeeded();
  await expect(review.locator(".translation")).toBeVisible();
  await page.screenshot({ path: "/tmp/scan-acceptance/region-review-mobile.png", fullPage: true });
  await page.setViewportSize(viewport);
  await review.getByRole("button", { name: "View crop at 2×", exact: true }).click();
  await expect(review.getByRole("button", { name: "View crop at 2×", exact: true })).toHaveAttribute("aria-pressed", "true");
  await review.getByRole("button", { name: "Resubmit", exact: true }).click();
  await expect.poll(() => requests.filter(item => item.action === "review").length).toBe(4);
  expect(requests.filter(item => item.action === "review").slice(-2).every(item => item.cropScale === 2)).toBe(true);
  await expect(review.getByText("Waiting for response…")).toHaveCount(0);
  await expect(review.getByText("Sent crop: 2×", { exact: true })).toHaveCount(2);
  expect(requests.filter(item => item.action === "review").every(item => item.maskEnabled && item.mask?.startsWith("data:image/png;base64,"))).toBe(true);
  await review.getByLabel("Mask crop with detected text", { exact: true }).uncheck();
  await expect(review.getByRole("button", { name: "View crop at 2×", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      review.locator(".review-crop").evaluate((img) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  expect(
    requests
      .filter((r) => r.action === "review")
      .map((r) => r.reviewers.map((m) => m.model || m.engine))
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([["hayai-ocr-v2"], ["hayai-ocr-v2"], ["paddleocr-vl-1.6"], ["paddleocr-vl-1.6"]]);
  await review.getByRole("button", { name: "View crop at 4×", exact: true }).click();
  await review
    .getByRole("button", { name: "Run reviewer-grok-fixture", exact: true })
    .click();
  await expect(
    review.getByText("Grok reading of the crop.", { exact: true }),
  ).toBeVisible();
  const enlargedRequest = requests.filter(item => item.action === "review").at(-1);
  expect(enlargedRequest.cropScale).toBe(4);
  expect(enlargedRequest.maskEnabled).toBe(false);
  await expect(review.getByText("Sent crop: 4×", { exact: true })).toBeVisible();
  expect(
    requests
      .filter((r) => r.action === "review")
      .map((r) => r.reviewers.map((m) => m.model || m.engine))
      .sort((a, b) => String(a).localeCompare(String(b))),
  ).toEqual([
    ["hayai-ocr-v2"],
    ["hayai-ocr-v2"],
    ["paddleocr-vl-1.6"],
    ["paddleocr-vl-1.6"],
    ["reviewer-grok-fixture"],
  ]);
  await review
    .getByRole("button", { name: "Use source & English", exact: true })
    .click();
  await expect(review.getByText("Applied", { exact: true })).toBeVisible();
  let state = await (await context.request.get(`${api}/workflow`)).json();
  expect(state.lines.find((l) => l.id === original.id).source).toBe(
    "待って——！",
  );
  expect(state.lines.find(l => l.id === original.id).body).toBe("Hold on!");
  expect(state.jobs.filter(j => j.kind === "source-translation")).toEqual(before.jobs.filter(j => j.kind === "source-translation"));
  await expect(review.locator(".current")).toContainText("Hold on!");
  await review.getByRole("button", { name: "Close AI dialog" }).click();
  await card.getByRole("button", { name: "Enquire", exact: true }).click();
  const chat = page.getByRole("dialog", {
    name: "Enquire about region",
    exact: true,
  });
  for (const label of ["Page Summary", "Region", "Series Summary"])
    await expect(chat.getByLabel(label, { exact: true })).toBeChecked();
  for (const label of ["Region Image", "Page Image", "Chapter Summaries"])
    await expect(chat.getByLabel(label, { exact: true })).not.toBeChecked();
  await chat.getByLabel("Chat", { exact: true }).selectOption("composer-2.5");
  await chat
    .getByLabel("Your question", { exact: true })
    .fill("Would please wait fit better?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    chat.getByRole("button", { name: "Use English", exact: true }),
  ).toBeVisible();
  expect(requests.find((r) => r.action === "enquire" && r.history.length === 1).model.engine).toBe("composer-2.5");
  expect(requests.find((r) => r.action === "enquire" && r.history.length === 1).context).toEqual({
    regionImage: false,
    pageImage: false,
    pageSummary: true,
    chapterSummaries: false,
    region: true,
    seriesSummary: true,
  });
  await expect(chat.getByText("Already the current source and English.", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Use English", exact: true }).click();
  await expect(chat.getByText("Applied", { exact: true })).toBeVisible();
  await chat
    .getByLabel("Your question", { exact: true })
    .fill("What changes in tone?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.filter((r) => r.action === "enquire").length).toBe(2);
  const followUp = requests.filter((r) => r.action === "enquire")[1];
  expect(followUp.history.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(followUp.history[1].content).toContain("Please wait.");
  await expect(
    chat.getByRole("button", { name: "Send", exact: true }),
  ).toBeDisabled();
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({
    path: "/tmp/scan-acceptance/region-enquire.png",
    fullPage: true,
  });
  await chat.getByRole("button", { name: "Close AI dialog" }).click();
  await card.getByRole("button", { name: "Enquire", exact: true }).click();
  await expect(
    chat.getByText("What changes in tone?", { exact: true }),
  ).toBeVisible();
  await chat
    .getByRole("button", {
      name: "New conversation / change context",
      exact: true,
    })
    .click();
  await expect(chat.getByLabel("Region Image", { exact: true })).toBeEnabled();
  await chat.getByRole("button", { name: "Close AI dialog" }).click();
  state = await (await context.request.get(`${api}/workflow`)).json();
  const current = state.lines.find((l) => l.id === original.id);
  expect(current.source).toBe("待って——！");
  expect(current.body).toBe("Please wait.");
  const restore = await context.request.patch(`${api}/lines/${original.id}`, {
    data: {
      expectedRevision: current.revision,
      source: original.source,
      body: original.body,
      status: original.status,
      sourceState: original.sourceState,
    },
  });
  expect(restore.ok()).toBe(true);
  await page.reload({ waitUntil: "networkidle" });
  await goTranslate();
  await card.getByRole("button", { name: "Review Translation", exact: true }).click();
  const revise = page.getByRole("dialog", {
    name: "Review Translation translation",
    exact: true,
  });
  await expect(revise.getByRole("heading", { name: "Review Translation", exact: true })).toBeVisible();
  await revise.getByRole("button", { name: "Council settings…", exact: true }).click();
  const reviseSettings = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await expect(reviseSettings.getByRole("heading", { name: "Review Translation council", exact: true })).toBeVisible();
  await expect(reviseSettings.getByRole("tab", { name: "Review Translation", exact: true })).toHaveAttribute("aria-selected", "true");
  await reviseSettings.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await expect(reviseSettings).toBeHidden();
  await expect(revise).toBeVisible();
  await expect.poll(() => requests.some((item) => item.action === "revise"), { timeout: 15000 }).toBe(true);
  expect(requests.find((item) => item.action === "revise" && !item.selected).samples).toBeGreaterThanOrEqual(1);
  await expect(revise.getByText("Hold still!", { exact: true })).toBeVisible();
  await revise.getByLabel("Add another translator", { exact: true }).selectOption("grok-4.6");
  await revise.getByRole("button", { name: "Add", exact: true }).click();
  await revise.getByRole("button", { name: /Run / }).click();
  await expect(revise.getByText("Hold it right there!", { exact: true })).toBeVisible();
  expect(requests.some((item) => item.action === "revise" && item.selected === true)).toBe(true);
  await revise.getByRole("button", { name: "Use English", exact: true }).first().click();
  await expect(revise.getByText("Applied", { exact: true })).toBeVisible();
  await mkdir("/tmp/scan-acceptance", { recursive: true });
  await page.screenshot({ path: "/tmp/scan-acceptance/region-revise.png", fullPage: true });
  await revise.getByRole("button", { name: "Close revise English dialog" }).click();
  const restoreSettings = await context.request.post(`${api}/workflow`, {
    data: {
      action: "preferences",
      scope: "series",
      expectedRevision: state.seriesDefaults.revision,
      data: {
        regionAi: before.preferences.regionAi ?? {
          translate: { engine: "qwen3.8-27b-q4", model: "" },
          describe: { engine: "qwen3.8-27b-q4", model: "" },
          vision: { engine: "qwen3.8-27b-q4", model: "" },
          proofread: { engine: "qwen3.8-27b-q4", model: "" },
          enquire: { engine: "qwen3.8-27b-q4", model: "" },
          reviewers: [],
          transcriptionModels: ["hayai-ocr-v2", "paddleocr-vl-1.6"],
        },
      },
    },
  });
  expect(restoreSettings.ok()).toBe(true);
  const restoreGlossary = await context.request.patch(`${base}/api/series/fixture-series`, {
    data: { glossary: [] },
  });
  expect(restoreGlossary.ok()).toBe(true);
  await page.unroute("**/api/episodes/fixture-episode/region-ai");
  await page.unroute("**/api/ai/engines");
  await page.reload({ waitUntil: "networkidle" });
  await goTranslate();
}
