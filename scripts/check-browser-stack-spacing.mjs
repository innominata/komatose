import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/** Stacked text: the Stack spacing field pulls the letters together in the saved layout. */
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
async function operation(data) {
  const response = await context.request.post(url, { data });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBeTruthy();
  return result;
}
try {
  const upload = await context.request.post(url, { multipart: {
    font: { name: 'FreeSans.ttf', mimeType: 'font/ttf', buffer: readFileSync('/usr/share/fonts/gnu-free/FreeSans.ttf') },
  } });
  expect(upload.ok()).toBeTruthy();
  const initial = await state();
  const fontId = initial.fonts.find(f => f.familyName === 'FreeSans').id;
  const id = 'fixture-line-0-0';
  await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision, data: { style: { fontId, size: 28 } } });
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await expect(page.locator('[data-find="stack-spacing"]')).toHaveCount(0);
  await page.locator('[data-find="stacked-text"]').check();
  const rows = async () => (await state()).regions[id].data.layout?.rows ?? [];
  await expect.poll(async () => (await rows()).length).toBeGreaterThan(2);
  const field = page.locator('[data-find="stack-spacing"]');
  await expect(field).toHaveValue('0');
  const before = await rows();
  const beforeSize = (await state()).regions[id].data.layout.size;
  const pitch = (r) => (r[1].baseline - r[0].baseline);
  await field.fill('-400');
  await field.dispatchEvent('change');
  await expect.poll(async () => (await state()).regions[id].data.style?.stackSpacing).toBe(-400);
  await expect.poll(async () => {
    const l = (await state()).regions[id].data.layout;
    return l.style.stackSpacing === -400 && pitch(l.rows) / l.size < pitch(before) / beforeSize - 0.39;
  }).toBe(true);
  await page.screenshot({ path: `${shots}/stack-spacing.png` });
  expect(errors).toEqual([]);
  console.log('Stack spacing: ok');
} finally {
  await browser.close();
}
