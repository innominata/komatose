import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/**
 * Public preview link: each finished page shows its raw beside it by default, the toggle turns
 * that off and is remembered, and the raw route serves the page's raw image to a guest.
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
const owner = await browser.newContext();
await owner.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const errors = [];
try {
  const res = await owner.request.post(`${base}/api/episodes/fixture-episode/preview`, { data: {} });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { token } = await res.json();
  expect(token).toBeTruthy();

  // A guest: no session cookie.
  const guest = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await guest.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const raw = await guest.request.get(`${base}/p/${token}/i/fixture-page-0?raw=1`);
  expect(raw.ok()).toBeTruthy();
  expect(raw.headers()['content-type']).toBe('image/png');
  const finished = await guest.request.get(`${base}/p/${token}/i/fixture-page-0`);
  expect(finished.ok()).toBeTruthy();
  expect((await guest.request.get(`${base}/p/${'x'.repeat(30)}/i/fixture-page-0?raw=1`)).status()).toBe(404);

  await page.goto(`${base}/p/${token}`);
  // A fresh dev server may still be compiling the client; the toggle only works once hydrated.
  await page.waitForLoadState('networkidle');
  const toggle = page.getByLabel('Raw side by side');
  await expect(toggle).toBeChecked();
  const rawImg = page.getByRole('img', { name: /^Raw / }).first();
  await expect(rawImg).toBeVisible();
  await expect.poll(() => rawImg.evaluate(i => i.complete && i.naturalWidth > 0)).toBe(true);
  // Raw on the left, finished on the right, same row.
  const pair = page.locator('.pair').first();
  const [a, b] = await Promise.all([pair.locator('img').nth(0).boundingBox(), pair.locator('img').nth(1).boundingBox()]);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x);
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);
  await page.screenshot({ path: `${shots}/preview-raw-side-by-side.png` });

  await toggle.uncheck();
  await expect(page.getByRole('img', { name: /^Raw / })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Raw side by side')).not.toBeChecked();
  await expect(page.getByRole('img', { name: /^Raw / })).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('Preview raw side by side: ok');
} finally {
  await browser.close();
}
