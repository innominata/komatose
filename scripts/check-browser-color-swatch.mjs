import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/**
 * Colour swatch: a click starts the eyedropper with a colour panel beside the swatch. The panel
 * picks a colour by hand, and the eyedropper samples the Typeset raw crop preview as well as
 * the page.
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
  await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision, data: { style: { fontId, size: 28, fill: '#000000' } } });
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForLoadState('networkidle');
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  const fill = () => state().then(s => s.regions[id].data.style?.fill);

  // The panel: the top-right corner of the square at hue 0 is pure red, saved on release.
  await page.locator('input[type=color][aria-label="Fill color"]').first().click();
  const panel = page.locator('[data-find="color-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('Hex colour')).toHaveValue('#000000');
  const sv = await panel.getByRole('slider', { name: 'Saturation and brightness' }).boundingBox();
  await page.mouse.move(sv.x + sv.width - 1, sv.y + 1);
  await page.mouse.down();
  await page.mouse.up();
  await expect(panel.getByLabel('Hex colour')).toHaveValue(/^#f[cdef][0-3][0-9a-f][0-3][0-9a-f]$/);
  await page.screenshot({ path: `${shots}/color-panel.png` });
  // Typed hex: saved on Enter.
  await panel.getByLabel('Hex colour').fill('#123456');
  await panel.getByLabel('Hex colour').press('Enter');
  await expect.poll(fill).toBe('#123456');
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel).toHaveCount(0);

  // The eyedropper samples the raw crop preview.
  const peek = page.locator('[data-find="typeset-raw-peek"] img');
  await expect(peek).toBeVisible();
  const box = await page.locator('[data-find="typeset-raw-peek"] .raw-peek-crop').boundingBox();
  const at = { x: box.x + 4, y: box.y + 4 };
  const expected = await peek.evaluate((img, at) => {
    const r = img.getBoundingClientRect();
    const ix = Math.floor(((at.x - r.left) / r.width) * img.naturalWidth);
    const iy = Math.floor(((at.y - r.top) / r.height) * img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d');
    g.drawImage(img, ix, iy, 1, 1, 0, 0, 1, 1);
    const [R, G, B] = g.getImageData(0, 0, 1, 1).data;
    return '#' + [R, G, B].map(v => v.toString(16).padStart(2, '0')).join('');
  }, at);
  await page.locator('input[type=color][aria-label="Fill color"]').first().click();
  await page.mouse.move(at.x, at.y);
  await expect(page.locator('.eyedropper-value')).toContainText(expected);
  await page.mouse.click(at.x, at.y);
  await expect.poll(fill).toBe(expected);
  expect(errors).toEqual([]);
  console.log(`Colour swatch: ok (raw preview sampled ${expected})`);
} finally {
  await browser.close();
}
