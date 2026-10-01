import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCAN_TEST_BASEURL;
if (!base) throw new Error('Run through scripts/test-browser.mjs for an isolated fixture');
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath)) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache/ms-playwright');
  executablePath = readdirSync(cache).filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, 'chrome-linux64/chrome')).find(existsSync) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: 'scan_session', value: 'fixture-local-session', domain: '127.0.0.1', path: '/' }]);
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const url = `${base}/api/episodes/fixture-episode/workflow`;
const state = async () => (await context.request.get(url)).json();
async function operation(data) {
  const response = await context.request.post(url, { data });
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBeTruthy();
  return result;
}
try {
  const upload = await context.request.post(url, { multipart: {
    font: { name: 'FreeSans.ttf', mimeType: 'font/ttf', buffer: readFileSync('/usr/share/fonts/gnu-free/FreeSans.ttf') },
  } });
  expect(upload.ok()).toBeTruthy();
  const initial = await state();
  const fontId = initial.fonts.find(f => f.familyName === 'FreeSans').id;
  await operation({ action: 'preferences', scope: 'series', expectedRevision: initial.seriesDefaults.revision,
    data: { styles: { '""': { fontId, size: 16 }, '::': { fontId, size: 8, rotation: 12 } } } });
  const id = 'fixture-line-0-0';
  const originalPolygon = [{ x: .65, y: .08 }, { x: .92, y: .08 }, { x: .8, y: .27 }];
  await operation({ action: 'region', id, expectedRevision: initial.regions[id].revision,
    data: { style: { size: 24, rotation: 30 }, polygon: originalPolygon } });
  await operation({ action: 'prepare', imageId: 'fixture-page-0' });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode`);
  await expect(page.getByRole('button', { name: 'Rebuild and restart', exact: true })).toBeVisible();
  await page.locator('.pages > button').first().click();
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await page.getByRole('tab', { name: 'Shape & mask', exact: true }).click();
  await expect(page.getByRole('button', { name: /Fit bubble/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve geometry', exact: true })).toBeVisible();
  const tools = page.getByRole('toolbar', { name: 'Tools' });
  await expect(tools.getByRole('button', { name: 'Draw polygon', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Draw rectangle', exact: true })).toBeVisible();
  await expect(tools.getByRole('button', { name: 'Draw oval', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  const type = page.getByLabel('Region type', { exact: true }).first();
  await expect(type.getByRole('option', { name: 'Note', exact: true })).toHaveCount(1);
  await type.selectOption('::');
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await expect(page.getByLabel('Default size (pt)', { exact: true })).toHaveValue('8');
  await expect.poll(async () => (await state()).regions[id].data.layout?.style.rotation).toBe(12);
  let current = await state();
  expect(current.lines.find(l => l.id === id).lineType).toBe('::');
  expect(current.regions[id].data.style.size).toBeUndefined();
  expect(current.regions[id].data.layout.style.size).toBe(8);
  expect(current.regions[id].data.polygon).toEqual(originalPolygon);
  await page.getByRole('tab', { name: 'Text', exact: true }).click();
  await expect(type).toBeEnabled();
  await type.selectOption('""');
  await expect.poll(async () => (await state()).regions[id].data.layout?.style.size).toBe(16);

  for (const name of ['Review', 'Translate']) {
    await page.getByRole('navigation', { name: 'Chapter workflow' })
      .getByRole('button', { name, exact: true }).click();
    await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
    const stepType = page.getByRole('group', { name: /Bilingual region 1/ }).getByLabel('Region type', { exact: true });
    await stepType.selectOption('::');
    await expect.poll(async () => (await state()).regions[id].data.layout?.style.size).toBe(8);
    expect((await state()).regions[id].data.style?.size).toBeUndefined();
    await stepType.selectOption('""');
    await expect.poll(async () => (await state()).regions[id].data.layout?.style.size).toBe(16);
  }
  await page.getByRole('navigation', { name: 'Chapter workflow' })
    .getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.getByRole('button', { name: /^Region 1(,.*)?$/ }).click();
  await expect(type).toHaveValue('""');
  current = await state();
  const beforeLayoutKey = current.regions[id].data.layout?.key;
  const rectangle = page.getByRole('button', { name: 'Set polygon to region bounds', exact: true });
  await expect(rectangle).toBeEnabled();
  await rectangle.click();
  current = await state();
  const line = current.lines.find(l => l.id === id);
  const bounds = [{ x: line.x, y: line.y }, { x: line.x + line.w, y: line.y },
    { x: line.x + line.w, y: line.y + line.h }, { x: line.x, y: line.y + line.h }];
  await expect.poll(async () => (await state()).regions[id].data.polygon).toEqual(bounds);
  await expect.poll(async () => (await state()).regions[id].data.layout?.key).not.toBe(beforeLayoutKey);
  await expect(rectangle).toBeEnabled();
  current = await state();
  expect(current.regions[id].data.geometryApproved).toBe(true);
  expect(current.regions[id].data.layout).toBeTruthy();

  const svg = page.locator('.canvas-page svg');
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  if (!box) throw new Error('page canvas is not visible');
  async function drawBox(name, x0, y0, x1, y1) {
    const before = (await state()).regions[id].data.layout?.key;
    await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true }).click();
    await page.mouse.move(box.x + box.width * x0, box.y + box.height * y0);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await state()).regions[id].data.layout?.key).not.toBe(before);
  }
  await drawBox('Draw rectangle', 0.16, 0.14, 0.38, 0.32);
  expect((await state()).regions[id].data.polygon).toHaveLength(4);
  await drawBox('Draw oval', 0.18, 0.16, 0.36, 0.34);
  expect((await state()).regions[id].data.polygon.length).toBeGreaterThan(4);
  const beforePolygon = (await state()).regions[id].data.layout?.key;
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Draw polygon', exact: true }).click();
  for (const [x, y] of [[0.20, 0.16], [0.36, 0.16], [0.28, 0.30]]) {
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  }
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state()).regions[id].data.polygon).toHaveLength(3);
  await expect.poll(async () => (await state()).regions[id].data.layout?.key).not.toBe(beforePolygon);

  await page.reload();
  await expect.poll(async () => (await state()).regions[id].data.polygon).toHaveLength(3);
  await expect.poll(async () => (await state()).regions[id].data.layout?.key).not.toBe(beforePolygon);

  // Copy the rendered size and colors, including inherited properties, into each destination.
  current = await state();
  const destination = 'fixture-line-0-1';
  const nextDestination = 'fixture-line-0-2';
  const sourcePolygon = [{ x: .70, y: .12 }, { x: .77, y: .12 }, { x: .77, y: .165 }, { x: .70, y: .165 }];
  const smallPolygon = [{ x: .16, y: .12 }, { x: .22, y: .12 }, { x: .22, y: .15 }, { x: .16, y: .15 }];
  const source = await operation({ action: 'region', id, expectedRevision: current.regions[id].revision,
    data: { polygon: sourcePolygon, style: {
      size: 48, minSize: 2, leading: 1.35, padding: 1, align: 'right',
      fill: '#123456', outline: '#abcdef', autoContrast: true, outlineWidth: .5,
      rotation: 8, skewX: 6, skewY: -3, warpStyle: 'arc', warpBend: 35, emphasis: 'italic',
    } } });
  const fittedSource = (await operation({ action: 'fit', id, expectedRevision: source.doc.revision })).doc;
  const copiedStyle = { ...fittedSource.data.layout.style, size: fittedSource.data.layout.size, autoContrast: false };
  expect(copiedStyle.size).toBeLessThan(48);
  expect(fittedSource.data.layout.overflow).toBe(false);
  expect(copiedStyle.fill).toBe('#000000');
  expect(copiedStyle.fontId).toBe(fontId);
  await operation({ action: 'region', id: destination, expectedRevision: current.regions[destination].revision,
    data: { polygon: smallPolygon, style: { size: 32, align: 'left' } } });
  await page.goto(`${base}/series/fixture-series/episodes/fixture-episode?step=Typeset&page=fixture-page-0`);
  const palette = page.getByRole('toolbar', { name: 'Tools' });
  const brush = palette.getByRole('button', { name: 'Style brush', exact: true });
  const region = number => page.getByRole('button', { name: new RegExp(`^Region ${number}(,.*)?$`) });
  await expect(brush).toBeDisabled();
  await region(2).click();
  await expect(brush).toBeDisabled(); // An unfitted region has no rendered style to sample.
  await region(1).click();
  await expect(brush).toBeEnabled();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  const inspector = page.locator("aside.bilingual");
  await expect(inspector.getByLabel("Warp style", { exact: true })).toHaveValue(
    "arc",
  );
  await expect(inspector.getByLabel("Bend (%)", { exact: true })).toHaveValue(
    "35",
  );
  await brush.click();
  await expect(brush).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.canvas-page')).toHaveCSS('cursor', 'crosshair');

  // Hold the first fit open so a second click must queue rather than being dropped.
  let releaseFit;
  const fitGate = new Promise(resolve => { releaseFit = resolve; });
  let firstFitStarted = false;
  await page.route(url, async route => {
    const request = route.request();
    const payload = request.method() === 'POST' ? request.postDataJSON() : null;
    if (payload?.action === 'fit' && payload.id === destination && !firstFitStarted) {
      firstFitStarted = true;
      await fitGate;
    }
    await route.continue();
  });
  try {
    await region(2).click();
    await expect.poll(() => firstFitStarted).toBe(true);
    await region(3).click();
  } finally {
    releaseFit();
  }
  await expect.poll(async () => (await state()).regions[nextDestination].data.layout?.style).toEqual(copiedStyle);
  await page.unroute(url);
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await expect(page.getByLabel('Default size (pt)', { exact: true })).toHaveValue(String(copiedStyle.size));
  current = await state();
  expect(current.regions[id]).toEqual(fittedSource);
  for (const target of [destination, nextDestination]) {
    expect(current.regions[target].data.style).toEqual(copiedStyle);
    expect(current.regions[target].data.layout.style).toEqual(copiedStyle);
    expect(current.regions[target].data.layout.overflow).toBe(false);
    expect(current.lines.find(l => l.id === target)).toEqual(initial.lines.find(l => l.id === target));
  }
  expect(current.regions[destination].data.polygon).toEqual(smallPolygon);
  expect(current.regions[destination].data.layout.size).toBeLessThan(copiedStyle.size);
  expect(current.regions[nextDestination].data.layout.size).toBe(copiedStyle.size);
  expect(current.regions[nextDestination].data.polygon).toEqual(initial.regions[nextDestination].data.polygon);
  await expect(brush).toHaveAttribute('aria-pressed', 'true');
  const beforeSourceClick = await state();
  await region(1).click();
  expect((await state()).regions[id]).toEqual(beforeSourceClick.regions[id]);
  await brush.click();
  await expect(brush).toHaveAttribute('aria-pressed', 'false');

  // Locked destinations stay intact and switching tools stops painting.
  await region(2).click();
  const lock = page.getByRole('button', { name: 'Lock layout', exact: true });
  await expect(lock).toBeEnabled();
  await lock.click();
  await expect(page.getByRole('button', { name: 'Unlock layout', exact: true })).toBeEnabled();
  const locked = (await state()).regions[destination];
  await region(1).click();
  await brush.click();
  await region(2).click();
  await expect(page.getByRole('status').filter({ hasText: 'Unlock this layout before applying a style.' })).toBeVisible();
  expect((await state()).regions[destination]).toEqual(locked);
  await page.keyboard.press('Escape');
  await expect(brush).toHaveAttribute('aria-pressed', 'false');
  await region(3).click();
  await brush.click();
  await palette.getByRole('button', { name: 'Select (V)', exact: true }).click();
  await expect(brush).toHaveAttribute('aria-pressed', 'false');
  await region(1).click();
  expect((await state()).regions[id]).toEqual(fittedSource);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === '1');
  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Typeset', exact: true }).click();
  await page.locator('.pages > button').first().click();
  await region(3).click();
  await page.getByRole('tab', { name: 'Style', exact: true }).click();
  await expect(page.getByLabel('Default size (pt)', { exact: true })).toHaveValue(String(copiedStyle.size));
  expect((await state()).regions[nextDestination].data.layout.style).toEqual(copiedStyle);
  const overflowBox = [
    { x: 0.16, y: 0.12 },
    { x: 0.185, y: 0.12 },
    { x: 0.185, y: 0.138 },
    { x: 0.16, y: 0.138 },
  ];
  const overflowEdit = await operation({
    action: "region",
    id: nextDestination,
    expectedRevision: (await state()).regions[nextDestination].revision,
    data: { polygon: overflowBox, style: { size: 72, minSize: 36 } },
  });
  const overflowFit = await operation({
    action: "fit",
    id: nextDestination,
    expectedRevision: overflowEdit.doc.revision,
  });
  expect(overflowFit.doc.data.layout.overflow).toBe(true);
  await page.reload();
  await page
    .getByRole("navigation", { name: "Chapter workflow" })
    .getByRole("button", { name: "Typeset", exact: true })
    .click();
  await region(3).click();
  await expect(inspector.getByRole("alert")).toContainText(/text overflow/i);
  await expect(page.locator(".region-error")).toBeVisible();
  await expect(page.locator(".region-error text")).toHaveText("!");

  const dragId = "fixture-line-0-0";
  await region(1).click();
  await expect(page.getByRole("button", { name: "Move polygon point 1", exact: true })).toBeVisible();
  const beforeDrag = await state();
  const beforePoly = beforeDrag.regions[dragId].data.polygon;
  const beforeLayout = beforeDrag.regions[dragId].data.layout;
  const handle = await page.getByRole("button", { name: "Move polygon point 1", exact: true }).boundingBox();
  if (!handle) throw new Error("polygon point 1 is not visible");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 90, handle.y + handle.height / 2 + 70, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await state()).regions[dragId].data.polygon).not.toEqual(beforePoly);
  await expect.poll(async () => JSON.stringify((await state()).regions[dragId].data.layout)).not.toBe(JSON.stringify(beforeLayout));

  const env = JSON.parse(readFileSync("/tmp/scan-browser-env.json", "utf8"));
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const db = new Database(env.db);
  const dragLine = (await state()).lines.find(l => l.id === dragId);
  db.prepare("INSERT OR IGNORE INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(`${dragId}:translation:Reflow please now.`, "fixture-episode", dragId, dragLine.revision, "Reflow please now.", "fixture", "translation", Date.now(), "");
  db.close();
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.studioReady === "1");
  await expect.poll(async () => (await state()).suggestions.filter(s => s.body === "Reflow please now.").length).toBe(1);
  await page.getByRole("navigation", { name: "Chapter workflow" }).getByRole("button", { name: "Translate", exact: true }).click();
  await page.locator(".pages > button").first().click();
  await page.locator("#region-card-fixture-line-0-0").getByRole("button", { name: /^#\d/ }).click();
  await expect(page.getByRole("button", { name: "Use this version", exact: true })).toBeVisible();
  const beforeAccept = (await state()).regions[dragId].data.layout;
  await page.getByRole("button", { name: "Use this version", exact: true }).click();
  await expect.poll(async () => (await state()).lines.find(l => l.id === dragId).body).toBe("Reflow please now.");
  await expect.poll(async () => JSON.stringify((await state()).regions[dragId].data.layout)).not.toBe(JSON.stringify(beforeAccept));

  await page.getByRole('navigation', { name: 'Chapter workflow' }).getByRole('button', { name: 'Clean', exact: true }).click();
  await expect(brush).toHaveCount(0);
  expect(errors).toEqual([]);
  console.log('Typeset browser checks passed: type defaults, automatic refitting, rectangle bounds, computed style brush, queued clicks, locks, tool cancellation, and persistence.');
} finally {
  await page.screenshot({ path: '/tmp/scan-typeset-browser.png', fullPage: true }).catch(() => {});
  await browser.close();
}
