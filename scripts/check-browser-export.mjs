/** Run with: node scripts/test-browser.mjs scripts/check-browser-export.mjs */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import JSZip from "jszip";
import sharp from "sharp";

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
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{
    name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/",
  }]);
  const page = await context.newPage();
  const errors = [];
  const downloads = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("download", (download) => downloads.push(download));
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  let heldJobId;
  let failureJobId;
  let simulateFailure = false;
  let refreshes = 0;
  await page.route(`${workflow}*`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body.action === "export" && data.jobId) {
        if (simulateFailure) failureJobId = data.jobId;
        else if (body.format === "jpg") heldJobId = data.jobId;
        else {
          // Exercise completion before the export request returns to the UI.
          await expect.poll(async () => {
            const state = await (await context.request.get(workflow)).json();
            return state.jobs.find((job) => job.id === data.jobId)?.state;
          }, { timeout: 30000 }).toBe("completed");
        }
      }
    } else {
      refreshes++;
      if (Array.isArray(data.jobs))
        data.jobs = data.jobs.map((job) => {
          if (job.id === heldJobId)
            return { ...job, state: "running", progress: {} };
          if (job.id === failureJobId)
            return { ...job, state: "failed", error: "Fixture export failure", progress: {} };
          return job;
        });
    }
    await route.fulfill({ response, json: data });
  });

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Export`);
  await page.getByRole("heading", { name: "Export the chapter" }).waitFor();
  await expect(page.getByRole("button", { name: "Accept all translations", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve all geometry", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep current layouts", exact: true })).toBeVisible();
  const metadataCheckbox = page.getByRole("checkbox", { name: "Include metadata and scripts" });
  await expect(metadataCheckbox).not.toBeChecked();
  const generate = page.getByRole("button", { name: "Generate ZIP", exact: true });
  await expect(generate).toBeDisabled(); // Preserve finished-export readiness checks.
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  await expect(generate).toBeEnabled();
  await page.getByLabel("Export format").selectOption("english");
  await page.getByRole("checkbox", { name: "Label as draft" }).uncheck();
  await expect(generate).toBeEnabled();
  await page.getByLabel("Export format").selectOption("png");
  await expect(generate).toBeDisabled();
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  const op = async (data) => {
    const response = await context.request.post(workflow, { data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  const st = async () => (await context.request.get(workflow)).json();
  // Clear every readiness blocker so the panel's "Mark every page complete"
  // becomes the only thing left, as the export readiness rules require.
  // The fixture ships without fonts: upload one and point every line type at it.
  const fontUpload = await context.request.post(workflow, {
    multipart: {
      font: {
        name: "FreeSans.ttf",
        mimeType: "font/ttf",
        buffer: await readFile("/usr/share/fonts/gnu-free/FreeSans.ttf"),
      },
    },
  });
  if (!fontUpload.ok()) throw new Error(await fontUpload.text());
  let snapshot = await st();
  const fontId = snapshot.fonts.find((font) => font.familyName === "FreeSans").id;
  const lineTypes = [...new Set(snapshot.lines.filter((line) => line.imageId).map((line) => line.lineType))];
  await op({
    action: "preferences",
    expectedRevision: snapshot.chapter.revision,
    data: { styles: Object.fromEntries(lineTypes.map((type) => [type, { fontId }])) },
  });
  for (const imageId of ["fixture-page-0", "fixture-page-1"]) {
    await op({ action: "prepare", imageId });
    const doc = (await st()).pages[imageId];
    await op({ action: "page", imageId, expectedRevision: doc.revision, data: { cleanApproved: true } });
  }
  await op({ action: "approve-all-translations" });
  const fitJob = await op({ action: "typeset-all", scope: "chapter" });
  await expect
    .poll(async () => (await st()).jobs.find((job) => job.id === fitJob.jobId)?.state, { timeout: 60000 })
    .toBe("completed");
  // Fitting derives geometry for polygon-less regions and marks it for review,
  // so approve the geometry only after the typeset pass has run.
  await op({ action: "approve-all-geometry" });
  await op({ action: "renumber" });
  await page.reload();
  await page.getByRole("heading", { name: "Export the chapter" }).waitFor();
  const markAll = page.getByRole("button", { name: "Mark every page complete", exact: true });
  await expect(markAll).toBeEnabled({ timeout: 15000 });
  page.once("dialog", (dialog) => dialog.accept());
  await markAll.click();
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  await expect(generate).toBeEnabled({ timeout: 15000 });

  for (const format of ["png", "jpg"]) {
    await page.getByLabel("Export format").selectOption(format);
    const downloading = page.waitForEvent("download", { timeout: 30000 });
    await generate.click();
    if (format === "jpg") {
      await expect(page.getByRole("button", { name: "Building ZIP…" })).toBeDisabled();
      await expect(page.getByRole("status").filter({ hasText: "Building your ZIP" })).toBeVisible();
      heldJobId = undefined;
    }
    const download = await downloading;
    assert.equal(await download.failure(), null);
    assert.equal(download.suggestedFilename(), `DRAFT-chapter-1-${format}.zip`);
    const zip = await JSZip.loadAsync(await readFile(await download.path()));
    const images = Object.keys(zip.files).filter((name) => /\.(png|jpg)$/.test(name));
    assert.deepEqual(images, [`1.${format}`, `2.${format}`]);
    assert.deepEqual(Object.keys(zip.files), images, "Default ZIPs must contain only image files, even for drafts");
    for (const name of images) {
      const metadata = await sharp(await zip.file(name).async("nodebuffer")).metadata();
      assert.equal(metadata.format, format === "jpg" ? "jpeg" : "png");
      assert.equal(metadata.width, 800);
      assert.equal(metadata.height, 1100);
    }
    await expect(page.getByRole("status").getByRole("link", {
      name: `Download DRAFT-chapter-1-${format}.zip`, exact: true,
    })).toBeVisible();
  }
  const before = refreshes;
  await expect.poll(() => refreshes, { timeout: 15000 }).toBeGreaterThan(before + 1);
  assert.equal(downloads.length, 2, "Polling must not download completed exports again");

  await page.reload();
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  // Retention keeps one export per chapter — the newest — so the surviving
  // saved link after a reload is the JPG the loop generated last.
  await page.getByLabel("Export format").selectOption("jpg");
  const savedLink = page.getByRole("status").getByRole("link", {
    name: "Download DRAFT-chapter-1-jpg.zip", exact: true,
  });
  await expect(savedLink).toBeVisible();
  assert.equal(downloads.length, 2, "Existing exports must not download on reload");
  const manualDownload = page.waitForEvent("download");
  await savedLink.click();
  assert.equal((await manualDownload).suggestedFilename(), "DRAFT-chapter-1-jpg.zip");

  // The retained export is the JPG; switch back to PNG for the metadata pass,
  // which the loop proved works, and confirm the old JPG link is gone.
  await page.getByLabel("Export format").selectOption("png");
  await metadataCheckbox.check();
  await expect(savedLink).not.toBeVisible();
  const metadataDownload = page.waitForEvent("download");
  await generate.click();
  const complete = await JSZip.loadAsync(await readFile(await (await metadataDownload).path()));
  assert.deepEqual(Object.keys(complete.files).sort(), [
    "1.png", "2.png", "DRAFT.txt", "bilingual.txt", "chapter.json", "english.txt", "font-manifest.json",
  ]);
  assert.equal(JSON.parse(await complete.file("chapter.json").async("string")).includeMetadata, true);
  await metadataCheckbox.uncheck();

  simulateFailure = true;
  await generate.click();
  await expect(page.getByRole("status").filter({ hasText: "Export failed. Fixture export failure" })).toBeVisible();
  await expect(generate).toBeEnabled();
  assert.equal(downloads.length, 4, "Failed exports must not download a stale artifact");
  assert.deepEqual(errors, []);

  await page.getByRole("button", { name: "Enable public viewer", exact: true }).click();
  const viewerUrl = await page.getByLabel("Viewer URL").inputValue();
  assert.match(viewerUrl, /\/p\//);
  const viewer = await context.newPage();
  await viewer.goto(viewerUrl);
  await viewer.locator(".strip-image img").first().waitFor();
  await expect.poll(async () =>
    viewer.locator(".strip-image img").evaluateAll((imgs) =>
      imgs.map((img) => ({ w: img.clientWidth, h: img.clientHeight })),
    ),
  ).toEqual([{ w: 800, h: 1100 }, { w: 800, h: 1100 }]);
  await viewer.close();
  console.log("Export browser checks passed: PNG/JPG image-only ZIPs, optional metadata, immediate/delayed completion, one automatic download, saved links, readiness, failure recovery, and unscaled public viewer.");
} finally {
  await browser.close();
}
