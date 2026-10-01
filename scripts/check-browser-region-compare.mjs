/**
 * Clean-step region menu → one animated image of the raw vs cleaned crop.
 * The point of the check is that the comparison keeps both frames (0.5s each)
 * in the APNG and in the GIF, because a still frame would hide the cleaning.
 */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Run through the isolated browser fixture runner");
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executablePath =
      readdirSync(cache)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
        .map((name) => join(cache, name, "chrome-linux64/chrome"))
        .find((path) => existsSync(path)) || executablePath;
}

/** Decode every frame and hash the pixels, so identical frames fail the check. */
const frameReport = (img, type) =>
  img.evaluate(async (element, type) => {
    await element.decode();
    const bytes = new Uint8Array(await (await fetch(element.src)).arrayBuffer());
    const decoder = new ImageDecoder({ data: bytes, type });
    await decoder.tracks.ready;
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frames = [];
    for (let index = 0; index < track.frameCount; index++) {
      const { image } = await decoder.decode({ frameIndex: index });
      const canvas = document.createElement("canvas");
      canvas.width = image.displayWidth;
      canvas.height = image.displayHeight;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let p = 0; p < pixels.length; p++) hash = Math.imul(hash ^ pixels[p], 16777619) >>> 0;
      frames.push({ duration: image.duration, hash, width: canvas.width, height: canvas.height });
      image.close();
    }
    return { frameCount: track.frameCount, frames };
  }, type);

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([
    { name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const workflowUrl = `${base}/api/episodes/fixture-episode/workflow`;
  const state = async () => (await context.request.get(workflowUrl)).json();
  const operation = async (data) => {
    const response = await context.request.post(workflowUrl, { data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.getByRole("navigation", { name: "Chapter workflow" }).waitFor();

  // Prepare the page, then mask the balloon outline inside region 1 and clean with the flat
  // fill. Region 1 sits on a white balloon, so the fill only shows where it erases the outline.
  let doc = (await operation({ action: "prepare", imageId: "fixture-page-0" })).doc;
  const mask = await operation({
    action: "mask",
    imageId: "fixture-page-0",
    expectedRevision: doc.revision,
    strokes: [0.1, 0.16, 0.22].map((y) => ({
      points: [0.68, 0.74, 0.8, 0.86].map((x) => ({ x, y })),
      radius: 24,
    })),
  });
  await expect
    .poll(async () => (await state()).jobs.find((job) => job.id === mask.jobId)?.state, { timeout: 60000 })
    .toBe("completed");
  doc = (await state()).pages["fixture-page-0"];
  const clean = await operation({
    action: "clean",
    imageId: "fixture-page-0",
    expectedRevision: doc.revision,
    method: "flat",
  });
  await expect
    .poll(async () => (await state()).jobs.find((job) => job.id === clean.jobId)?.state, { timeout: 60000 })
    .toBe("completed");
  doc = (await state()).pages["fixture-page-0"];
  assert.ok(doc.data.cleaned, "the fixture page is not cleaned");

  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Clean", exact: true }).click();
  await page.locator(".pages > button").first().click();
  const canvas = page.getByRole("application", { name: "Page regions and cleaning mask" });
  // The canvas region shapes ignore pointer events, so drive selection and the menu by event.
  const region = canvas.getByRole("button", { name: /^Region 1,/ });
  await region.dispatchEvent("click");
  await region.dispatchEvent("contextmenu");
  const compareItem = page.getByRole("menuitem", { name: "Compare raw vs cleaned…", exact: true });
  await expect(compareItem).toBeVisible();

  const apngResponse = page.waitForResponse(
    (response) => response.url().includes("variant=comparison") && !response.url().includes("format=gif"),
  );
  await compareItem.click();
  const apng = await apngResponse;
  assert.ok(apng.ok(), `comparison request failed with ${apng.status()}`);
  assert.equal(apng.headers()["content-type"], "image/apng");

  const dialog = page.getByRole("dialog", { name: /^Raw vs cleaned/ });
  await expect(dialog).toBeVisible();
  const image = dialog.locator("img");
  await expect.poll(async () => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  const apngFrames = await frameReport(image, "image/apng");
  assert.equal(apngFrames.frameCount, 2, "the APNG must carry both frames");
  assert.deepEqual(apngFrames.frames.map((frame) => frame.duration), [500000, 500000]);
  // Region 1 is 0.25 x 0.164 of an 800x1100 page: the crop, not the whole page.
  assert.deepEqual(apngFrames.frames.map((frame) => frame.width), [201, 201]);
  assert.deepEqual(apngFrames.frames.map((frame) => frame.height), [181, 181]);
  assert.notEqual(apngFrames.frames[0].hash, apngFrames.frames[1].hash, "raw and cleaned frames must differ");

  const gifResponse = page.waitForResponse(
    (response) => response.url().includes("variant=comparison") && response.url().includes("format=gif"),
  );
  await dialog.getByRole("button", { name: "GIF", exact: true }).click();
  const gif = await gifResponse;
  assert.equal(gif.headers()["content-type"], "image/gif");
  await expect.poll(async () => image.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  const gifFrames = await frameReport(image, "image/gif");
  assert.equal(gifFrames.frameCount, 2, "the GIF must carry both frames");
  assert.deepEqual(gifFrames.frames.map((frame) => frame.duration), [500000, 500000]);
  assert.notEqual(gifFrames.frames[0].hash, gifFrames.frames[1].hash);

  const save = dialog.getByRole("link", { name: "Save image", exact: true });
  const download = await save.getAttribute("download");
  assert.match(download, /^page.*region-1-raw-vs-clean\.gif$/, `unexpected download name: ${download}`);
  const link = await dialog.getByLabel("Image URL").inputValue();
  assert.ok(link.startsWith(`${base}/api/episodes/fixture-episode/region-ai?`), `unexpected image URL ${link}`);

  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  assert.deepEqual(errors, []);
  console.log(
    "Region compare checks passed: two-frame APNG and GIF at 0.5s per frame, raw and cleaned pixels differ, and the menu item opens and closes the dialog.",
  );
} finally {
  await browser.close();
}
