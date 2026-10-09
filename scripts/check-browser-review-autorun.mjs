/** Run through scripts/test-browser.mjs; model responses are stubbed. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, 'Run through the isolated browser fixture runner');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(name => /^chromium-\d+$/.test(name))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(name => join(cache, name, 'chrome-linux64/chrome'))
    .find(path => existsSync(path)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  for (const id of ['codex', 'cursor']) {
    expect((await context.request.post(`${base}/api/admin/cli-tools`, { data: {
      action: 'save', id, executable: process.execPath,
    } })).ok()).toBeTruthy();
  }
  const api = `${base}/api/episodes/fixture-episode/workflow`;
  const before = await (await context.request.get(api)).json();
  const council = [{ engine: 'gpt-5.4', model: '' }, { engine: 'composer-2.5', model: '' }];
  const preferences = await context.request.post(api, { data: {
    action: 'preferences', scope: 'series', expectedRevision: before.seriesDefaults.revision,
    data: { regionAi: { ...before.preferences.regionAi,
      ...Object.fromEntries(['translate', 'vision', 'describe', 'proofread', 'enquire']
        .map(task => [task, { engine: 'qwen3.8-27b-q4', model: '' }])),
      reviewers: council, reviseModels: council,
    } },
  } });
  expect(preferences.ok(), await preferences.text()).toBeTruthy();

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const calls = [];
  let maskRelease;
  await page.route('**/api/episodes/fixture-episode/region-ai', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === 'detect-mask') {
      if (maskRelease) await maskRelease.promise;
      return route.fulfill({ json: { mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } });
    }
    if (body.action === 'review') return route.fulfill({ json: {
      results: [{ model: body.reviewers[0], answer: `Review from ${body.reviewers[0].engine}`, cards: [] }],
    } });
    if (body.action === 'revise') return route.fulfill({ json: {
      label: body.model.engine, answer: `Translation from ${body.model.engine}`, cards: [],
    } });
    throw new Error(`Unexpected AI action: ${body.action}`);
  });
  const setAutoRun = async on => {
    await page.goto(`${base}/admin/models/list`);
    const row = page.locator('tr.m-row').filter({ has: page.getByText('GPT-5.4', { exact: true }) });
    await row.getByText('GPT-5.4', { exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'GPT-5.4', exact: true });
    const toggle = drawer.getByRole('checkbox', { name: 'Autorun reviews' });
    await expect(toggle).toBeChecked({ checked: !on });
    await drawer.locator('label.switch').filter({ has: page.getByRole('checkbox', { name: 'Autorun reviews' }) }).click();
    await expect(toggle).toBeChecked({ checked: on });
    await expect(toggle).toBeEnabled();
    await page.reload();
    await row.getByText('GPT-5.4', { exact: true }).click();
    await expect(toggle).toBeChecked({ checked: on });
    const engines = await (await context.request.get(`${base}/api/ai/engines`)).json();
    expect(engines.engines.find(model => model.id === 'gpt-5.4').autoRun).toBe(on);
  };
  const card = page.locator('#region-card-fixture-line-0-0');
  const openChapter = async () => {
    await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
    await page.waitForFunction(() => document.body.dataset.studioReady === '1');
    await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
    await page.locator('.pages > button').first().click();
    await card.getByRole('button', { name: /^#\d/ }).click();
  };
  await setAutoRun(true);
  await openChapter();
  let release;
  maskRelease = { promise: new Promise(resolve => { release = resolve; }) };
  await card.getByRole('button', { name: 'Review Transcription', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'AI source review', exact: true });
  await expect.poll(() => calls.filter(call => call.action === 'detect-mask').length).toBe(1);
  expect(calls.filter(call => call.action === 'review')).toEqual([]);
  release();
  maskRelease = undefined;
  await expect(review.getByText('Review from gpt-5.4', { exact: true })).toBeVisible();
  let reviews = calls.filter(call => call.action === 'review');
  expect(reviews.map(call => call.reviewers[0].engine)).toEqual(['gpt-5.4']);
  expect(reviews[0].selectedReviewer).toBeUndefined();
  expect(reviews[0].maskEnabled).toBe(true);
  await expect(review.getByRole('button', { name: 'Run GPT-5.4 again', exact: true })).toBeEnabled();
  await review.getByRole('button', { name: 'Run Composer 2.5', exact: true }).click();
  await expect(review.getByText('Review from composer-2.5', { exact: true })).toBeVisible();
  reviews = calls.filter(call => call.action === 'review');
  expect(reviews.at(-1).selectedReviewer).toEqual(council[1]);
  await review.getByRole('button', { name: 'Close AI dialog' }).click();

  await card.getByRole('button', { name: 'Review Translation', exact: true }).click();
  const revise = page.getByRole('dialog', { name: 'Review Translation translation', exact: true });
  await expect.poll(() => calls.filter(call => call.action === 'revise').length).toBe(1);
  let revisions = calls.filter(call => call.action === 'revise');
  expect(revisions[0].model).toEqual(council[0]);
  expect(revisions[0].selected).toBeUndefined();
  await expect(revise.getByRole('button', { name: 'Run GPT-5.4 again', exact: true })).toBeEnabled();
  await revise.getByRole('button', { name: 'Run Composer 2.5', exact: true }).click();
  await expect.poll(() => calls.filter(call => call.action === 'revise').length).toBe(2);
  revisions = calls.filter(call => call.action === 'revise');
  expect(revisions[1].model).toEqual(council[1]);
  expect(revisions[1].selected).toBe(true);
  await revise.getByRole('button', { name: 'Close revise English dialog' }).click();

  await setAutoRun(false);
  await openChapter();
  calls.length = 0;
  await card.getByRole('button', { name: 'Review Transcription', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Run GPT-5.4', exact: true })).toBeEnabled();
  await expect(review.getByRole('button', { name: 'Run Composer 2.5', exact: true })).toBeEnabled();
  expect(calls.filter(call => call.action === 'review')).toEqual([]);
  await review.getByRole('button', { name: 'Close AI dialog' }).click();
  await card.getByRole('button', { name: 'Review Translation', exact: true }).click();
  await expect(revise.getByRole('button', { name: 'Run GPT-5.4', exact: true })).toBeEnabled();
  await expect(revise.getByRole('button', { name: 'Run Composer 2.5', exact: true })).toBeEnabled();
  expect(calls.filter(call => call.action === 'revise')).toEqual([]);
  expect(errors).toEqual([]);
  console.log('Review Autorun passed: admin card saves across reload, only opted-in council models run, transcription waits for the mask, manual Run remains available, and disabling restores manual starts.');
} finally {
  await browser.close();
}
