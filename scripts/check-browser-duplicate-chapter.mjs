/** Chapter duplication regression, using only the isolated browser fixture. */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, "chrome-linux64/chrome"))
    .find(p => existsSync(p)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dataDir = process.env.SCAN_TEST_DATA;
if (!dataDir || !dataDir.startsWith('/tmp/scan-browser-')) throw new Error('An isolated browser fixture is required');
const db = new Database(join(dataDir, 'scan.db'));
const originalId = 'fixture-episode';
const originalDir = join(dataDir, 'images', 'fixture-series', 'chapter-1');
const state = async id => {
  const response = await context.request.get(`${base}/api/episodes/${id}/workflow`);
  expect(response.ok()).toBe(true);
  return response.json();
};

try {
  // This undo folder caused the original EISDIR failure.
  await mkdir(join(originalDir, 'reslice-undo-saved'));
  await writeFile(join(originalDir, 'reslice-undo-saved', 'marker'), 'private undo');
  const orphan = join(dataDir, 'images', 'fixture-series', 'chapter-1-copy');
  await mkdir(orphan);
  await writeFile(join(orphan, 'marker'), 'older failed copy');
  const before = await state(originalId);
  const files = await Promise.all(before.images.map(image => readFile(join(originalDir, image.filename))));

  await page.goto(`${base}/series/fixture-series`, { waitUntil: 'networkidle' });
  await page.locator('form[action="?/duplicateEpisode"] button').waitFor();
  // Exercise error reporting and rollback through the enhanced form.
  db.exec(`CREATE TRIGGER fail_duplicate_images BEFORE INSERT ON images
    WHEN NEW.episode_id != 'fixture-episode'
    BEGIN SELECT RAISE(ABORT, 'simulated duplicate failure'); END`);
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.alert-hud')).toContainText('simulated duplicate failure');
  expect(new URL(page.url()).pathname).toBe('/series/fixture-series');
  expect(db.prepare('SELECT count(*) AS n FROM episodes').get().n).toBe(1);
  expect((await readdir(join(dataDir, 'images', 'fixture-series'))).sort()).toEqual(['chapter-1', 'chapter-1-copy']);
  db.exec('DROP TRIGGER fail_duplicate_images');

  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await page.waitForURL(/\/series\/fixture-series\/episodes\/(?!fixture-episode)[^/]+$/);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  const copyId = new URL(page.url()).pathname.split('/').at(-1);
  const copy = await state(copyId);
  expect(copy.images).toHaveLength(before.images.length);
  expect(copy.lines).toHaveLength(before.lines.length);
  for (const image of copy.images) expect(before.images.some(original => original.id === image.id)).toBe(false);
  const deleted = await context.request.post(`${base}/api/episodes/${copyId}/workflow`, { data: {
    action: 'remove-selected-page-regions', imageIds: copy.images.map(image => image.id),
  } });
  expect(deleted.ok()).toBe(true);
  for (const image of copy.images) {
    const reverted = await context.request.post(`${base}/api/episodes/${copyId}/pages`, { data: { op: 'revert', imageId: image.id } });
    expect(reverted.ok()).toBe(true);
  }
  expect((await state(copyId)).lines).toEqual([]);
  const after = await state(originalId);
  expect(after.images).toEqual(before.images);
  expect(after.lines).toEqual(before.lines);
  expect(after.pages).toEqual(before.pages);
  for (let i = 0; i < before.images.length; i++) expect(await readFile(join(originalDir, before.images[i].filename))).toEqual(files[i]);
  expect(await readFile(join(orphan, 'marker'), 'utf8')).toBe('older failed copy');
  expect(errors).toEqual([]);
  console.log('Chapter duplication passed: reslice undo directory, failure rollback, enhanced-form error and redirect, orphan preservation, independent removal and raw resets.');
} finally {
  db.exec('DROP TRIGGER IF EXISTS fail_duplicate_images');
  db.close();
  await browser.close();
}
