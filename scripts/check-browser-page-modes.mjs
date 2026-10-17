/** Run with: node scripts/test-browser.mjs scripts/check-browser-page-modes.mjs */
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
  await expect(page.locator('[data-find="split-spreads"]')).toBeVisible();
  await expect(page.locator('[data-find="auto-reslice"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Series', exact: true }).click();
  await page.getByLabel('Page mode').selectOption('strip');
  await expect(page.getByLabel('Page mode')).toHaveValue('strip');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('[data-find="split-spreads"]')).toHaveCount(0);
  await expect(page.locator('[data-find="auto-reslice"]')).toBeVisible();
  const grid = page.locator('.organize');
  await expect(grid).toHaveClass(/strip/);
  await grid.getByRole('checkbox', { name: 'Select page 1' }).check();
  await grid.getByRole('checkbox', { name: 'Select page 2' }).check();
  const join = grid.getByRole('button', { name: 'Join strips' });
  await expect(join).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  const response = page.waitForResponse(res => res.url().endsWith('/pages') && res.request().method() === 'POST');
  await join.click();
  assert.equal((await response).status(), 200);
  const state = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  assert.equal(state.images.length, 1);
  assert.equal(state.images[0].height, 2200);
  assert.equal(state.lines.length, 6);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
