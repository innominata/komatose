// Typeset: Shift-dragging a polygon corner slants the edge and ramps the glyph sizes along
// it; a Shift-click still removes the point. "Stack letters vertically" puts each letter on
// its own line.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
if (!base) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  executablePath = (existsSync(cache) ? readdirSync(cache) : []).filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, 'chrome-linux64/chrome')).find(existsSync)
    || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : executablePath);
}
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
  // A flat rectangle and a short shout, fitted.
  await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision,
    data: { style: { fontId, size: 60, minSize: 6 }, polygon: [{ x: .55, y: .3 }, { x: .95, y: .3 }, { x: .95, y: .4 }, { x: .55, y: .4 }] } });
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  // Opening Typeset prepares the page and refits; wait for the region to settle, then reload
  // so the studio holds its current revision.
  let settled = -1;
  await expect.poll(async () => {
    const r = (await state()).regions[id];
    const stable = r.revision === settled;
    settled = r.revision;
    return stable;
  }, { intervals: [1000], timeout: 20000 }).toBe(true);
  const refit = await operation({ action: 'fit', id, expectedRevision: settled });
  expect(refit.doc.data.layout.overflow).toBe(false);
  await page.reload();
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await page.waitForLoadState('networkidle');
  const corner = page.getByRole('button', { name: 'Move polygon point 2', exact: true });
  await expect(corner).toBeVisible();

  const posts = [];
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/workflow')) posts.push(JSON.parse(r.postData() || '{}')); });
  const box = await corner.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Pull the top-right corner up (and a little sideways, which the ramp drag ignores).
  await page.keyboard.down('Shift');
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 30, at.y - 60, { steps: 6 });
  await page.mouse.move(at.x + 30, at.y - 100, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => posts.find(p => p.data?.sizeRamp)).toBeTruthy();
  const sent = posts.find(p => p.data?.sizeRamp).data;
  expect(sent.sizeRamp.to).toBe(100);
  expect(sent.sizeRamp.from).toBeLessThan(60);
  expect(sent.polygon[1].x).toBeCloseTo(.95, 3); // the corner moved straight up
  expect(sent.polygon[1].y).toBeLessThan(.3);
  let region = (await state()).regions[id];
  await expect.poll(async () => (region = (await state()).regions[id]).data.layout?.charStyles?.length ?? 0, { timeout: 15000 }).toBeGreaterThan(2);
  const sizes = region.data.layout.rows[0].pieces.map(p => region.data.layout.charStyles[p.style].size);
  expect(sizes.every((s, i) => i === 0 || s >= sizes[i - 1])).toBe(true);
  expect(sizes.at(-1)).toBe(100);
  await page.getByRole('tab', { name: 'Shape & mask', exact: true }).click();
  await expect(page.locator('[data-find="size-ramp"]')).toContainText('→ 100%');
  await page.screenshot({ path: '/tmp/scan-acceptance/size-ramp.png' });

  // Stack letters vertically.
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await page.locator('[data-find="stacked-text"]').check();
  await expect.poll(async () => {
    const layout = (await state()).regions[id].data.layout;
    return layout?.style?.stacked === true && layout.rows.filter(r => r.text).every(r => [...r.text].length === 1);
  }, { timeout: 15000 }).toBe(true);
  await page.screenshot({ path: '/tmp/scan-acceptance/size-ramp-stacked.png' });

  // Remove the ramp from the Shape tab.
  await page.getByRole('tab', { name: 'Shape & mask', exact: true }).click();
  await page.getByRole('button', { name: 'Remove size ramp', exact: true }).click();
  await expect.poll(async () => (await state()).regions[id].data.sizeRamp ?? null).toBe(null);

  if (errors.length) throw new Error(`Page errors: ${errors.join('; ')}`);
  console.log('size ramp ok');
} finally {
  await browser.close();
}
