import { expect } from "@playwright/test";

/** Mock model responses; never invoke paid engines in browser acceptance. */
export async function checkReviewSafety({ page, context, base }) {
  const api = `${base}/api/episodes/fixture-episode`;
  const before = await (await context.request.get(`${api}/workflow`)).json();
  const local = { engine: "qwen3.8-27b-q4", model: "local-safety-fixture" };
  const paid = [
    { engine: "grok-4.6", model: "" },
    { engine: "gpt-5.4", model: "" },
    { engine: "composer-2.5", model: "" },
  ];
  const paidNames = ["Grok 4.6", "GPT-5.4", "Composer 2.5"];
  const saved = await context.request.post(`${api}/workflow`, { data: {
    action: "preferences", scope: "series", expectedRevision: before.seriesDefaults.revision,
    data: { regionAi: { ...Object.fromEntries(["translate", "vision", "describe", "proofread", "enquire"]
      .map(task => [task, { engine: "qwen3.8-27b-q4", model: "" }])), ...before.preferences.regionAi, reviewers: [local, ...paid] } },
  } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const requests = [];
  const maskRequests = [];
  let releaseMask;
  const maskReady = new Promise(resolve => { releaseMask = resolve; });
  let releaseReviews = () => {};
  let reviewsBlocked = true;
  const reviewsOpen = new Promise((resolve) => {
    releaseReviews = () => {
      reviewsBlocked = false;
      resolve();
    };
  });
  const CHAT = ["translate", "vision", "describe", "proofreadEnglish", "chapterReview", "advisory", "compactNotes", "alternatives", "pageImageProofread"];
  const reviewEngines = [
    { id: "qwen3.8-27b-q4", label: "Qwen 3.8 27B", available: true, group: "Local models", operations: [...CHAT, "sourceReview"], access: "local_http" },
    { id: "grok-4.6", label: "Grok 4.6", available: true, group: "CLI agents", operations: [...CHAT, "sourceReview"], access: "cli" },
    { id: "grok-4.5", label: "Grok 4.5", available: true, group: "CLI agents", operations: [...CHAT, "sourceReview"], access: "cli" },
    { id: "gpt-5.4", label: "GPT-5.4", available: true, group: "CLI agents", operations: [...CHAT, "sourceReview"], access: "cli" },
    { id: "composer-2.5", label: "Composer 2.5", available: true, group: "CLI agents", operations: [...CHAT, "sourceReview"], access: "cli" },
  ];
  await page.route("**/api/ai/engines", route => route.fulfill({ json: {
    engines: reviewEngines,
    rows: reviewEngines,
    sourceReviewModels: {},
    sourceReviewEngines: reviewEngines,
    localReviewModels: [{ id: "hayai-ocr-v2", label: "Hayai OCR v2" }],
  } }));
  await page.route("**/api/episodes/fixture-episode/region-ai", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    if (body.action === "detect-mask") {
      maskRequests.push(body);
      if (maskRequests.length === 1) await maskReady;
      return route.fulfill({ json: {
        mask: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      } });
    }
    requests.push(body);
    if (reviewsBlocked) await reviewsOpen;
    const model = body.reviewers[0];
    await route.fulfill({ json: { results: [{ model, answer: `Finished ${model.engine}`, cards: [] }] } });
  });
  const review = page.getByRole("dialog", { name: "AI source review", exact: true });
  const card = page.locator("#region-card-fixture-line-0-0");
  const close = () => review.getByRole("button", { name: "Close AI dialog" }).click();
  const runLocal = () => review.getByRole("button", { name: /^(Send to automatic reviewers|Resubmit)$/ });
  const runPaid = name => review.getByRole("button", { name: `Run ${name}`, exact: true });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  await card.getByRole("button", { name: "Review Transcription", exact: true }).click();
  await expect(review).toBeVisible();
  await expect(review.getByLabel("Mask crop with detected text", { exact: true })).toBeChecked();
  await expect.poll(() => maskRequests.length).toBe(1);
  await expect(runLocal()).toBeDisabled();
  await expect(review.getByRole("button", { name: "Brush", exact: true })).toBeDisabled();
  for (const name of paidNames) await expect(runPaid(name)).toBeDisabled();
  expect(requests).toHaveLength(0);
  releaseMask();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests.every(body => body.reviewers[0].engine === "qwen3.8-27b-q4" && !body.selectedReviewer)).toBe(true);
  expect(requests.every(body => body.maskEnabled && body.mask?.startsWith("data:image/png;base64,"))).toBe(true);
  await expect(review.getByRole("button", { name: "Brush", exact: true })).toBeEnabled();
  await expect(review.getByRole("button", { name: "Detect text", exact: true })).toBeEnabled();
  await expect(runLocal()).toBeEnabled();
  await expect(runLocal()).toHaveText("Resubmit");
  await runLocal().click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.every(body => body.reviewers[0].engine === "qwen3.8-27b-q4" && !body.selectedReviewer)).toBe(true);
  releaseReviews();
  await expect(review.getByText("Finished qwen3.8-27b-q4", { exact: true })).toBeVisible();
  for (const name of paidNames) await expect(runPaid(name)).toBeEnabled();
  await expect(runLocal()).toBeEnabled();
  await runLocal().click();
  await expect(runLocal()).toBeEnabled();
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.every(body => body.reviewers[0].engine === "qwen3.8-27b-q4" && !body.selectedReviewer)).toBe(true);
  for (const [i, model] of paid.entries()) {
    await runPaid(paidNames[i]).click();
    await expect(review.getByText(`Finished ${model.engine}`, { exact: true })).toBeVisible();
    expect(requests.at(-1).reviewers).toEqual([model]);
    expect(requests.at(-1).selectedReviewer).toEqual(model);
  }
  await runLocal().click();
  await expect(runLocal()).toBeEnabled();
  expect(requests.filter(body => body.selectedReviewer)).toHaveLength(3);
  await close();

  await card.dispatchEvent("contextmenu");
  const menuItems = await page.getByRole("menuitem").allTextContents();
  expect(menuItems[menuItems.indexOf("Read this area again with AI") + 1]).toBe("Review Transcription");
  const countBeforeOpen = requests.length;
  await page.getByRole("menuitem", { name: "Review Transcription", exact: true }).click();
  await expect(review).toBeVisible();
  await expect.poll(() => maskRequests.length).toBe(2);
  await expect.poll(() => requests.length).toBe(countBeforeOpen + 1);
  expect(requests.at(-1).reviewers[0].engine).toBe("qwen3.8-27b-q4");
  expect(requests.at(-1).selectedReviewer).toBeUndefined();
  for (const name of paidNames) await expect(runPaid(name)).toBeEnabled();

  let heldRoute;
  let release;
  const released = new Promise(resolve => { release = resolve; });
  let holdNext = true;
  await page.route("**/api/episodes/fixture-episode/workflow", async route => {
    if (route.request().method() !== "GET" || !holdNext) return route.continue();
    holdNext = false;
    heldRoute = route;
    await released;
    await route.continue();
  });
  await runLocal().click();
  await expect.poll(() => Boolean(heldRoute)).toBe(true);
  await review.getByRole("button", { name: "AI model settings…", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "AI model settings", exact: true });
  await settings.getByRole("tab", { name: "Review Transcription", exact: true }).click();
  await settings.getByLabel("Reviewer 1", { exact: true }).selectOption("grok-4.5");
  // Header and footer action bars both render Save; either commits the form.
  await settings.locator("button.save").first().click();
  await expect(settings).toBeHidden();
  await expect(runPaid("Grok 4.5")).toBeEnabled();
  await expect(runPaid(paidNames[1])).toBeEnabled();
  const refreshed = page.waitForResponse(response => response.url() === `${api}/workflow` && response.request().method() === "GET");
  release();
  await refreshed;
  await page.unroute("**/api/episodes/fixture-episode/workflow");
  await expect(runLocal()).toHaveCount(0);
  expect(requests).toHaveLength(countBeforeOpen + 1);
  await close();
  await card.getByRole("button", { name: "Review Transcription", exact: true }).click();
  await expect(review).toBeVisible();
  await expect.poll(() => maskRequests.length).toBe(3);
  await expect(runPaid(paidNames[1])).toBeEnabled();
  await expect(runLocal()).toHaveCount(0);
  expect(requests).toHaveLength(countBeforeOpen + 1);
  await close();

  const other = page.locator("#region-card-fixture-line-0-1");
  await other.getByRole("button", { name: /^#\d/ }).click();
  await other.getByRole("button", { name: "Review Transcription", exact: true }).click();
  await expect.poll(() => maskRequests.at(-1)?.lineId).toBe("fixture-line-0-1");
  await expect(runPaid(paidNames[1])).toBeEnabled();
  await expect(review.getByLabel("Mask crop with detected text", { exact: true })).toBeChecked();
  await close();

  const state = await (await context.request.get(`${api}/workflow`)).json();
  const restored = await context.request.post(`${api}/workflow`, { data: {
    action: "preferences", scope: "series", expectedRevision: state.seriesDefaults.revision,
    data: { regionAi: before.preferences.regionAi ?? {
      translate: { engine: "qwen3.8-27b-q4", model: "" },
      describe: { engine: "qwen3.8-27b-q4", model: "" },
      vision: { engine: "qwen3.8-27b-q4", model: "" },
      proofread: { engine: "qwen3.8-27b-q4", model: "" },
      enquire: { engine: "qwen3.8-27b-q4", model: "" },
      reviewers: [],
      transcriptionModels: ["hayai-ocr-v2", "paddleocr-vl-1.6"],
    } },
  } });
  expect(restored.ok()).toBe(true);
  await page.unroute("**/api/episodes/fixture-episode/region-ai");
  await page.unroute("**/api/ai/engines");
}
