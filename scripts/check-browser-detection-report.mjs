import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium, expect } from '@playwright/test';

/**
 * Series detection report: detected regions recorded for the fixture, one deleted through the
 * editor's API and one ignored, show up as false positives of the detectors that found them,
 * with a crop of each rejected region.
 */
const base = process.env.SCAN_TEST_BASEURL;
const dataDir = process.env.SCAN_TEST_DATA;
if (!base || !dataDir) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, 'chrome-linux64/chrome')).find(existsSync) || executablePath;
}
const shots = '/tmp/scan-acceptance';
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  // Empty report first.
  await page.goto(`${base}/series/fixture-series`);
  await page.locator('[data-find="detection-report-link"]').click();
  await expect(page.locator('[data-find="detection-empty"]')).toBeVisible();

  // Record a detection of page 0 the way Transcribe does.
  const db = new Database(join(dataDir, 'scan.db'));
  const now = Date.now();
  db.prepare(`INSERT INTO detection_runs(id,series_id,episode_id,image_id,setup,conf,width,height,outputs,prior_lines,created_at)
    VALUES('run-1','fixture-series','fixture-episode','fixture-page-0','rtdetr+sam-ts-l',0.2,800,1100,'{}','[]',?)`).run(now);
  const lines = db.prepare("SELECT id,x,y,w,h FROM lines WHERE image_id='fixture-page-0' ORDER BY id").all();
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const insert = db.prepare(`INSERT INTO detection_regions(id,run_id,series_id,episode_id,image_id,line_id,x,y,w,h,kind,cls,score,sources,scores,outcome,reason,created_at)
    VALUES(?,'run-1','fixture-series','fixture-episode','fixture-page-0',?,?,?,?,?,?,?,?,?,?,'saved','',?)`);
  insert.run('d-kept', lines[0].id, lines[0].x, lines[0].y, lines[0].w, lines[0].h, 'bubble', 'text_bubble', 0.9, '["rtdetr","ctd"]', '{"rtdetr":0.9,"ctd":0.8}', now);
  insert.run('d-deleted', lines[1].id, lines[1].x, lines[1].y, lines[1].w, lines[1].h, 'unknown', 'text', 0.64, '["ctd"]', '{"ctd":0.64}', now);
  db.close();
  // Deleted in the editor: the region's DELETE marks the detection as rejected.
  const del = await context.request.delete(`${base}/api/episodes/fixture-episode/lines/${lines[1].id}`);
  expect(del.ok(), await del.text()).toBeTruthy();

  await page.getByRole('button', { name: 'Refresh' }).click();
  const totals = page.locator('[data-find="detection-totals"]');
  await expect(totals).toContainText('2regions shown to you');
  await expect(totals).toContainText('1false positives · 50%');
  await expect(page.locator('[data-find="detection-hotspots"]')).toContainText('Comic Text Detector alone · score 0.6–0.8');
  await expect(page.getByRole('region', { name: 'By detectors that agreed' })).toContainText('RT-DETR + Comic Text Detector');
  const crop = page.locator('[data-find="detection-rejected"] img').first();
  await expect(crop).toBeVisible();
  await expect.poll(() => crop.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
  await expect(page.locator('[data-find="detection-rejected"]')).toContainText('CTD 0.64');
  await page.screenshot({ path: `${shots}/detection-report.png`, fullPage: true });

  const csv = await context.request.get(`${base}/api/series/fixture-series/detection?format=csv`);
  expect(csv.ok()).toBeTruthy();
  const text = await csv.text();
  expect(text.split('\n')[0]).toContain('detectors,detector_scores,outcome');
  expect(text).toContain('ctd,ctd=0.64,removed');
  expect(errors).toEqual([]);
  console.log('Detection report: ok');
} finally {
  await browser.close();
}
