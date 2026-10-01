/** Debug: dump the export status region after reload. */
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

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
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  const workflow = `${base}/api/episodes/fixture-episode/workflow`;
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Export`);
  await page.getByRole("heading", { name: "Export the chapter" }).waitFor();
  const op = async (data) => {
    const response = await context.request.post(workflow, { data });
    if (!response.ok()) throw new Error(await response.text());
    return response.json();
  };
  const st = async () => (await context.request.get(workflow)).json();
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
  await op({ action: "approve-all-geometry" });
  await op({ action: "renumber" });
  await page.reload();
  await page.getByRole("heading", { name: "Export the chapter" }).waitFor();
  const markAll = page.getByRole("button", { name: "Mark every page complete", exact: true });
  await expect(markAll).toBeEnabled({ timeout: 15000 });
  page.once("dialog", (dialog) => dialog.accept());
  await markAll.click();
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  const generate = page.getByRole("button", { name: "Generate ZIP", exact: true });
  await expect(generate).toBeEnabled({ timeout: 15000 });
  await page.getByLabel("Export format").selectOption("png");
  const downloading = page.waitForEvent("download", { timeout: 30000 });
  await generate.click();
  const download = await downloading;
  console.log("download filename:", download.suggestedFilename());
  await page.waitForTimeout(1500);
  const status = page.getByRole("status");
  console.log("STATUS COUNT:", await status.count());
  for (let i = 0; i < await status.count(); i++) {
    console.log(`STATUS[${i}]:`, (await status.nth(i).innerText()).replace(/\n/g, " | "));
    console.log(`STATUS[${i}] html:`, (await status.nth(i).innerHTML()).slice(0, 600));
  }
  console.log("jobs now:", JSON.stringify((await st()).jobs.map(j => ({ id: j.id, kind: j.kind, state: j.state, progress: j.progress }))));
  await page.reload();
  await page.getByRole("heading", { name: "Export the chapter" }).waitFor();
  await page.getByRole("checkbox", { name: "Label as draft" }).check();
  await page.waitForTimeout(1500);
  const status2 = page.getByRole("status");
  console.log("AFTER RELOAD STATUS COUNT:", await status2.count());
  for (let i = 0; i < await status2.count(); i++) {
    console.log(`RELOAD STATUS[${i}]:`, (await status2.nth(i).innerText()).replace(/\n/g, " | "));
  }
  console.log("jobs after reload:", JSON.stringify((await st()).jobs.map(j => ({ id: j.id, kind: j.kind, state: j.state, payload: j.payload, progress: j.progress }))));
} finally {
  await browser.close();
}
