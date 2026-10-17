import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
if (!base) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(existsSync) || executablePath;
}
if (!existsSync(executablePath)) throw new Error('Playwright Chromium is not installed');
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const api = `${base}/api/episodes/fixture-episode/workflow`;
const state = async () => (await context.request.get(api)).json();
async function operation(data) {
  const response = await context.request.post(api, { data });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBeTruthy();
  return result;
}

try {
  const uploaded = await context.request.post(api, { multipart: {
    font: { name: 'FreeSans.ttf', mimeType: 'font/ttf', buffer: readFileSync('/usr/share/fonts/gnu-free/FreeSans.ttf') },
  } });
  expect(uploaded.ok()).toBeTruthy();
  const fontId = (await state()).fonts.find(font => font.familyName === 'FreeSans').id;
  const id = 'fixture-line-0-0';
  const initial = await state();
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });
  const polygon = [{ x: .65, y: .08 }, { x: .92, y: .08 }, { x: .92, y: .27 }, { x: .65, y: .27 }];
  const changed = await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision,
    data: { polygon, style: { fontId, size: 16, rotation: 0 }, geometryApproved: true } });
  await operation({ action: 'fit', id, expectedRevision: changed.doc.revision });

  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Typeset&page=fixture-page-0`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  const before = (await state()).regions[id].data;
  await page.getByRole('button', { name: 'Rotate bubble geometry', exact: true }).press('ArrowRight');
  await expect.poll(async () => (await state()).regions[id].data.polygon).not.toEqual(before.polygon);
  let turned = (await state()).regions[id].data;
  expect(turned.style.rotation).toBe(before.style.rotation);
  expect(turned.layout.style.rotation).toBeCloseTo(turned.geometryRotation + turned.style.rotation, 4);
  const handle = await page.getByRole('button', { name: 'Rotate bubble geometry', exact: true }).boundingBox();
  if (!handle) throw new Error('Geometry rotation handle is not visible');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await state()).regions[id].data.polygon).not.toEqual(turned.polygon);
  turned = (await state()).regions[id].data;
  expect(turned.style.rotation).toBe(before.style.rotation);
  expect(turned.layout.style.rotation).toBeCloseTo(turned.geometryRotation + turned.style.rotation, 4);

  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  const textRotation = page.getByRole('spinbutton', { name: 'Text rotation (°)', exact: true });
  await expect(textRotation).toHaveValue('0');
  const layoutKey = turned.layout.key;
  await textRotation.fill('27');
  await textRotation.press('Tab');
  await expect.poll(async () => (await state()).regions[id].data.style.rotation).toBe(27);
  const afterText = (await state()).regions[id].data;
  expect(afterText.layout.style.rotation).toBeCloseTo(turned.geometryRotation + 27, 4);
  expect(afterText.layout.key).not.toBe(layoutKey);
  expect(afterText.polygon).toEqual(turned.polygon);

  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).focus();
  const beforeNudge = (await state()).regions[id].data;
  const beforeLine = (await state()).lines.find(line => line.id === id);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await state()).lines.find(line => line.id === id)?.x)
    .toBeCloseTo(beforeLine.x + 1 / initial.images[0].width, 8);
  const afterNudge = (await state()).regions[id].data;
  expect(afterNudge.polygon[0].x).toBeCloseTo(beforeNudge.polygon[0].x + 1 / initial.images[0].width, 8);
  await page.keyboard.press('PageDown');
  await expect.poll(async () => (await state()).regions[id].data.geometryRotation)
    .toBeCloseTo(afterNudge.geometryRotation + 0.1, 5);
  const afterKeyRotation = (await state()).regions[id].data;
  expect(afterKeyRotation.layout.style.rotation).toBeCloseTo(afterKeyRotation.geometryRotation + 27, 4);

  const regionsButton = page.locator('[data-find="view-regions"]');
  await regionsButton.click();
  await expect(regionsButton).toHaveAttribute('aria-label', /Regions: ghost/);
  await expect(page.locator('[data-region-overlay]')).toHaveAttribute('opacity', '0.1');
  await expect(page.getByRole('button', { name: /^Region 1(,.*)?$/ })).toBeVisible();
  await regionsButton.click();
  await expect(regionsButton).toHaveAttribute('aria-label', /Regions: off/);
  await expect(page.getByRole('button', { name: /^Region 1(,.*)?$/ })).toHaveCount(0);
  await regionsButton.click();
  await expect(regionsButton).toHaveAttribute('aria-label', /Regions: shown/);
  await expect(page.getByRole('button', { name: /^Region 1(,.*)?$/ })).toBeVisible();
  console.log('Text rotation inheritance, keyboard nudges, and three region overlay states pass.');
} finally {
  await browser.close();
}
