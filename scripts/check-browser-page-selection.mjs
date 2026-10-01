import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, 'Run through the isolated browser fixture runner');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = join(homedir(), '.cache/ms-playwright');
  executablePath = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome')).find(path => existsSync(path)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = `${base}/api/episodes/fixture-episode`;
  const state = async (episode = 'fixture-episode') => (await context.request.get(`${base}/api/episodes/${episode}/workflow`)).json();
  const initial = await state();
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  const sidebar = page.getByRole('complementary', { name: 'Pages in chapter order' });
  const grid = page.locator('.organize');
  const actions = page.getByRole('region', { name: 'Selected page actions' });
  await expect(grid.getByRole('checkbox')).toHaveCount(2);
  await expect(actions).toBeHidden();
  await grid.getByRole('checkbox', { name: 'Select page 1', exact: true }).check();
  await expect(actions).toContainText('1 selected');
  await grid.getByRole('checkbox', { name: 'Select page 2', exact: true }).click({ modifiers: ['Shift'] });
  await expect(actions).toContainText('2 selected');
  await expect(grid.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await grid.getByRole('button', { name: 'Open page 1', exact: true }).click();
  await page.getByRole('button', { name: 'Organize', exact: true }).click();
  await expect(actions).toContainText('2 selected');
  await actions.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(actions).toBeHidden();
  await grid.getByRole('button', { name: 'Open page 1', exact: true }).click({ modifiers: ['Control'] });
  await grid.getByRole('button', { name: 'Open page 2', exact: true }).click({ modifiers: ['Shift'] });
  await expect(grid.getByRole('checkbox', { checked: true })).toHaveCount(2);
  // Cancel extraction: no chapter is created and selection remains.
  page.once('dialog', dialog => { assert.equal(dialog.type(), 'prompt'); return dialog.dismiss(); });
  await actions.getByRole('button', { name: 'Extract to chapter…', exact: true }).click();
  await expect(actions).toContainText('2 selected');
  page.once('dialog', dialog => dialog.accept('12.5'));
  const extractedResponse = page.waitForResponse(r => r.url() === `${api}/pages` && r.request().method() === 'POST');
  await actions.getByRole('button', { name: 'Extract to chapter…', exact: true }).click();
  const extracted = await extractedResponse;
  assert.equal(extracted.status(), 201);
  const chapter = (await extracted.json()).chapter;
  await expect(page.getByRole('link', { name: 'Open chapter 12.5', exact: true })).toBeVisible();
  await expect(grid.getByRole('checkbox', { checked: true })).toHaveCount(0);
  assert.equal((await state()).images.length, 2);
  const copy = await state(chapter.id);
  assert.equal(copy.images.length, 2);
  assert.equal(copy.lines.length, initial.lines.length);
  assert.deepEqual(copy.images.map(p => p.pageNumber), [1, 2]);
  // Duplicate destination reports an error without losing the selection.
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  page.once('dialog', dialog => dialog.accept('12.5'));
  await actions.getByRole('button', { name: 'Extract to chapter…', exact: true }).click();
  await expect(page.getByText('Error: Chapter "12.5" already exists. Choose a different chapter number.', { exact: true })).toBeVisible();
  await expect(actions).toContainText('2 selected');
  // Preparing UI hides selection in other steps and restores it on return.
  const workflow = page.getByRole('navigation', { name: 'Chapter workflow' });
  await workflow.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(page.locator('.organize').getByRole('checkbox')).toHaveCount(0);
  await workflow.getByRole('button', { name: 'Prepare', exact: true }).click();
  await expect(page.locator('.organize').getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(page.locator('.ed-options')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nudge left', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nudge right', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nudge up', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nudge down', exact: true })).toBeVisible();
  await expect(page.getByLabel('Nudge pixels', { exact: true })).toHaveValue('10');
  mkdirSync('/tmp/scan-acceptance', { recursive: true });
  assert.equal(await actions.locator('strong').evaluate(el => {
    const rect = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), true, 'the selected count must remain readable beside the tools palette');
  await page.screenshot({ path: '/tmp/scan-acceptance/page-selection.png' });
  // Cancelling deletion leaves both chapters intact.
  page.once('dialog', dialog => { assert.equal(dialog.type(), 'confirm'); return dialog.dismiss(); });
  await actions.getByRole('button', { name: 'Delete selected pages…', exact: true }).click();
  assert.equal((await state()).images.length, 2);
  page.once('dialog', dialog => dialog.accept());
  await actions.getByRole('button', { name: 'Delete selected pages…', exact: true }).click();
  await expect(page.locator('.organize').getByRole('checkbox')).toHaveCount(0);
  await expect(actions).toBeHidden();
  assert.equal((await state()).lines.length, 0);
  assert.equal((await state(chapter.id)).lines.length, copy.lines.length);
  // Real navigation reaches the extracted chapter after the original pages are gone.
  await page.getByRole('link', { name: 'Open chapter 12.5', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/episodes/${chapter.id}$`));
  await expect(page.locator('.organize').getByRole('checkbox')).toHaveCount(2);
  for (const img of await sidebar.locator('img').all()) await expect(img).toHaveJSProperty('naturalWidth', 800);
  // Server enforces chapter access and upload permission for both operations.
  const env = JSON.parse(readFileSync('/tmp/scan-browser-env.json', 'utf8'));
  const fixtureDb = new Database(env.db);
  fixtureDb.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('reader','reader','unused','proofreader',1)").run();
  fixtureDb.prepare("INSERT INTO sessions(id,user_id,expires_at) VALUES('reader-session','reader',?)").run(Date.now() + 86400000);
  fixtureDb.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('fixture-series','reader',1)").run();
  const reader = await browser.newContext();
  await reader.addCookies([{ name: 'scan_session', value: 'reader-session', url: base }]);
  const readerPage = await reader.newPage();
  await readerPage.goto(`${base}/series/fixture-series`);
  for (const op of ['delete', 'extract']) {
    const response = await readerPage.request.post(`${base}/api/episodes/${chapter.id}/pages`, { data: {
      op, imageIds: copy.images.map(p => p.id), chapterNumber: '99',
    } });
    assert.equal(response.status(), 403);
  }
  fixtureDb.prepare("UPDATE users SET role='translator' WHERE id='reader'").run();
  fixtureDb.prepare("DELETE FROM series_members WHERE user_id='reader'").run();
  const forbidden = await readerPage.request.post(`${base}/api/episodes/${chapter.id}/pages`, { data: {
    op: 'extract', imageIds: copy.images.map(p => p.id), chapterNumber: '99',
  } });
  assert.equal(forbidden.status(), 403);
  fixtureDb.close();
  assert.deepEqual(errors, []);
  console.log('Page selection browser checks passed: range/additive selection, prompts, extraction, conflicts, deletion and permissions.');
} finally { await browser.close(); }
