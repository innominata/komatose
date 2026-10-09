/** Run against scripts/test-browser.mjs's isolated fixture, never the live chapter. */
import { chromium, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const base = process.env.SCAN_TEST_BASEURL || 'http://127.0.0.1:5188';
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
const state = async () => (await context.request.get(`${api}/workflow`)).json();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const dialogs = [];
let accept = false;
page.on('dialog', async dialog => {
  dialogs.push(dialog.message());
  if (accept) await dialog.accept(); else await dialog.dismiss();
});
const open = async (step, id) => {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=${step}&page=${id}`);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).waitFor();
  await expect(page.locator('.pagefoot .pf-info')).toBeVisible();
};

try {
  const bytes = await sharp({ create: { width: 200, height: 300, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  const upload = await context.request.post(`${api}/images`, { multipart: {
    files: { name: 'done-first.png', mimeType: 'image/png', buffer: bytes },
  } });
  expect(upload.ok()).toBeTruthy();
  const first = (await upload.json()).images[0];
  const others = [];
  for (const name of ['done-middle.png', 'unfinished-last.png']) {
    const response = await context.request.post(`${api}/images`, { multipart: {
      files: { name, mimeType: 'image/png', buffer: bytes },
    } });
    expect(response.ok()).toBeTruthy();
    others.push((await response.json()).images[0]);
  }
  const markMiddle = await context.request.post(`${api}/workflow`, { data: {
    action: 'forget-page-history', imageId: others[0].id, step: 'typeset',
  } });
  expect(markMiddle.ok()).toBeTruthy();
  await open('Typeset', first.id);
  const lastNumber = (await state()).images.findIndex(image => image.id === others[1].id) + 1;
  await page.locator('button[data-find="mark-done"]').click();
  await expect(page.locator('.pagefoot .pf-info')).toContainText(`Page ${lastNumber}`);
  expect(dialogs).toEqual([]); // Neither confirmation nor a failed-save navigation.
  expect((await state()).pages[first.id].data.completed.typeset).toBeTruthy();

  await open('Prepare', first.id);
  const before = await state();
  let resliceRequests = 0;
  page.on('request', request => {
    if (request.url() === `${api}/pages` && request.method() === 'POST' && request.postDataJSON()?.op === 'reslice') resliceRequests++;
  });
  await page.getByRole('button', { name: 'Split strips', exact: true }).click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('automatic cuts');
  expect(resliceRequests).toBe(0);
  expect((await state()).images.map(image => image.id)).toEqual(before.images.map(image => image.id));

  const red = await sharp({ create: { width: 200, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
  const replacement = await context.request.put(`${api}/images/${first.id}`, { multipart: {
    file: { name: 'replacement.png', mimeType: 'image/png', buffer: red },
  } });
  expect(replacement.ok()).toBeTruthy();
  await page.reload();
  await page.locator('[data-find="more-prepare"]').click();
  const undo = page.locator('[data-find="prepare-undo"]');
  await expect(undo).toContainText('Replace page from replacement.png');
  await undo.click();
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[1]).toContain('Affected: page');
  expect(dialogs[1]).toContain('saved cleaning, region positions and lettering');
  const cancelled = await (await context.request.get(`${api}/pages`)).json();
  expect(cancelled.undo.label).toContain('Replace page from replacement.png');
  accept = true;
  await page.locator('[data-find="more-prepare"]').click();
  await undo.click();
  await expect.poll(async () => (await (await context.request.get(`${api}/pages`)).json()).undoCount).toBe(cancelled.undoCount - 1);
  expect(errors).toEqual([]);
  console.log('Prepare confirmations/verbose Undo and Typeset skip-done navigation passed.');
} finally {
  await browser.close();
}
