import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';

const root = await mkdtemp(join(tmpdir(), 'komatose-chapter-safety-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');

const { sqlite } = await import('../src/lib/server/db');
const { episodeSlugify } = await import('../src/lib/server/ids');
const { episodeDir } = await import('../src/lib/server/storage');
const { deleteEpisode, duplicateEpisode } = await import('../src/lib/server/episodes');
const { getEpisode, getSeries, listImages, listLines } = await import('../src/lib/server/queries');
const { putDoc, getDoc, storeAsset } = await import('../src/lib/server/workflowStore');
const { removePageRegions } = await import('../src/lib/server/workflowService');
const { revertPageToRaw } = await import('../src/lib/server/pageEdit');
const { actions } = await import('../src/routes/series/[id]/+page.server');
const { PATCH } = await import('../src/routes/api/episodes/[eid]/+server');

sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('admin','Admin','unused','admin',1),('setter','Setter','unused','typesetter',1)").run();
sqlite.prepare("INSERT INTO series(id,slug,title,created_at,updated_at) VALUES('series','safe-series','Series',1,1)").run();
sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES('series','setter',1)").run();
sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,status,created_at,updated_at) VALUES('chapter','series','normal','Normal','raws',1,1),('unsafe','series','..','Unsafe','raws',1,1)").run();

after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

test('chapter folder paths cannot target a series or shared image directory', async () => {
  assert.equal(episodeSlugify('.'), 'chapter');
  assert.equal(episodeSlugify('..'), 'chapter');
  assert.equal(episodeSlugify('07.5'), '07.5');
  for (const slug of ['.', '..', '../other', 'other\\..']) {
    assert.throws(() => episodeDir('safe-series', slug), /Invalid image folder slug/);
  }

  const safe = episodeDir('safe-series', 'normal');
  await mkdir(safe, { recursive: true });
  const marker = join(safe, 'keep.txt');
  await writeFile(marker, 'keep');
  await assert.rejects(deleteEpisode({ series: (await getSeries('series'))!, episode: (await getEpisode('unsafe'))! }), /Invalid image folder slug/);
  assert.ok(await getEpisode('unsafe'), 'the database row is retained when deletion is rejected');
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

function statusRequest(actor: 'admin' | 'setter', body: Record<string, unknown>) {
  return PATCH({
    locals: { user: { id: actor, username: actor, role: actor === 'admin' ? 'admin' : 'typesetter' } },
    params: { eid: 'chapter' },
    request: new Request('http://local/api/episodes/chapter', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    })
  } as never);
}

test('chapter status changes require edit permission and validate before renaming', async () => {
  assert.equal((await statusRequest('setter', { status: 'done' })).status, 403);
  assert.equal((await getEpisode('chapter'))!.status, 'raws');
  assert.equal((await statusRequest('admin', { title: 'Changed', status: 'invalid' })).status, 400);
  assert.equal((await getEpisode('chapter'))!.title, 'Normal');
  assert.equal((await statusRequest('admin', { status: 'done' })).status, 200);
  assert.equal((await getEpisode('chapter'))!.status, 'done');
});

const user = { id: 'admin', username: 'Admin', role: 'admin' as const };

async function duplicateFixture(id: string) {
  sqlite.prepare('INSERT INTO series(id,slug,title,created_at,updated_at) VALUES(?,?,?,1,1)').run(id, id, id);
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,status,created_at,updated_at) VALUES(?,?,'5','5','translating',1,1)").run(id, id);
  const ctx = { series: (await getSeries(id))!, episode: (await getEpisode(id))!, user };
  const dir = episodeDir(id, '5');
  await mkdir(dir, { recursive: true });
  const working = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888888' } }).png().toBuffer();
  const raw = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await writeFile(join(dir, 'page.png'), working);
  await writeFile(join(dir, 'page.png.orig'), raw);
  await writeFile(join(dir, 'page.png.bak.1'), raw);
  await writeFile(join(dir, 'undo.json'), '[]');
  await mkdir(join(dir, 'reslice-undo-saved'));
  await writeFile(join(dir, 'reslice-undo-saved', 'old-page.png'), raw);
  const imageId = `${id}-image`, lineId = `${id}-line`;
  sqlite.prepare("INSERT INTO images(id,episode_id,filename,original_name,width,height,created_at) VALUES(?,?,'page.png','page.png',64,64,1)").run(imageId, id);
  sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,source,source_state,status,placed,x,y,w,h,updated_at) VALUES(?,?,?,'Published translation','Source','read','approved',1,0.1,0.1,0.2,0.2,1)").run(lineId, id, imageId);
  sqlite.prepare("INSERT INTO comments(id,line_id,user_id,body,created_at) VALUES(?,?,'admin','Keep this comment',1)").run(`${id}-comment`, lineId);
  const prepared = await storeAsset(raw), cleaned = await storeAsset(working);
  putDoc(id, `page:${imageId}`, { prepared, original: prepared, cleaned, cleanApproved: true }, 0);
  putDoc(id, `region:${lineId}`, { imageId, locked: true, style: { size: 20 } }, 0);
  putDoc(id, `uploads:${id}`, { pages: [imageId] }, 0);
  return { ctx, dir, working, raw, imageId, lineId };
}

test('duplicating a resliced chapter copies current work and isolates region deletion and raw resets', async () => {
  const source = await duplicateFixture('resliced-copy');
  const originalPageDoc = getDoc(`page:${source.imageId}`, {});
  const originalRegionDoc = getDoc(`region:${source.lineId}`, {});
  const copy = await duplicateEpisode(source.ctx);
  const copyDir = episodeDir(source.ctx.series.slug, copy.slug);
  assert.deepEqual((await readdir(copyDir)).sort(), ['page.png', 'page.png.orig']);
  assert.deepEqual(await readFile(join(copyDir, 'page.png')), source.working);
  assert.deepEqual(await readFile(join(copyDir, 'page.png.orig')), source.raw);
  const [image] = await listImages(copy.id), [line] = await listLines(copy.id);
  assert.notEqual(image.id, source.imageId);
  assert.notEqual(line.id, source.lineId);
  assert.equal(line.episodeId, copy.id);
  assert.equal(line.imageId, image.id);
  assert.equal(line.body, 'Published translation');
  assert.equal(line.placed, true);
  assert.deepEqual(getDoc(`page:${image.id}`, {}).data, originalPageDoc.data);
  assert.deepEqual(getDoc(`region:${line.id}`, {}).data, { ...originalRegionDoc.data, imageId: image.id });
  assert.equal(getDoc(`region:${line.id}`, {}).canUndo, false);
  assert.deepEqual(getDoc(`uploads:${copy.id}`, {}).data, { pages: [image.id] });
  assert.equal((sqlite.prepare('SELECT body FROM comments WHERE line_id=?').get(line.id) as { body: string }).body, 'Keep this comment');
  assert.deepEqual(removePageRegions(copy.id, [image.id]), [line.id]);
  await revertPageToRaw({ ...source.ctx, episode: (await getEpisode(copy.id))! }, image.id);
  assert.equal((await listLines(copy.id)).length, 0);
  assert.deepEqual(await readFile(join(copyDir, 'page.png')), source.raw);
  assert.equal((await listLines(source.ctx.episode.id)).length, 1);
  assert.deepEqual(await readFile(join(source.dir, 'page.png')), source.working);
  assert.deepEqual(getDoc(`page:${source.imageId}`, {}), originalPageDoc);
  assert.deepEqual(getDoc(`region:${source.lineId}`, {}), originalRegionDoc);
});

test('a leftover copy folder is preserved and duplication opens the newly created chapter', async () => {
  const source = await duplicateFixture('leftover-copy');
  const oldDir = episodeDir(source.ctx.series.slug, '5-copy');
  await mkdir(oldDir);
  await writeFile(join(oldDir, 'keep.txt'), 'existing partial copy');
  const body = new FormData();
  body.set('episodeId', source.ctx.episode.id);
  let location = '';
  await assert.rejects(async () => actions.duplicateEpisode!({
    locals: { user }, params: { id: source.ctx.series.id },
    request: new Request('http://local/series/leftover-copy?/duplicateEpisode', { method: 'POST', body }),
  } as never), (e: unknown) => {
    const redirect = e as { status: number; location: string };
    assert.equal(redirect.status, 303);
    location = redirect.location;
    return true;
  });
  const copyId = location.split('/').at(-1)!;
  assert.notEqual(copyId, source.ctx.episode.id);
  assert.equal((await getEpisode(copyId))!.slug, '5-copy-2');
  assert.equal(await readFile(join(oldDir, 'keep.txt'), 'utf8'), 'existing partial copy');
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM activity WHERE episode_id=? AND action='duplicated_episode'").get(copyId) as { n: number }).n, 1);
});

test('a copy failure after the first file leaves no partial folder or chapter record', async (t) => {
  const source = await duplicateFixture('failed-files');
  const copyFile = fsPromises.copyFile;
  let calls = 0;
  t.mock.method(fsPromises, 'copyFile', async (...args: Parameters<typeof copyFile>) => {
    assert.equal((sqlite.prepare('SELECT count(*) AS n FROM episodes WHERE series_id=?').get(source.ctx.series.id) as { n: number }).n, 1, 'a partial chapter is never visible');
    if (++calls === 2) throw new Error('simulated file copy failure');
    return copyFile(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(duplicateEpisode(source.ctx), /simulated file copy failure/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(calls, 2);
  assert.deepEqual(await readdir(join(root, 'data', 'images', source.ctx.series.slug)), ['5']);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM episodes WHERE series_id=?').get(source.ctx.series.id) as { n: number }).n, 1);
  assert.deepEqual(await readFile(join(source.dir, 'page.png')), source.working);
});

test('a metadata failure rolls back the entire copy and removes its files', async () => {
  const source = await duplicateFixture('failed-metadata');
  sqlite.exec(`CREATE TRIGGER fail_duplicate_docs BEFORE INSERT ON workflow_docs
    WHEN NEW.episode_id != 'failed-metadata' AND NEW.id LIKE 'region:%'
    BEGIN SELECT RAISE(ABORT, 'simulated metadata failure'); END`);
  try {
    await assert.rejects(duplicateEpisode(source.ctx), /simulated metadata failure/);
  } finally {
    sqlite.exec('DROP TRIGGER fail_duplicate_docs');
  }
  assert.deepEqual(await readdir(join(root, 'data', 'images', source.ctx.series.slug)), ['5']);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM episodes WHERE series_id=?').get(source.ctx.series.id) as { n: number }).n, 1);
  assert.equal((await listLines(source.ctx.episode.id)).length, 1);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});
