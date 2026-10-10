/** Run only with scripts/test-browser.mjs: isolated app, no real GPU models. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = process.env.SCAN_TEST_BASEURL;
assert.ok(base, "Use the isolated browser fixture runner");
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache))
    executable =
      readdirSync(cache)
        .filter((name) => name.startsWith("chromium-"))
        .flatMap((name) => [
          join(cache, name, "chrome-linux64/chrome"),
          join(cache, name, "chrome-linux/chrome"),
        ])
        .find(existsSync) || executable;
}

const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
await context.addCookies([
  {
    name: "scan_session",
    value: "fixture-local-session",
    domain: "127.0.0.1",
    path: "/",
  },
]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const api = `${base}/api/episodes/fixture-episode`;
const card = page.locator('#region-card-fixture-line-0-0');
const goTranslate = async () => {
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await page.locator('.pages > button').first().click();
  await card.getByRole('button', { name: /^#\d/ }).click();
};
const savedLine = async () => (await (await context.request.get(`${api}/workflow`)).json()).lines.find(l => l.id === 'fixture-line-0-0');
try {
  const state = await (await context.request.get(`${api}/workflow`)).json();
  // Both displayed pages are approved Korean fixture art, including review crops.
  await page.route('**/api/images/fixture-page-*?*', route => route.fulfill({ path: 'fixtures/manhwa-pages/001.png', contentType: 'image/png' }));
  expect((await context.request.post(`${api}/workflow`, { data: {
    action: 'preferences', scope: 'series', expectedRevision: state.seriesDefaults.revision,
    data: { lang: 'korean', direction: 'ltr' },
  } })).ok()).toBe(true);
  expect((await context.request.patch(`${base}/api/series/fixture-series`, { data: { glossary: [{ source: '민수', translation: 'Min-su' }] } })).ok()).toBe(true);
  const original = await savedLine();
  expect((await context.request.patch(`${api}/lines/${original.id}`, { data: { expectedRevision: original.revision, source: '안녕', sourceState: 'read' } })).ok()).toBe(true);
  await page.route('**/region-ai', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ path: 'fixtures/manhwa-pages/001.png', contentType: 'image/png' });
    const body = route.request().postDataJSON();
    if (body.action === 'detect-mask') return route.fulfill({ json: { mask: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } });
    return route.fulfill({ json: { results: (body.reviewers || []).map(model => ({ model, answer: 'Fixture reading', cards: [] })) } });
  });
  await goTranslate();
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  let panel = card.locator('.korean-entry');
  const choose = async (root, label) => root.getByRole('button', { name: label, exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Insert syllable', exact: true })).toBeDisabled();
  await choose(panel, 'Initial consonant: ㅎ h');
  await choose(panel, 'Vowel: ㅏ a');
  await choose(panel, 'Final consonant: ㄴ n');
  await expect(panel.getByLabel('Syllable preview')).toHaveText('한');
  await panel.getByLabel('Characters', { exact: true }).evaluate(el => { el.focus(); el.setSelectionRange(1, 2); });
  await choose(panel, 'Insert syllable');
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('안한');
  await expect(panel.locator('.source-romaji')).toHaveText('anhan');
  await choose(panel, 'Insert syllable');
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('안한한');
  await choose(panel, 'Backspace');
  await choose(panel, 'Space');
  await choose(panel, 'Newline');
  await choose(panel, '민수');
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('안한 \n민수');
  await choose(panel, 'Cancel');
  expect((await savedLine()).source).toBe('안녕');
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await choose(panel, 'Clear');
  await choose(panel, 'Initial consonant: ㅋ k');
  await choose(panel, 'Insert consonant');
  await choose(panel, 'Insert consonant');
  await choose(panel, 'Vowel: ㅏ a');
  await choose(panel, 'Insert vowel');
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('ㅋㅋㅏ');
  await choose(panel, 'Apply to source');
  await expect.poll(async () => (await savedLine()).source).toBe('ㅋㅋㅏ');
  expect((await savedLine()).body).toBe(original.body);
  await card.getByRole('button', { name: 'Review Transcription', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'AI source review', exact: true });
  await review.getByRole('button', { name: 'Enter characters', exact: true }).click();
  panel = review.locator('.korean-entry');
  await expect(review.getByRole('log', { name: 'Reviewer responses' })).toHaveCount(0);
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('ㅋㅋㅏ');
  await choose(panel, 'Clear');
  await choose(panel, 'Initial consonant: ㄲ kk');
  await choose(panel, 'Vowel: ㅘ wa');
  await choose(panel, 'Final consonant: ㄱ k');
  await expect(panel.getByLabel('Syllable preview')).toHaveText('꽉');
  await choose(panel, 'Insert syllable');
  await choose(panel, 'Apply to source');
  await expect.poll(async () => (await savedLine()).source).toBe('꽉');
  await expect(review.getByRole('log', { name: 'Reviewer responses' })).toBeVisible();
  await review.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await expect(panel.getByLabel('Characters', { exact: true })).toHaveValue('꽉');
  await choose(panel, 'Initial consonant: ㅇ silent');
  await choose(panel, 'Vowel: ㅣ i');
  await choose(panel, 'Final consonant: ㄺ l+g');
  await expect(panel.getByLabel('Syllable preview')).toHaveText('읽');
  mkdirSync('/tmp/scan-acceptance', { recursive: true });
  await review.screenshot({ path: '/tmp/scan-acceptance/korean-character-entry.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Insert syllable', exact: true }).scrollIntoViewIfNeeded();
  await expect(panel.getByRole('button', { name: 'Insert syllable', exact: true })).toBeInViewport();
  await choose(panel, 'Cancel');
  expect((await savedLine()).source).toBe('꽉');
  await review.getByRole('button', { name: 'Close AI dialog' }).click();
  await page.setViewportSize({ width: 1440, height: 1100 });
  // Empty Apply marks the source unreadable and still leaves English intact.
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  panel = card.locator('.korean-entry');
  await choose(panel, 'Clear');
  await choose(panel, 'Apply to source');
  await expect.poll(async () => (await savedLine()).sourceState).toBe('unreadable');
  expect((await savedLine()).body).toBe(original.body);
  // Drafts are discarded when selecting a different region.
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await panel.getByLabel('Characters', { exact: true }).fill('unsaved draft');
  const second = page.locator('#region-card-fixture-line-0-1');
  await second.getByRole('button', { name: /^#2/ }).click();
  await second.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await expect(second.getByLabel('Characters', { exact: true })).not.toHaveValue('unsaved draft');
  await card.getByRole('button', { name: /^#1/ }).click();
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await expect(card.getByLabel('Characters', { exact: true })).toHaveValue('');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  const empty = await savedLine();
  expect((await context.request.patch(`${api}/lines/${empty.id}`, { data: { expectedRevision: empty.revision, sourceState: 'ignored' } })).ok()).toBe(true);
  await goTranslate();
  await expect(card.getByRole('button', { name: 'Enter characters', exact: true })).toBeDisabled();
  const ignored = await savedLine();
  expect((await context.request.patch(`${api}/lines/${ignored.id}`, { data: { expectedRevision: ignored.revision, sourceState: 'unreadable' } })).ok()).toBe(true);
  const latest = await (await context.request.get(`${api}/workflow`)).json();
  expect((await context.request.post(`${api}/workflow`, { data: { action: 'preferences', scope: 'series', expectedRevision: latest.seriesDefaults.revision, data: { lang: 'japanese' } } })).ok()).toBe(true);
  await goTranslate();
  await card.getByRole('button', { name: 'Enter characters', exact: true }).click();
  await expect(card.getByRole('button', { name: 'あ a', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('Korean character entry and Japanese picker regression passed');
} finally { await browser.close(); }
