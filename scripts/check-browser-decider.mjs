import { chromium, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');
const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executable = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executable) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) {
    const candidates = readdirSync(cache)
      .filter((n) => /^chromium-\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((n) => join(cache, n, "chrome-linux64/chrome"));
    executable = candidates.find((p) => existsSync(p)) || executable;
  }
}
const browser = await chromium.launch({
  executablePath: executable,
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1500, height: 1000 },
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
page.on("pageerror", (e) => {
  errors.push(e.message);
  console.error("PAGE ERROR", e.message);
});
try {
  await page.route('**/api/ai/engines', route => route.fulfill({ json: {
    engines: [{ id: 'd1-3b', label: 'Liquid AI d1-3B Q8', group: 'Local models', available: true, operations: ['sourceDecide'] }], rows: [{ id: 'd1-3b', label: 'Liquid AI d1-3B Q8', group: 'Local models', available: true, operations: ['sourceDecide'] }],
    transcriptionModels: [], defaultTranscriptionDecider: 'd1-3b',
  } }));
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  const open = async () => {
    await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
    await page.locator('.pages > button').first().click();
    await page.getByRole('button', { name: 'AI model settings…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI model settings', exact: true });
    await dialog.getByRole('tab', { name: 'Transcription', exact: true }).click();
    return dialog;
  };
  let dialog = await open();
  const choice = dialog.getByLabel('Transcription decider', { exact: true });
  await expect(choice).toHaveValue('default');
  await choice.selectOption('off');
  await dialog.getByLabel('Minimum probability', { exact: true }).fill('0.85');
  await dialog.getByLabel('Minimum lead', { exact: true }).fill('0.20');
  await dialog.locator('button.save').first().click();
  await expect(dialog).toBeHidden();
  const api = `${base}/api/episodes/fixture-episode/workflow`;
  let state = await (await context.request.get(api)).json();
  expect(state.preferences.regionAi.transcriptionDecider).toBeNull();
  expect(state.preferences.regionAi.deciderMinProbability).toBe(0.85);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  dialog = await open();
  await expect(dialog.getByLabel('Transcription decider', { exact: true })).toHaveValue('off');
  await dialog.getByLabel('Transcription decider', { exact: true }).selectOption('d1-3b');
  await dialog.locator('button.save').first().click();
  await expect(dialog).toBeHidden();
  state = await (await context.request.get(api)).json();
  expect(state.preferences.regionAi.transcriptionDecider).toEqual({ engine: 'd1-3b', model: '' });
  dialog = await open();
  await dialog.getByLabel('Transcription decider', { exact: true }).selectOption('default');
  await dialog.locator('button.save').first().click();
  await expect(dialog).toBeHidden();
  state = await (await context.request.get(api)).json();
  expect(Object.hasOwn(state.preferences.regionAi, 'transcriptionDecider')).toBe(false);

  // Seed saved decision evidence directly into this isolated fixture database.
  const env = JSON.parse(readFileSync('/tmp/scan-browser-env.json', 'utf8'));
  const db = new Database(env.db);
  const line = state.lines.find(l => l.id === 'fixture-line-0-0');
  const id = `region:${line.id}`;
  const existing = db.prepare('SELECT data FROM workflow_docs WHERE id=?').get(id);
  const data = existing ? JSON.parse(existing.data) : {};
  data.sourceDecision = { modelId: 'd1-3b', modelName: 'Liquid AI d1-3B Q8', at: Date.now(), cropHash: 'fixture',
    candidates: [{ id: 'A', source: '待って' }, { id: 'B', source: '持って' }], choice: 'none',
    probabilities: { A: .05, B: .05, none: .85, unclear: .05 }, confidence: .85, margin: .8,
    minProbability: .8, minMargin: .15, status: 'abstained', applied: false, sourceRevision: line.revision,
    bounds: JSON.stringify([line.imageId, line.x, line.y, line.w, line.h]) };
  db.prepare(`INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,1,?,'[]','[]',?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=revision+1`).run(id, 'fixture-episode', JSON.stringify(data), Date.now());
  db.close();
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Translate', exact: true }).click();
  await page.locator('.pages > button').first().click();
  const evidence = page.locator(`#region-card-${line.id} .decider-result`);
  await expect(evidence).toContainText('needs review');
  await evidence.locator('summary').click();
  await expect(evidence).toContainText('None match');
  await expect(evidence).toContainText('85.0%');
  expect(errors).toEqual([]);
  console.log('Decider settings persistence and saved abstention evidence passed');
} finally { await browser.close(); }
