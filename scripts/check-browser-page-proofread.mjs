import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
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
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let submissions = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/page-proofread')) submissions++; });
  const api = `${base}/api/episodes/fixture-episode`;
  const state = async () => (await context.request.get(`${api}/workflow`)).json();
  let saved = await state();
  const preferences = await context.request.post(`${api}/workflow`, { data: {
    action: 'preferences', expectedRevision: saved.chapter.revision,
    data: { regionAi: { ...Object.fromEntries(['translate', 'describe', 'vision', 'proofread', 'enquire']
      .map(task => [task, { engine: 'qwen', model: 'proofreader-fixture' }])), reviewers: [] } },
  } });
  assert.ok(preferences.ok());
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await page.locator('.pages > button').first().click();
  await page.locator('#region-card-fixture-line-0-0').getByRole('button', { name: /^#\d/ }).click();
  await expect(page.locator('.region-missing')).toHaveCount(0);
  const missingCard = page.locator('#region-card-fixture-line-0-0');
  const sourceBox = missingCard.getByLabel('Japanese source');
  const englishBox = missingCard.getByLabel('English', { exact: true });
  const originalSource = await sourceBox.inputValue();
  const originalEnglish = await englishBox.inputValue();
  await sourceBox.fill('');
  await expect(page.getByRole('button', { name: /^Region 1, .+, No source text$/ })).toBeVisible();
  await expect(page.locator('.region-missing title')).toHaveText('No source text');
  await englishBox.fill('');
  await expect(page.getByRole('button', { name: /^Region 1, .+, No source or English text$/ })).toBeVisible();
  await expect(page.locator('.region-missing')).toHaveCount(2);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(page.locator('.region-missing')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Review', exact: true }).click();
  await expect(page.locator('.region-missing')).toHaveCount(2);
  await sourceBox.fill(originalSource);
  await englishBox.fill(originalEnglish);
  await expect(page.locator('.region-missing')).toHaveCount(0);
  for (const [label, variant] of [['Copy raw image', 'raw'], ['Copy typeset image', 'typeset']]) {
    const response = page.waitForResponse(r => r.url().includes(`/review-image?variant=${variant}`));
    await page.getByRole('button', { name: label, exact: true }).click();
    assert.ok((await response).ok());
    await expect(page.getByText(`${variant === 'raw' ? 'Raw' : 'Typeset'} page image copied.`, { exact: true })).toBeVisible();
    const dimensions = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      const image = await createImageBitmap(blob);
      return [image.width, image.height];
    });
    assert.deepEqual(dimensions, [800, 1100]);
  }
  await page.getByRole('button', { name: 'Proofread raw + typeset images', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Page proofreader', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Follow-up', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send follow-up', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close proofreader' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await state()).jobs.find(j => j.kind === 'page-proofread')?.state).toBe('completed');
  saved = await state();
  const job = saved.jobs.find(j => j.kind === 'page-proofread');
  assert.match(job.progress.critique, /Panel 1/);
  assert.equal(job.payload.model, 'proofreader-fixture');
  assert.equal(job.progress.log.filter(entry => entry.response).length, 1);
  // Reopening must work after a full reload, with the response loaded from the database.
  await page.reload();
  const jobsToggle = page.getByRole('button', { name: /Jobs & downloads/ });
  if (await jobsToggle.getAttribute('aria-expanded') === 'true') await jobsToggle.click();
  await expect(jobsToggle).toHaveAttribute('aria-expanded', 'false');
  const headerCritique = page.getByRole('button', { name: 'Open critique', exact: true }).first();
  await expect(headerCritique).toBeVisible();
  await headerCritique.click();
  await expect(dialog.locator('.critique')).toContainText('Panel 1, upper right');
  await expect(dialog.getByRole('textbox', { name: 'Follow-up', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send follow-up', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Attach working draft', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Attach raw source', exact: true })).toBeEnabled();
  const submitted = dialog.getByText(/Images submitted/);
  await expect(submitted).toBeVisible();
  await expect(dialog.getByAltText('Raw page submitted to the proofreader')).toBeHidden();
  await submitted.click();
  await expect(dialog.getByAltText('Raw page submitted to the proofreader')).toBeVisible();
  await expect(dialog.getByAltText('Raw page submitted to the proofreader')).toHaveJSProperty('naturalWidth', 800);
  await expect(dialog.getByAltText('Typeset page submitted to the proofreader')).toHaveJSProperty('naturalWidth', 800);
  mkdirSync('/tmp/scan-acceptance', { recursive: true });
  await page.screenshot({ path: '/tmp/scan-acceptance/page-proofreader.png' });
  await dialog.getByRole('button', { name: 'Close proofreader' }).click();
  // Editing while the report is closed must not change the captured critique or images.
  const line = (await state()).lines[0];
  const edited = await context.request.patch(`${api}/lines/${line.id}`, { data: {
    expectedRevision: line.revision, body: 'My revised English.',
  } });
  assert.ok(edited.ok());
  await page.getByRole('button', { name: 'Open critique', exact: true }).first().click();
  await expect(dialog.locator('.critique')).toContainText('Panel 1, upper right');
  await dialog.getByRole('textbox', { name: 'Follow-up', exact: true }).fill('Check the SFX in panel 2.');
  await expect(dialog.getByRole('button', { name: 'Send follow-up', exact: true })).toBeEnabled();
  const typesetAttach = page.waitForResponse(r => r.url().includes('/review-image?variant=typeset') && r.request().method() === 'GET');
  await dialog.getByRole('button', { name: 'Attach working draft', exact: true }).click();
  assert.ok((await typesetAttach).ok());
  await expect(dialog.getByAltText('Working draft')).toBeVisible();
  const followUp = page.waitForResponse(r => r.url().endsWith('/page-proofread') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Send follow-up', exact: true }).click();
  assert.ok((await followUp).ok());
  await expect.poll(async () => (await state()).jobs.filter(j => j.kind === 'page-proofread').length).toBe(2);
  const child = (await state()).jobs.find(j => j.payload?.followUpOf === job.id);
  assert.equal(child?.progress?.prompt, 'Check the SFX in panel 2.');
  await expect.poll(async () => (await state()).jobs.find(j => j.payload?.followUpOf === job.id)?.progress?.snapshot?.followUpImages?.length).toBe(1);
  await expect.poll(async () => (await state()).jobs.find(j => j.id === child.id)?.state).toBe('completed');
  await expect(page.getByRole('dialog', { name: 'Proofreader follow-up', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Proofreader follow-up' })).toContainText('Panel 2 SFX');
  const revisited = (await state()).jobs.find(j => j.id === job.id);
  assert.deepEqual(revisited.progress.snapshot, job.progress.snapshot);
  assert.equal(submissions, 2);
  const noAccess = await context.request.get(`${base}/api/episodes/fixture-episode/images/not-a-page/review-image`);
  assert.equal(noAccess.status(), 404);
  assert.deepEqual(errors, []);
  console.log('Page image browser checks passed: two PNG clipboard actions, both images sent, close/reload/reopen saved critique, and manual editing without rerunning.');
} finally { await browser.close(); }
