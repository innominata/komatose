// The page proofreader's follow-up box stays editable while a reply is coming;
// only sending waits. A question written while a follow-up runs survives its reply.
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
  executablePath = (existsSync(cache) ? readdirSync(cache) : []).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(path => existsSync(path))
    || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : executablePath);
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const api = `${base}/api/episodes/fixture-episode`;
  const state = async () => (await context.request.get(`${api}/workflow`)).json();
  const before = await state();
  assert.ok((await context.request.post(`${api}/workflow`, { data: {
    action: 'preferences', expectedRevision: before.chapter.revision,
    data: { regionAi: { ...Object.fromEntries(['translate', 'describe', 'vision', 'proofread', 'enquire']
      .map(task => [task, { engine: 'qwen', model: 'proofreader-fixture' }])), reviewers: [] } },
  } })).ok());

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Record, at every DOM change, whether the box was ever disabled while a reply was pending.
  await page.addInitScript(() => {
    const seen = { pending: 0, lockedWhilePending: 0 };
    Object.defineProperty(window, '__compose', { value: seen });
    new MutationObserver(() => {
      const box = document.getElementById('page-proofread-followup');
      const status = box?.closest('[role="dialog"]')?.querySelector('[role="status"]');
      if (!box || !status) return;
      seen.pending++;
      if (box.disabled) seen.lockedWhilePending++;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.locator('.pages > button').first().click();
  await page.locator('[data-find="more-review"]').click();
  await page.getByRole('menuitem', { name: 'Page proofreader', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Page proofreader', exact: true });
  const box = dialog.getByRole('textbox', { name: 'Follow-up', exact: true });
  await expect(box).toBeEditable();
  await expect.poll(async () => (await state()).jobs.find(j => j.kind === 'page-proofread')?.state).toBe('completed');
  const first = (await state()).jobs.find(j => j.kind === 'page-proofread');

  await box.fill('Check the SFX in panel 2.');
  await dialog.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  const followDialog = page.getByRole('dialog', { name: 'Proofreader follow-up', exact: true });
  const next = followDialog.getByRole('textbox', { name: 'Follow-up', exact: true });
  await expect(next).toHaveValue('');
  await expect(next).toBeEditable();
  await next.fill('And the caption in panel 3?');
  await expect.poll(async () => (await state()).jobs.find(j => j.payload?.followUpOf === first.id)?.state).toBe('completed');
  await expect(followDialog.locator('.critique')).not.toBeEmpty();
  await expect(next).toHaveValue('And the caption in panel 3?');
  await expect(followDialog.getByRole('button', { name: 'Send follow-up', exact: true })).toBeEnabled();

  const seen = await page.evaluate(() => window.__compose);
  assert.ok(seen.pending > 0, 'saw the dialog while a reply was pending');
  assert.equal(seen.lockedWhilePending, 0, 'follow-up box was never disabled while a reply was pending');
  assert.deepEqual(errors, []);
  console.log('Proofreader follow-up compose check passed.');
} finally { await browser.close(); }
