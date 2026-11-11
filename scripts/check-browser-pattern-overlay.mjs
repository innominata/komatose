import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { readPsd } from 'ag-psd';
import sharp from 'sharp';

/**
 * Pattern overlay: a screentone added in Settings is picked in a region's Layer style, the
 * layout embeds it, and the PSD carries both the pattern and the layer effect.
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
// A small dot screentone: black dots on white, 16 px pitch.
const tone = process.env.SCAN_TEST_PATTERN
  ? readFileSync(process.env.SCAN_TEST_PATTERN)
  : await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#fff"/><circle cx="8" cy="8" r="4"/></svg>')).png().toBuffer();

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
  // Settings: add the pattern through the library's file picker.
  await page.goto(`${base}/settings`);
  const library = page.getByRole('region', { name: 'Pattern library' });
  await expect(library.getByText('No patterns yet.')).toBeVisible();
  // Through the button, as a person would; the chooser only opens once the page is live.
  // A fresh dev server may reload the page once while it optimises dependencies.
  await page.waitForLoadState('networkidle');
  let chooser;
  for (let attempt = 0; attempt < 3 && !chooser; attempt++) {
    const waiting = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
    await library.getByRole('button', { name: 'Choose files…' }).click();
    chooser = await waiting;
  }
  expect(chooser, 'Choose files… opens a file chooser').toBeTruthy();
  await chooser.setFiles({ name: 'dots-screentone.png', mimeType: 'image/png', buffer: tone });
  await expect(library.getByLabel('Pattern name')).toHaveValue('dots screentone');
  const { patterns } = await (await context.request.get(`${base}/settings/patterns`)).json();
  expect(patterns).toHaveLength(1);
  const patternId = patterns[0].id;
  expect(patternId).toMatch(/^[a-f\d]{32}$/);
  await page.screenshot({ path: `${shots}/pattern-library.png`, fullPage: true });

  // Workflow: a typeset region with a font.
  const upload = await context.request.post(url, { multipart: {
    font: { name: 'FreeSans.ttf', mimeType: 'font/ttf', buffer: readFileSync('/usr/share/fonts/gnu-free/FreeSans.ttf') },
  } });
  expect(upload.ok()).toBeTruthy();
  const initial = await state();
  const fontId = initial.fonts.find(f => f.familyName === 'FreeSans').id;
  await operation({ action: 'preferences', scope: 'series', expectedRevision: initial.seriesDefaults.revision,
    data: { styles: { '""': { fontId, size: 28 } } } });
  const id = 'fixture-line-0-0';
  await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision, data: { style: { fontId, size: 28 } } });
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await expect(page.getByLabel('Default size (pt)', { exact: true })).toHaveValue('28');
  await page.getByText('Layer style', { exact: false }).first().click();
  await page.getByRole('checkbox', { name: 'Pattern Overlay' }).check();
  await expect(page.getByRole('option', { name: 'dots screentone' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => (await state()).regions[id].data.style?.effects?.patternOverlay?.patternId).toBe(patternId);
  await expect.poll(async () => (await state()).regions[id].data.layout?.svg ?? '').toContain('fx-pat');
  await page.getByLabel('Blend mode').last().selectOption('multiply');
  await expect.poll(async () => (await state()).regions[id].data.layout?.svg ?? '').toContain('mix-blend-mode:multiply');
  await page.locator('details.ls').getByLabel('Scale (%)').fill('20');
  await page.locator('details.ls').getByLabel('Scale (%)').dispatchEvent('change');
  await expect.poll(async () => (await state()).regions[id].data.style?.effects?.patternOverlay?.scale).toBe(20);
  await expect.poll(async () => (await state()).regions[id].data.layout?.style.effects?.patternOverlay?.scale).toBe(20);
  await page.screenshot({ path: `${shots}/pattern-overlay-inspector.png` });
  const typeset = await context.request.get(`${base}/api/episodes/fixture-episode/images/fixture-page-0/png?variant=typeset`);
  if (typeset.ok()) await sharp(await typeset.body()).extract({ left: 560, top: 120, width: 240, height: 160 }).resize({ width: 720 }).toFile(`${shots}/pattern-overlay-zoom.png`);

  // PSD: the pattern resource and the layer's pattern overlay name the same UUID.
  const psdRes = await context.request.get(`${base}/api/episodes/fixture-episode/images/fixture-page-0/psd?draft=1`);
  expect(psdRes.ok(), await psdRes.text().catch(() => '')).toBeTruthy();
  const psd = readPsd(await psdRes.body(), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true, useImageData: true });
  const uuid = patternId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  expect(psd.patterns?.map(p => p.id)).toEqual([uuid]);
  const flat = (layers) => layers.flatMap(l => (l.children ? flat(l.children) : [l]));
  const layer = flat(psd.children ?? []).find(l => l.name?.includes(id));
  expect(layer?.effects?.patternOverlay?.pattern?.id).toBe(uuid);
  expect(layer?.effects?.patternOverlay?.blendMode).toBe('multiply');

  // Removing a pattern in use asks first, then clears it from the style.
  const refused = await context.request.delete(`${base}/settings/patterns/${patternId}`);
  expect(refused.status()).toBe(409);
  expect((await context.request.delete(`${base}/settings/patterns/${patternId}?force=1`)).ok()).toBeTruthy();
  expect((await state()).regions[id].data.style?.effects?.patternOverlay?.patternId).toBe('');
  expect(errors).toEqual([]);
  console.log('pattern overlay browser checks passed');
} finally {
  await browser.close();
}
