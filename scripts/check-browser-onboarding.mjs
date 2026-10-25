/** Run against scripts/test-browser.mjs's isolated fixture, never the live chapter. */
import { chromium, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const base = process.env.SCAN_TEST_BASEURL || 'http://127.0.0.1:5188';
const shots = process.env.SCAN_TEST_SHOTS || '';
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(path => existsSync(path)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const api = `${base}/api/episodes/fixture-episode`;
const count = async () => (await (await context.request.get(`${api}/workflow`)).json()).images.length;
const errors = [];
page.on('pageerror', error => errors.push(error.message));

try {
  const png = async (background) => sharp({ create: { width: 200, height: 300, channels: 3, background } }).png().toBuffer();
  const files = [
    { name: 'p2.png', mimeType: 'image/png', buffer: await png('#cc4444') },
    { name: 'p1.png', mimeType: 'image/png', buffer: await png('#4444cc') },
  ];
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Prepare`);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).waitFor();
  const before = await count();

  // The step's first action pulses until it is used once.
  const pulse = (find) => page.locator(`[data-find="${find}"]`).first().evaluate(el => getComputedStyle(el).animationName);
  await expect.poll(() => pulse('upload')).toMatch(/first-action-pulse/);

  // Choosing files opens a preview that must be confirmed or cancelled.
  await page.locator('[data-find="upload"] input[type=file]').setInputFiles(files);
  const dialog = page.getByRole('dialog', { name: 'Add 2 images' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toHaveCount(2);
  await expect(dialog.locator('.name').first()).toHaveText('p1.png');
  if (shots) await page.screenshot({ path: join(shots, 'upload-preview.png') });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => pulse('upload')).toBe('none');
  await expect(dialog).toBeHidden();
  if (await count() !== before) throw new Error('Cancel still uploaded');

  await page.locator('[data-find="upload"] input[type=file]').setInputFiles(files);
  await dialog.getByRole('button', { name: 'Remove p2.png' }).click();
  await page.getByRole('dialog', { name: 'Add 1 image' }).getByRole('button', { name: 'Upload 1 image' }).click();
  await expect(page.getByRole('dialog', { name: /Add \d image/ })).toBeHidden();
  await expect.poll(count).toBe(before + 1);

  // Dragging a thumbnail onto another moves it there.
  const order = async () => (await (await context.request.get(`${api}/workflow`)).json()).images.map(i => i.id);
  const start = await order();
  await page.locator('.organize .gcard[draggable="true"] .gimg').nth(0)
    .dragTo(page.locator('.organize .gcard[draggable="true"] .gimg').nth(1));
  await expect.poll(order).toEqual([start[1], start[0], ...start.slice(2)]);

  // Dropping image files on the grid opens the same preview.
  const transfer = await page.evaluateHandle(async (b64) => {
    const dt = new DataTransfer();
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    dt.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    return dt;
  }, files[0].buffer.toString('base64'));
  await page.locator('[data-find="upload"]').dispatchEvent('drop', { dataTransfer: transfer });
  const dropped = page.getByRole('dialog', { name: 'Add 1 image' });
  await expect(dropped).toContainText('dropped.png');
  await dropped.getByRole('button', { name: 'Cancel' }).click();

  // The tutorial opens from the View menu and drives the studio to each step.
  await page.locator('[data-find="view-menu"]').click();
  await page.getByRole('menuitem', { name: 'Tutorial' }).click();
  const tour = page.getByRole('dialog', { name: 'Tutorial' });
  await expect(tour).toContainText('Welcome');
  for (let i = 0; i < 3; i++) await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Transcribe and translate');
  await expect(page.locator('.studio-stepper .step.active')).toContainText('Translate');
  await expect.poll(() => pulse('transcribe')).toMatch(/first-action-pulse/);
  if (shots) await page.screenshot({ path: join(shots, 'tutorial.png') });
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Add a region');
  await expect(page.locator('[data-find="tool-region"]')).toHaveAttribute('aria-pressed', 'true');
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText("Change a region's type");
  await expect(page.locator('[data-find="region-type"]').first()).toBeVisible();
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Delete a region');
  await expect(page.locator('[data-find="delete-region"]')).toBeVisible();
  if (shots) await page.screenshot({ path: join(shots, 'tutorial-delete.png') });
  await tour.getByRole('button', { name: 'Close tutorial' }).click();
  await expect(tour).toBeHidden();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('onboarding ok');
} finally {
  await browser.close();
}
