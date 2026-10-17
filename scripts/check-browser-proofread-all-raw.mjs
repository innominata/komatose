import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, 'Run through the isolated browser fixture runner');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(path => existsSync(path)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const api = `${base}/api/episodes/fixture-episode`;
  const state = async () => (await context.request.get(`${api}/workflow`)).json();
  const before = await state();
  const preferences = await context.request.post(`${api}/workflow`, { data: {
    action: 'preferences', expectedRevision: before.chapter.revision,
    data: { regionAi: { ...Object.fromEntries(['translate', 'describe', 'vision', 'proofread', 'enquire']
      .map(task => [task, { engine: 'qwen', model: 'proofreader-fixture' }])), reviewers: [] } },
  } });
  assert.ok(preferences.ok());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.getByRole('group', { name: 'Run on' }).getByRole('button', { name: 'Whole chapter', exact: true }).click();
  const allRaw = page.getByRole('button', { name: 'Proofread All Raw', exact: true });
  await expect(allRaw).toBeEnabled();
  await allRaw.click();
  await expect.poll(async () => (await state()).jobs.find(job => job.kind === 'page-proofread-batch')?.state).toBe('completed');
  const after = await state();
  const batch = after.jobs.find(job => job.kind === 'page-proofread-batch');
  assert.equal(batch.progress.completed, 2);
  assert.deepEqual(batch.pages.map(entry => entry.state), ['completed', 'completed']);
  assert.deepEqual(after.jobs.filter(job => job.kind === 'page-proofread' && job.payload.mode === 'raw')
    .map(job => job.payload.imageId).sort(), ['fixture-page-0', 'fixture-page-1']);
  assert.deepEqual(errors, []);
  console.log('Chapter Raw proofreading browser check passed.');
} finally { await browser.close(); }
