import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const root = await mkdtemp(join(tmpdir(), 'komatose-page-undo-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/test.db');
const { sqlite } = await import('../src/lib/server/db');
const { getSeries, getEpisode, listImages } = await import('../src/lib/server/queries');
const { saveImageFile, imagePath, episodeDir } = await import('../src/lib/server/storage');
const { pushUndo, readUndoLog, pageUndoToken, pageUndoSummary } = await import('../src/lib/server/pageUndo');
const { storeAsset, getDoc, putDoc } = await import('../src/lib/server/workflowStore');
const { undoPageOp } = await import('../src/lib/server/pageEdit');
const { reslicePages } = await import('../src/lib/server/reslice');
const { replaceImage } = await import('../src/lib/server/replaceImage');
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('u','fixture','unused','admin',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('s','series','Fixture',1,1)").run();
const user = { id: 'u', username: 'fixture', role: 'admin' } as const;
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

async function fixture(id: string, withLine = false) {
  sqlite.prepare('INSERT INTO episodes(id,series_id,slug,title,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id, 's', id, id);
  const bytes = await sharp({ create: { width: 80, height: 240, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  const file = await saveImageFile({ seriesSlug: 'series', episodeSlug: id, sortOrder: 0, originalName: 'strip.png', bytes, mime: 'image/png' });
  sqlite.prepare('INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at) VALUES(?,?,?,?,0,80,240,1,1)').run(`${id}-page`, id, file.filename, 'strip.png');
  const hash = await storeAsset(bytes);
  putDoc(id, `page:${id}-page`, { prepared: hash, original: hash, preparedAt: 1, cleaned: hash, cleanApproved: true }, 0);
  if (withLine) {
    sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,source,source_state,status,placed,x,y,w,h,updated_at) VALUES(?,?,?,'Keep translation','기다려!','read','approved',1,0.1,0.1,0.5,0.1,1)").run(`${id}-line`, id, `${id}-page`);
    putDoc(id, `region:${id}-line`, { locked: true, style: { size: 12 } }, 0);
  }
  return { series: (await getSeries('s'))!, episode: (await getEpisode(id))!, user, bytes };
}

test('replacement occupies the page undo stack and restores artwork without undoing the previous reslice', async () => {
  const ctx = await fixture('replace', true);
  const previous = { type: 'reslice' as const, dir: '/historical', previous: [], createdIds: [], lines: [] };
  await pushUndo(ctx.series.slug, ctx.episode.slug, previous);
  const previousLog = await readUndoLog(ctx.series.slug, ctx.episode.slug);
  const before = getDoc<any>('page:replace-page', {}).data;
  const replacement = await sharp({ create: { width: 90, height: 200, channels: 3, background: 'red' } }).png().toBuffer();
  await replaceImage({ ...ctx, imageId: 'replace-page', bytes: replacement, name: 'replacement.png' });
  assert.equal((await readUndoLog(ctx.series.slug, ctx.episode.slug)).at(-1)?.type, 'pixels');
  putDoc(ctx.episode.id, 'page:replace-page', { preparedAt: 99 }, getDoc('page:replace-page', {}).revision);
  const result = await undoPageOp(ctx);
  assert.equal(result.image?.width, 80);
  assert.equal(result.image?.height, 240);
  assert.deepEqual(await readFile(imagePath(ctx.series.slug, ctx.episode.slug, result.image!.filename)), ctx.bytes);
  assert.equal(getDoc<any>('page:replace-page', {}).data.cleaned, before.cleaned);
  assert.equal(getDoc<any>('page:replace-page', {}).data.cleanApproved, true);
  assert.deepEqual(await readUndoLog(ctx.series.slug, ctx.episode.slug), previousLog);
  assert.deepEqual(sqlite.prepare('SELECT image_id,source,body FROM lines WHERE id=?').get('replace-line'), { image_id: 'replace-page', source: '기다려!', body: 'Keep translation' });
});

test('undo refuses a reslice with later regions without deleting pages or consuming history', async () => {
  const ctx = await fixture('later');
  const result = await reslicePages(ctx, { cuts: [120] });
  sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,source,body,placed,updated_at) VALUES('later-line',?,?, '김민지','Saved work',1,?)").run(ctx.episode.id, result.images[0].id, Date.now());
  const history = await readUndoLog(ctx.series.slug, ctx.episode.slug);
  await assert.rejects(undoPageOp(ctx), /contain later work/);
  assert.deepEqual((await listImages(ctx.episode.id)).map(p => p.id), result.images.map(p => p.id));
  assert.deepEqual(await readUndoLog(ctx.series.slug, ctx.episode.slug), history);
  assert.equal((sqlite.prepare('SELECT image_id FROM lines WHERE id=?').get('later-line') as any).image_id, result.images[0].id);
});

test('undo refuses later cleaning and missing backup files before changing any state', async () => {
  const ctx = await fixture('clean');
  const result = await reslicePages(ctx, { cuts: [120] });
  const id = `page:${result.images[0].id}`;
  const doc = getDoc<any>(id, {});
  putDoc(ctx.episode.id, id, { ...doc.data, cleanApproved: true }, doc.revision);
  const history = await readUndoLog(ctx.series.slug, ctx.episode.slug);
  await assert.rejects(undoPageOp(ctx), /contain later work/);
  assert.deepEqual(await readUndoLog(ctx.series.slug, ctx.episode.slug), history);
  const empty = await fixture('missing');
  await reslicePages(empty, { cuts: [120] });
  const before = await readUndoLog(empty.series.slug, empty.episode.slug);
  await rm((before.at(-1) as any).dir, { recursive: true });
  await assert.rejects(undoPageOp(empty), /backup is missing/);
  assert.equal((await listImages(empty.episode.id)).length, 2);
  assert.deepEqual(await readUndoLog(empty.series.slug, empty.episode.slug), before);
});

test('undo refuses edits to a region that existed before reslicing', async () => {
  const ctx = await fixture('edited', true);
  const result = await reslicePages(ctx, { cuts: [120] });
  const page = getDoc<any>(`page:${result.images[0].id}`, {});
  const baseline = (sqlite.prepare('SELECT updated_at FROM workflow_docs WHERE id=?').get(page.id) as any).updated_at;
  sqlite.prepare('UPDATE lines SET y=?,updated_at=? WHERE id=?').run(0.4, baseline + 1000, 'edited-line');
  const before = await readUndoLog(ctx.series.slug, ctx.episode.slug);
  await assert.rejects(undoPageOp(ctx), /contain later work/);
  assert.equal((sqlite.prepare('SELECT y FROM lines WHERE id=?').get('edited-line') as any).y, 0.4);
  assert.deepEqual(await readUndoLog(ctx.series.slug, ctx.episode.slug), before);
});

test('a fresh reslice remains undoable after the chapter folder is renamed', async () => {
  const ctx = await fixture('renamed', true);
  await reslicePages(ctx, { cuts: [120] });
  await rename(episodeDir(ctx.series.slug, ctx.episode.slug), episodeDir(ctx.series.slug, 'renamed-new'));
  sqlite.prepare('UPDATE episodes SET slug=? WHERE id=?').run('renamed-new', ctx.episode.id);
  ctx.episode.slug = 'renamed-new';
  await undoPageOp(ctx);
  const images = await listImages(ctx.episode.id);
  assert.deepEqual(images.map(p => p.id), ['renamed-page']);
  assert.deepEqual(await readFile(imagePath(ctx.series.slug, ctx.episode.slug, images[0].filename)), ctx.bytes);
  assert.deepEqual(sqlite.prepare('SELECT image_id,x,y FROM lines WHERE id=?').get('renamed-line'), { image_id: 'renamed-page', x: 0.1, y: 0.1 });
});

test('Undo details name replacements and reslice page counts, including legacy history', async () => {
  const ctx = await fixture('details');
  const images = await listImages(ctx.episode.id);
  const replacement = { type: 'pixels' as const, imageId: images[0].id, description: 'Replace page from DRAFT-41.psd' };
  const summary = pageUndoSummary(replacement, images)!;
  assert.match(summary.label, /Replace page from DRAFT-41.psd.*page 1/);
  assert.match(summary.confirmation, /Restore the previous image pixels/);
  assert.equal(summary.token, pageUndoToken(replacement));
  const legacy = pageUndoSummary({ type: 'reslice', dir: '/backup', previous: images, createdIds: ['a', 'b', 'c'], lines: [] }, images)!;
  assert.match(legacy.label, /Reslice 1 → 3 pages/);
  assert.match(legacy.confirmation, /Remove 3 sliced pages and restore 1 previous page/);
  assert.equal(pageUndoSummary(undefined, images), null);
});

test('API Undo requires the exact operation described at confirmation and rejects a changed stack', async () => {
  const ctx = await fixture('confirm');
  const { GET, POST } = await import('../src/routes/api/episodes/[eid]/pages/+server');
  const event = (body?: unknown) => ({ locals: { user }, params: { eid: ctx.episode.id }, request: new Request('http://fixture/api/pages', body ? { method: 'POST', body: JSON.stringify(body) } : {}) }) as any;
  const operation = { type: 'reorder' as const, order: [{ id: 'confirm-page', sortOrder: 0 }] };
  await pushUndo(ctx.series.slug, ctx.episode.slug, operation);
  const details = await (await GET(event())).json();
  assert.equal(details.undoCount, 1);
  assert.match(details.undo.label, /Reorder chapter pages/);
  assert.equal((await POST(event({ op: 'undo' }))).status, 409);
  // Even identical operations need their own confirmation.
  await pushUndo(ctx.series.slug, ctx.episode.slug, operation);
  const before = await readUndoLog(ctx.series.slug, ctx.episode.slug);
  const stale = await POST(event({ op: 'undo', undoToken: details.undo.token }));
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /next undo action changed/);
  assert.deepEqual(await readUndoLog(ctx.series.slug, ctx.episode.slug), before);
  const current = await (await GET(event())).json();
  assert.notEqual(current.undo.token, details.undo.token);
  assert.equal((await POST(event({ op: 'undo', undoToken: current.undo.token }))).status, 200);
  assert.equal((await readUndoLog(ctx.series.slug, ctx.episode.slug)).length, 1);
});

test('reordering cannot change another chapter or create undo history for an invalid order', async () => {
  const ctx = await fixture('order');
  const { reorderPages } = await import('../src/lib/server/pageEdit');
  await assert.rejects(reorderPages(ctx, [{ id: 'confirm-page', sortOrder: 0 }]), /each chapter page exactly once/);
  assert.equal((await readUndoLog(ctx.series.slug, ctx.episode.slug)).length, 0);
  await reorderPages(ctx, [{ id: 'order-page', sortOrder: 0 }]);
  assert.equal((await readUndoLog(ctx.series.slug, ctx.episode.slug)).at(-1)?.type, 'reorder');
});
