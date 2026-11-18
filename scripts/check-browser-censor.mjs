import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import JSZip from 'jszip';
import sharp from 'sharp';

/**
 * Censor boxes: drawn with the Censor tool in Translate, saved on their own record, and
 * painted black only in exports that ask for it. Censored and full ZIPs are both kept.
 */
const base = process.env.SCAN_TEST_BASEURL;
if (!base) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
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
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const url = `${base}/api/episodes/fixture-episode/workflow`;
const state = async () => (await context.request.get(url)).json();
const imageId = 'fixture-page-0';
const boxes = async () => (await state()).censors?.[imageId]?.data.rects ?? [];

/** Export as a draft PNG ZIP and return the first page's pixel at a page fraction. */
async function exportPixel(censored, fx, fy) {
  const started = await context.request.post(url, { data: { action: 'export', format: 'png', draft: true, quality: 95, includeMetadata: false, censored } });
  const result = await started.json();
  expect(started.ok(), JSON.stringify(result)).toBeTruthy();
  const { jobId } = result;
  let job;
  await expect.poll(async () => {
    job = (await state()).jobs.find(j => j.id === jobId);
    return job?.state;
  }, { timeout: 60_000 }).toBe('completed');
  expect(job.progress.filename.endsWith(censored ? '-png-censored.zip' : '-png.zip'), job.progress.filename).toBeTruthy();
  const zip = await JSZip.loadAsync(await (await context.request.get(`${url}/assets/${job.progress.artifact}`)).body());
  const png = await zip.file('1.png').async('nodebuffer');
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (Math.floor(fy * info.height) * info.width + Math.floor(fx * info.width)) * info.channels;
  return { rgb: [...data.subarray(i, i + 3)], jobId };
}

try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await page.waitForLoadState('networkidle');

  const canvas = page.getByRole('application', { name: 'Page regions and cleaning mask' });
  const area = await canvas.boundingBox();
  if (!area) throw new Error('page canvas is not visible');
  await page.locator('[data-find="tool-censor"]').click();
  await expect(page.getByRole('region', { name: 'Tool options' })).toContainText('Censor box');
  await page.mouse.move(area.x + area.width * 0.10, area.y + area.height * 0.60);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.30, area.y + area.height * 0.75, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await boxes()).length).toBe(1);
  const [box] = await boxes();
  expect(box.x).toBeGreaterThan(0.08);
  expect(box.x + box.w).toBeLessThan(0.32);
  await expect(page.locator('g.censor-box')).toHaveCount(1);
  // Clean's page history never sees it.
  expect((await state()).pages[imageId].canUndo ?? false).toBeFalsy();
  await page.screenshot({ path: `${shots}/censor-translate.png` });

  // The box shows in Review too, but not in Typeset.
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('g.censor-box')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await expect(page.locator('g.censor-box')).toHaveCount(0);
  // Opening Typeset prepares the page; let that finish before exporting prepares it too.
  await expect.poll(async () => !!(await state()).pages[imageId].data.prepared).toBe(true);
  await page.waitForLoadState('networkidle');

  // Two exports: censored is black inside the box, the full one is not.
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const censored = await exportPixel(true, cx, cy);
  expect(censored.rgb).toEqual([0, 0, 0]);
  const full = await exportPixel(false, cx, cy);
  expect(full.rgb).not.toEqual([0, 0, 0]);
  const kept = (await state()).jobs.filter(j => j.kind === 'export').map(j => j.id).sort();
  expect(kept).toEqual([censored.jobId, full.jobId].sort());

  // Export panel offers the Censor option with the page count.
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('[data-find="censor-export"]')).toContainText('Censor (1 page)');
  await page.screenshot({ path: `${shots}/censor-export.png` });

  // Remove it with the × on the box.
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await page.locator('[data-find="tool-censor"]').click();
  await page.getByRole('button', { name: 'Remove censor box' }).click();
  await expect.poll(async () => (await boxes()).length).toBe(0);
  await expect(page.locator('g.censor-box')).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('censor browser checks passed');
} finally {
  await browser.close();
}
