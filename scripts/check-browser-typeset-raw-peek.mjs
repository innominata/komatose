import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/**
 * Typeset raw crop preview: selecting a region shows its raw crop beside the page, in the
 * blank canvas space, and it follows the selection.
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
try {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  const peek = page.locator('[data-find="typeset-raw-peek"]');
  await expect(peek).toHaveCount(0);
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await expect(peek).toBeVisible();
  await expect(peek.getByRole('img', { name: 'Raw crop of the selected region' })).toBeVisible();
  // Beside the page, not over it, when there is room.
  const pageBox = await page.locator('.canvas-scroll > .canvas-page').first().boundingBox();
  const peekBox = await peek.boundingBox();
  expect(pageBox && peekBox).toBeTruthy();
  const beside = peekBox.x >= pageBox.x + pageBox.width || peekBox.x + peekBox.width <= pageBox.x;
  await page.screenshot({ path: `${shots}/typeset-raw-peek-docked.png` });
  // Docked over the page when there is no room beside it, it keeps clear of the region.
  // (Region 1 of the fixture is on the right of the page, so the preview docks on the left.)
  if (!beside) expect(peekBox.x + peekBox.width).toBeLessThan(pageBox.x + pageBox.width / 2);
  // Zoomed out, it sits in the blank space beside the page.
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: /zoom out/i }).click();
  await expect.poll(async () => {
    const p = await page.locator('.canvas-scroll > .canvas-page').first().boundingBox();
    const k = await peek.boundingBox();
    return !!p && !!k && (k.x >= p.x + p.width || k.x + k.width <= p.x);
  }).toBe(true);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/typeset-raw-peek-beside.png` });
  // Leaving Typeset hides it.
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(peek).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('Typeset raw peek: ok');
} finally {
  await browser.close();
}
