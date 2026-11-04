import Database from 'better-sqlite3';
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
  // The real transcription worker is deliberately not invoked: keep its job active
  // to verify both controls and the raw proofreading API allow concurrency.
  const db = new Database(join(process.env.SCAN_TEST_DATA, 'scan.db'));
  db.prepare("INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at) VALUES('concurrent-transcription','fixture-episode','transcribe','running','{}','{}',?,?)").run(Date.now(),Date.now());
  db.close();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Proofread Raw', exact: true })).toBeEnabled();
  await page.getByRole('group', { name: 'Run on' }).getByRole('button', { name: 'Whole chapter', exact: true }).click();
  const allRaw = page.getByRole('button', { name: 'Proofread All Raw', exact: true });
  await expect(allRaw).toBeEnabled();
  await allRaw.click();
  await expect.poll(async () => (await state()).jobs.find(job => job.kind === 'page-proofread-batch')?.state).toBe('completed');
  const after = await state();
  const batch = after.jobs.find(job => job.kind === 'page-proofread-batch');
  assert.equal(batch.progress.completed, 2);
  assert.equal(after.jobs.find(job => job.id === 'concurrent-transcription')?.state, 'running', 'raw proofreading did not cancel transcription');
  assert.deepEqual(batch.pages.map(entry => entry.state), ['completed', 'completed']);
  assert.deepEqual(after.jobs.filter(job => job.kind === 'page-proofread' && job.payload.mode === 'raw')
    .map(job => job.payload.imageId).sort(), ['fixture-page-0', 'fixture-page-1']);
  // Each step's Replies tab opens a saved reply docked left at full height and
  // returns the inspector to its first tab.
  await page.getByRole('group', { name: 'Run on' }).getByRole('button', { name: /^Page \d+$/ }).click();
  await expect(page.getByRole('button', { name: 'Proofread Raw', exact: true })).toBeEnabled();
  const tabs = page.getByRole('tablist', { name: 'Inspector' });
  for (const [step, first] of [['Translate', /^Regions/], ['Review', /^To review/]]) {
    await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: step, exact: true }).click();
    await tabs.getByRole('tab', { name: /^Replies/ }).click();
    await page.locator('.proofread-reply').first().click();
    const win = page.getByRole('dialog', { name: /proofreader reply$/ });
    await expect(win).toBeVisible();
    const box = await win.boundingBox();
    assert.equal(Math.round(box.x), 0, `${step} reply window is docked left`);
    assert.equal(Math.round(box.y), 0, `${step} reply window starts at the top`);
    assert.ok(Math.abs(box.height - 1000) <= 1, `${step} reply window is full height (${box.height})`);
    assert.ok(Math.abs(box.width - 620) <= 1, `${step} reply window keeps its width (${box.width})`);
    await expect(tabs.getByRole('tab', { name: first })).toHaveAttribute('aria-selected', 'true');
    await win.getByRole('button', { name: 'Close saved reply' }).click();
  }
  assert.deepEqual(errors, []);
  console.log('Chapter Raw proofreading browser check passed.');
} finally { await browser.close(); }
