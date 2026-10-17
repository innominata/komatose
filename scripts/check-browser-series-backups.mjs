/** Full series backup/restore acceptance, using only the isolated browser fixture. */
import { chromium, expect } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readdir, writeFile, readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { homedir } from "node:os";
import { join } from "node:path";

const base = process.env.SCAN_TEST_BASEURL || "http://127.0.0.1:5188";
let executablePath = process.env.SCAN_TEST_CHROMIUM || chromium.executablePath();
if (!existsSync(executablePath) && !process.env.SCAN_TEST_CHROMIUM) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), ".cache/ms-playwright");
  if (existsSync(cache)) executablePath = readdirSync(cache)
    .filter(n => /^chromium-\d+$/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map(n => join(cache, n, "chrome-linux64/chrome"))
    .find(p => existsSync(p)) || executablePath;
}
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
await context.addCookies([{ name: "scan_session", value: "fixture-local-session", domain: "127.0.0.1", path: "/" }]);
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const dataDir = process.env.SCAN_TEST_DATA;
if (!dataDir || !dataDir.startsWith('/tmp/scan-browser-')) throw new Error('An isolated browser fixture is required');
const db = new Database(join(dataDir, 'scan.db'));
const workflow = async () => {
  const response = await context.request.get(`${base}/api/episodes/fixture-episode/workflow`);
  expect(response.ok(), response.ok() ? '' : await response.text()).toBe(true);
  return response.json();
};
try {
  const before = await workflow();
  const seriesDir = join(dataDir,'images/fixture-series');
  await mkdir(join(seriesDir,'chapter-1/reslice-undo-saved'));
  await writeFile(join(seriesDir,'chapter-1/reslice-undo-saved/marker'),'retained undo');
  await page.goto(`${base}/series/fixture-series`,{waitUntil:'networkidle'});
  const panel = page.getByRole('region',{name:'Series backups'});
  await panel.getByLabel('Backup name').fill('Before destructive testing');
  await panel.getByRole('button',{name:'Back up series',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('Backup saved');
  await panel.getByRole('link',{name:'Manage backups & restore'}).click();
  await expect(page.getByRole('heading',{name:'Series backups',exact:true})).toBeVisible();
  let card = page.getByRole('article',{name:'Before destructive testing',exact:true});
  const downloading = page.waitForEvent('download');
  await card.getByRole('link',{name:'Download ZIP',exact:true}).click();
  const download = await downloading;
  const bytes = await readFile(await download.path());
  const zip = await JSZip.loadAsync(bytes);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  expect(manifest.tables.lines).toBe(before.lines.length);
  expect(zip.file('images/chapter-1/reslice-undo-saved/marker')).not.toBeNull();

  // Reject archive versions without modifying the saved series.
  zip.file('manifest.json',JSON.stringify({...manifest,version:99}));
  const importPanel = page.getByRole('region',{name:'Import a series backup'});
  await importPanel.getByLabel('Backup file').setInputFiles({name:'wrong-version.zip',mimeType:'application/zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
  await importPanel.getByRole('button',{name:'Import backup',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Backup migration is not supported');
  expect((await workflow()).lines).toEqual(before.lines);
  await importPanel.getByLabel('Backup file').setInputFiles({name:'series-backup.zip',mimeType:'application/zip',buffer:bytes});
  await importPanel.getByRole('button',{name:'Import backup',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Imported');
  expect(db.prepare('SELECT count(*) AS n FROM episodes').get().n).toBe(1);

  // Delete the chapter and all its regions/files, as destructive testing could.
  const deletion = await context.request.post(`${base}/series/fixture-series?/deleteEpisode`, {
    form: { episodeId: 'fixture-episode' }, headers: { origin: base, accept: 'application/json' },
  });
  expect(deletion.ok(), await deletion.text()).toBe(true);
  expect(db.prepare('SELECT count(*) AS n FROM images').get().n).toBe(0);
  card = page.getByRole('article',{name:'Before destructive testing',exact:true}).first();
  let restoreRequests = 0;
  page.on('request',request => { if (request.method() === 'POST' && request.url().includes('/backups?/restore')) restoreRequests++; });
  const cancelDialog = page.waitForEvent('dialog');
  const cancelClick = card.getByRole('button',{name:'Restore',exact:true}).click();
  await (await cancelDialog).dismiss(); await cancelClick;
  expect(restoreRequests).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM episodes').get().n).toBe(0);
  const restoreDialog = page.waitForEvent('dialog');
  const restoreClick = card.getByRole('button',{name:'Restore',exact:true}).click();
  const prompt = await restoreDialog;
  expect(prompt.message()).toContain('A safety backup');
  await prompt.accept(); await restoreClick;
  await expect(page.getByRole('status')).toContainText('Series restored');
  await expect(page.getByText('Safety backup',{exact:true})).toBeVisible();
  const after = await workflow();
  const staleSave = await context.request.patch(`${base}/api/episodes/fixture-episode/lines/${before.lines[0].id}`, {
    data: { body: 'Stale draft', expectedRevision: before.lines[0].revision },
  });
  expect(staleSave.status()).toBe(409);
  expect(after.lines.map(({revision,updatedAt,...line})=>line)).toEqual(before.lines.map(({revision,updatedAt,...line})=>line));
  expect(after.images.map(({captionRevision,...image})=>image)).toEqual(before.images.map(({captionRevision,...image})=>image));
  for (const [id,doc] of Object.entries(before.regions)) expect(after.regions[id].data).toEqual(doc.data);
  for (const [id,doc] of Object.entries(before.pages)) expect(after.pages[id].data).toEqual(doc.data);
  expect(await readFile(join(seriesDir,'chapter-1/reslice-undo-saved/marker'),'utf8')).toBe('retained undo');
  await page.getByRole('link',{name:'Open restored series',exact:true}).click();
  await page.getByRole('link',{name:/Chapter 1/}).click();
  await page.waitForFunction(()=>document.body.dataset.studioReady==='1');
  await page.reload();
  await page.waitForFunction(()=>document.body.dataset.studioReady==='1');
  expect((await workflow()).lines).toHaveLength(before.lines.length);
  expect(errors).toEqual([]);
  console.log('Series backups passed: create, download, incompatible-archive rejection, import, restore cancellation, deleted chapter/regions/files recovery, automatic safety backup, retained layouts and undo files, editor reload.');
} finally {
  db.close(); await browser.close();
}
