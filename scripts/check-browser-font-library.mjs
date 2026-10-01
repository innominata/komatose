import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
if (!base) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, 'chrome-linux64/chrome')).find(existsSync) || executablePath;
}
const dir = process.env.SCAN_TEST_FONT_DIR || '/usr/share/fonts/gnu-free';
const fonts = ['FreeSans.ttf', 'FreeSansBold.ttf', 'FreeSansOblique.ttf'].map(name => ({
  name, mimeType: 'font/ttf', buffer: readFileSync(join(dir, name)),
}));

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const prompts = [];
page.on('dialog', d => { prompts.push(d.message()); void d.accept(); });
const workflow = `${base}/api/episodes/fixture-episode/workflow`;
const tab = name => page.getByRole('tab', { name: new RegExp(`^${name}\\b`) });
const row = name => page.locator('.fl-row').filter({ hasText: name });

try {
  await page.goto(`${base}/settings`);
  await expect(page.getByText('No shared fonts yet.')).toBeVisible();

  // Several fonts in one upload, filed under a category chosen up front.
  await page.getByLabel('Upload TTF or OTF').setInputFiles(fonts);
  await page.locator('select[name="category"]').selectOption('sfx');
  await page.getByRole('button', { name: 'Upload fonts' }).click();
  await expect(page.getByText('Added 3 fonts to the library.')).toBeVisible();
  await expect(page.locator('.fl-row')).toHaveCount(3);
  await expect(tab('Sfx')).toContainText('3');
  await expect(tab('All')).toContainText('3');
  await expect(page.locator('.fl-group')).toHaveCount(1);
  await expect(page.locator('.fl-group-title')).toContainText('Sfx');

  // One font moved on its own; groups and tab counts follow.
  await row('FreeSans · Bold').getByLabel(/^Category of/).selectOption('handwriting');
  await expect(page.getByText('Filed under Handwriting.')).toBeVisible();
  await expect(tab('Handwriting')).toContainText('1');
  await expect(tab('Sfx')).toContainText('2');
  await expect(page.locator('.fl-group-title')).toHaveText([/Sfx/, /Handwriting/]);
  await tab('Handwriting').click();
  await expect(page.locator('.fl-row')).toHaveCount(1);
  await tab('All').click();

  // Bulk select and recategorise.
  await page.getByLabel('Select all shown').check();
  await expect(page.getByText('3 selected')).toBeVisible();
  await page.getByLabel('Category for selected fonts').selectOption('overtext');
  await page.getByRole('button', { name: 'Set category' }).click();
  await expect(page.getByText('Filed 3 fonts under Overtext.')).toBeVisible();
  await expect(tab('Overtext')).toContainText('3');
  await row('FreeSans · Bold').getByLabel(/^Category of/).selectOption('lettering');
  await row('FreeSans · Oblique').getByLabel(/^Category of/).selectOption('system');
  await expect(page.locator('.fl-group-title')).toHaveText([/Lettering/, /Overtext/, /System/]);
  await page.screenshot({ path: '/tmp/scan-font-library-list.png', fullPage: true });

  // Inspector: every glyph, block filter, code search and the detail pane.
  await row('FreeSans · Regular').getByRole('button', { name: 'Inspect' }).click();
  const inspector = page.getByRole('dialog', { name: /FreeSans · Regular/ });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText(/characters/)).toBeVisible();
  const all = await inspector.locator('.fl-glyph').count();
  expect(all).toBeGreaterThan(100);
  await inspector.locator('.fl-glyph[title="U+0041"]').click();
  await page.screenshot({ path: '/tmp/scan-font-library-inspector.png' });
  await inspector.getByLabel('Block').selectOption('Basic Latin');
  await expect(inspector.locator('.fl-glyph[title="U+0041"]')).toHaveText('A');
  await inspector.getByLabel('Find character or code').fill('U+0041');
  await expect(inspector.locator('.fl-glyph')).toHaveCount(1);
  await inspector.locator('.fl-glyph').click();
  await expect(inspector.locator('.fl-glyph-detail')).toContainText('U+0041');
  await expect(inspector.locator('.fl-glyph-detail')).toContainText('Basic Latin');
  // Filters combine: é is outside Basic Latin, so it only appears once the block is widened.
  await inspector.getByLabel('Find character or code').fill('é');
  await expect(inspector.locator('.fl-glyph')).toHaveCount(0);
  await inspector.getByLabel('Block').selectOption('Latin-1 Supplement');
  await expect(inspector.locator('.fl-glyph[title="U+00E9"]')).toHaveCount(1);
  await inspector.getByRole('button', { name: 'Close' }).click();
  await expect(inspector).toBeHidden();

  // Font pickers group by category, in category order.
  await page.goto(`${base}/series/fixture-series`);
  await page.getByRole('button', { name: 'Type Settings…' }).click();
  const picker = page.locator('dialog.type-settings select').filter({ has: page.locator('optgroup') }).first();
  await expect(picker.locator('optgroup')).toHaveCount(3);
  expect(await picker.locator('optgroup').evaluateAll(g => g.map(x => x.label))).toEqual(['Lettering', 'Overtext', 'System']);
  await expect(picker.locator('optgroup[label="Lettering"] option')).toHaveText(['FreeSans · Bold']);
  await page.keyboard.press('Escape');
  // Shared fonts show inside a series as read-only.
  await expect(page.locator('.fl-row').first().getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(page.locator('.fl-badge').first()).toHaveText('Shared');

  // Removing an unused font.
  await page.goto(`${base}/settings`);
  prompts.length = 0;
  await row('FreeSans · Oblique').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.fl-row')).toHaveCount(2);
  await expect(page.getByText('Removed 1 font.')).toBeVisible();
  expect(prompts).toHaveLength(1);

  // A font a style still uses needs a second, explicit go-ahead, then clears that style.
  const before = await (await context.request.get(workflow)).json();
  const boldId = before.fonts.find(f => f.subfamilyName === 'Bold').id;
  const saved = await context.request.post(workflow, { data: { action: 'preferences', scope: 'series',
    expectedRevision: before.seriesDefaults.revision, data: { styles: { '""': { fontId: boldId, size: 16 } } } } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  prompts.length = 0;
  await page.reload();
  await row('FreeSans · Bold').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.fl-row')).toHaveCount(1);
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toMatch(/still selected in type styles/);
  const after = await (await context.request.get(workflow)).json();
  expect(after.fonts.map(f => f.subfamilyName)).toEqual(['Regular']);
  expect(after.seriesDefaults.data.styles['""'].fontId).toBe('');

  // Declining the second prompt keeps the font.
  const again = await (await context.request.get(workflow)).json();
  const regularId = again.fonts[0].id;
  const kept = await context.request.post(workflow, { data: { action: 'preferences', scope: 'series',
    expectedRevision: again.seriesDefaults.revision, data: { styles: { '""': { fontId: regularId, size: 16 } } } } });
  expect(kept.ok(), await kept.text()).toBeTruthy();
  page.removeAllListeners('dialog');
  let n = 0;
  page.on('dialog', d => { void (n++ === 0 ? d.accept() : d.dismiss()); });
  await page.reload();
  await row('FreeSans · Regular').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText(/kept 1 that are in use|Removed 0/)).toHaveCount(0);
  await expect(page.locator('.fl-row')).toHaveCount(1);
  expect((await (await context.request.get(workflow)).json()).fonts).toHaveLength(1);

  expect(errors).toEqual([]);
  console.log('Font library browser checks passed: multi-upload with category, per-font and bulk categories, tabs, glyph inspector, grouped pickers, safe removal.');
} finally {
  await page.screenshot({ path: '/tmp/scan-font-library-browser.png', fullPage: true }).catch(() => {});
  await browser.close();
}
