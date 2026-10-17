import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, 'Run through the isolated browser fixture runner');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(existsSync) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const api = `${base}/api/episodes/fixture-episode`;
  const state = async () => (await context.request.get(`${api}/workflow`)).json();
  const initial = await state();
  const preferences = await context.request.post(`${api}/workflow`, { data: {
    action: 'preferences', expectedRevision: initial.chapter.revision,
    data: { regionAi: { ...Object.fromEntries(['translate', 'describe', 'vision', 'proofread', 'enquire']
      .map(task => [task, { engine: 'qwen', model: 'proofreader-fixture' }])), reviewers: [] } },
  } });
  assert.ok(preferences.ok());

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Review&page=fixture-page-0`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.locator('.pages > button').first().click();
  await page.locator('[data-find="more-review"]').click();
  await page.locator('[data-find="page-proofreader"]').click();
  const window = page.getByRole('dialog', { name: 'Page proofreader', exact: true });
  await expect(window).toBeVisible();
  assert.equal(await window.evaluate(element => element.tagName), 'DIV');

  const beforeMove = await window.boundingBox();
  const header = window.getByRole('toolbar', { name: 'Move proofreader window' });
  const handle = await header.boundingBox();
  await page.mouse.move(handle.x + 80, handle.y + 20);
  await page.mouse.down();
  await page.mouse.move(handle.x + 160, handle.y + 75, { steps: 5 });
  await page.mouse.up();
  const moved = await window.boundingBox();
  assert.ok(moved.x > beforeMove.x + 60 && moved.y > beforeMove.y + 40, 'Window should move with its header');

  const english = page.locator('#region-card-fixture-line-0-0').getByLabel('English', { exact: true });
  await english.click();
  await expect(english).toBeFocused();
  await expect(window).toBeVisible();

  const beforeResize = await window.boundingBox();
  await page.mouse.move(beforeResize.x + beforeResize.width - 3, beforeResize.y + beforeResize.height - 3);
  await page.mouse.down();
  await page.mouse.move(beforeResize.x + beforeResize.width + 45, beforeResize.y + beforeResize.height + 35, { steps: 5 });
  await page.mouse.up();
  const resized = await window.boundingBox();
  assert.ok(resized.width > beforeResize.width + 25 && resized.height > beforeResize.height + 20,
    'Window should resize from its lower right corner');
  await expect(window.getByRole('textbox', { name: 'Follow-up', exact: true })).toBeVisible();
  await window.getByRole('button', { name: 'Close proofreader' }).click();
  await expect(window).toBeHidden();
  console.log('Proofreader window is non-modal, draggable, and resizable.');
} finally {
  await browser.close();
}
