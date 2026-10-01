/** Run with: node scripts/test-browser.mjs scripts/check-browser-series-renumber.mjs */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, 'Run through the isolated browser fixture runner');
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) {
    executable = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => join(cache, name, 'chrome-linux64/chrome'))
      .find((path) => existsSync(path)) || executable;
  }
}

const browser = await chromium.launch({ executablePath: executable, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{
    name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/',
  }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'The Lantern Keeper' })).toBeVisible();
  await expect.poll(async () => errors).toEqual([]);
  await expect(page.getByRole('link', { name: 'Chapter 1 chapter-1' })).toBeVisible();
  await page.getByRole('button', { name: 'Renumber', exact: true }).click();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeVisible();
  await page.locator('form[action="?/renameEpisode"] input[name="title"]').fill('12.5');
  await save.click();
  await expect(page.getByRole('link', { name: '12.5 12.5' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Renumber', exact: true })).toBeVisible();
  await expect(page.locator('form[action="?/renameEpisode"]')).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(errors, []);
  console.log('Series chapter renumber updates the list without a refresh.');
} finally {
  await browser.close();
}
