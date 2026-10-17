/** Run with: node scripts/test-browser.mjs scripts/check-browser-review-compare.mjs */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base);
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  executable = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(path => existsSync(path)) || executable;
}
const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.locator('.pages > button').first().click();
  const toggle = page.locator('[data-find="view-compare"]');
  await expect(toggle).toHaveAttribute('aria-label', /Raw view: normal/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', /Raw view: raw/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', /Raw view: side-by-side/);
  await expect(page.locator('.review-raw-page')).toBeVisible();
  await expect(page.locator('.canvas-page:not(.review-raw-page)')).toBeVisible();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByTitle('Fit both pages').click();
  const geometry = await page.evaluate(() => {
    const scroll = document.querySelector('.canvas-scroll').getBoundingClientRect();
    const raw = document.querySelector('.review-raw-page').getBoundingClientRect();
    const normal = document.querySelector('.canvas-page:not(.review-raw-page)').getBoundingClientRect();
    return { scroll: { left: scroll.left, right: scroll.right }, raw: { left: raw.left, right: raw.right }, normal: { left: normal.left, right: normal.right } };
  });
  assert.ok(geometry.raw.left >= geometry.scroll.left - 1);
  assert.ok(geometry.normal.right <= geometry.scroll.right + 1);
  assert.ok(geometry.raw.right < geometry.normal.left);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', /Raw view: normal/);
  await expect(page.locator('.review-raw-page')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Clean', exact: true }).click();
  const tools = page.getByRole('toolbar', { name: 'Tools' });
  await tools.getByRole('button', { name: 'Restore (H)' }).click();
  const feather = page.getByRole('slider', { name: 'Brush feather' });
  await expect(feather).toHaveValue('100');
  await feather.fill('0');
  await expect(page.getByText('0%', { exact: true })).toBeVisible();
  await tools.getByRole('button', { name: 'Paint raw (S)' }).click();
  await expect(feather).toHaveValue('0');
  await feather.fill('50');
  await expect(page.getByText('50%', { exact: true })).toBeVisible();
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
