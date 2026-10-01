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
const CHAT = ["translate", "vision", "describe", "proofreadEnglish", "chapterReview", "advisory", "compactNotes", "alternatives", "pageImageProofread"];
const row = (id, label, group, operations, extra = {}) => ({
  id, label, available: extra.available !== false, group, operations, access: extra.access,
});
const local = [
  { id: 'hayai-ocr-v2', label: 'Hayai OCR v2' },
  { id: 'paddleocr-vl-1.6', label: 'PaddleOCR-VL-1.6' },
  { id: 'qwen3-vl-8b', label: 'Qwen3-VL' },
];
const engines = [
  row("qwen3.8-27b-q4", "Qwen 3.8 27B", "Local models", CHAT),
  row("qwen3-vl-8b", "Qwen3-VL", "Local models", ["describe", "vision", "advisory"]),
  row("hayai-ocr-v2", "Hayai OCR v2", "Local models", ["vision"]),
  row("paddleocr-vl-1.6", "PaddleOCR-VL-1.6", "Local models", ["vision"]),
  row("composer-2.5", "Composer 2.5", "CLI agents", CHAT, { access: "cli" }),
];
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
  const page = await context.newPage();
  if (process.env.SCAN_TEST_EXPECT_LOCAL_REVIEW_MODELS === '1') {
    const response = await context.request.get(`${base}/api/ai/engines`);
    expect(response.ok()).toBe(true);
    const discovered = await response.json();
    expect(discovered.localReviewModels.map(model => model.id)).toEqual(local.map(model => model.id));
    expect(discovered.sourceReviewEngines.some(engine => engine.id === 'qwen3.8-27b-q4')).toBe(true);
    for (const model of local) expect(discovered.sourceReviewEngines.some(engine => engine.id === model.id)).toBe(true);
  }
  await page.route('**/api/ai/engines', route => route.fulfill({ json: {
    engines, rows: engines,
    localReviewModels: local,
    sourceReviewEngines: engines,
    transcriptionModels: engines.filter(item => item.operations.includes('vision')),
  } }));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' })
    .getByRole('button', { name: 'Translate', exact: true }).click();
  await page.locator('.pages > button').first().click();
  await page.getByRole('button', { name: 'AI model settings…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI model settings', exact: true });
  await dialog.getByRole('tab', { name: 'Reviewers', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add local OCR reviewers' }).click();
  for (let i = 0; i < local.length; i++) {
    await expect(dialog.getByLabel(`Reviewer ${i + 1}`, { exact: true })).toHaveValue(local[i].id);
  }
  await expect(dialog.getByRole('button', { name: 'Add local OCR reviewers' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Add reviewer', exact: true }).click();
  await dialog.getByLabel('Reviewer 4', { exact: true }).selectOption('qwen3.8-27b-q4');
  await dialog.getByRole('button', { name: 'Add reviewer', exact: true }).click();
  await dialog.getByLabel('Reviewer 5', { exact: true }).selectOption('composer-2.5');
  await expect(dialog.getByRole('button', { name: 'Add reviewer', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(dialog).toBeHidden();
  const result = await (await context.request.get(`${base}/api/episodes/fixture-episode/workflow`)).json();
  expect(result.preferences.regionAi.reviewers.map(model => model.engine))
    .toEqual([...local.map(model => model.id), 'qwen3.8-27b-q4', 'composer-2.5']);
  console.log('Local OCR reviewer browser checks passed: discovery, CPU availability, five model comparison, and persisted choices.');
} finally { await browser.close(); }
