import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_STYLE } from '../src/lib/workflow';

const root = await mkdtemp('/tmp/scan-page-selection-');
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'scan.db');
const { db, sqlite } = await import('../src/lib/server/db');
const { users, series, episodes, images, lines, comments } = await import('../src/lib/server/db/schema');
const { eq } = await import('drizzle-orm');
const { extractPages, deletePages } = await import('../src/lib/server/pageSelection');
const { saveImageFile, episodeDir } = await import('../src/lib/server/storage');
const { getDoc, putDoc, storeAsset, suggest } = await import('../src/lib/server/workflowStore');
const { toEpisode, toSeries, toImage, toLine } = await import('../src/lib/server/queries');
const { preparePage } = await import('../src/lib/server/workflowService');
const { capturePageImages } = await import('../src/lib/server/pageImages');
const { layoutKey } = await import('../src/lib/server/typesetting');
const { pushUndo, readUndoLog } = await import('../src/lib/server/pageUndo');
const user = { id: 'editor', username: 'editor', role: 'admin' as const };
db.insert(users).values({ ...user, passwordHash: 'unused', createdAt: 1 }).run();
db.insert(series).values({ id: 'series', slug: 'series', title: 'Volume', createdAt: 1, updatedAt: 1 }).run();
const s = toSeries(db.select().from(series).get()!);
let fixtureNo = 0;

async function fixture() {
  const id = `source-${++fixtureNo}`;
  db.insert(episodes).values({ id, seriesId: s.id, slug: id, title: id,
    status: 'typesetting', previewToken: `${id}-public`, createdAt: 10, updatedAt: 20 }).run();
  const ctx = { series: s, episode: toEpisode(db.select().from(episodes).where(eq(episodes.id, id)).get()!), user };
  const raw = await sharp({ create: { width: 80, height: 100, channels: 3, background: '#888888' } }).png().toBuffer();
  const clean = await sharp({ create: { width: 80, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const rawHash = await storeAsset(raw), cleanHash = await storeAsset(clean);
  putDoc(id, `chapter:${id}`, { lang: 'korean', direction: 'ltr', dpi: 144, chapterSummary: 'Whole-volume context', styles: { '""': { size: 14 } } }, 0);
  for (let n = 0; n < 3; n++) {
    const pageId = `${id}-p${n}`, lineId = `${id}-l${n}`;
    const saved = await saveImageFile({ seriesSlug: s.slug, episodeSlug: id, sortOrder: n,
      originalName: `original-${n}.png`, bytes: raw, mime: 'image/png' });
    db.insert(images).values({ ...saved, id: pageId, episodeId: id, originalName: `original-${n}.png`,
      sortOrder: n * 10, pageNumber: 15 + n, caption: `Scene ${n}`, captionRevision: 2,
      dpi: 144, createdAt: 30, updatedAt: 40 }).run();
    db.insert(lines).values({ id: lineId, episodeId: id, imageId: pageId, body: `English ${n}`,
      source: `Source ${n}`, sourceState: 'read', ocrConfidence: 0.94, revision: 3,
      lineType: '""', status: 'approved', placed: true, invert: true,
      x: 0.1, y: 0.1, w: 0.6, h: 0.4, sidebarX: 0.3, sidebarY: 0.4, sidebarW: 0.2, sidebarH: 0.1,
      sortOrder: n, createdBy: user.id, updatedBy: user.id, updatedAt: 50 }).run();
    db.insert(comments).values({ id: `${id}-c${n}`, lineId, userId: user.id,
      body: 'Proofreader correction', correction: true, revision: 2, createdAt: 60 }).run();
    suggest(id, lineId, 3, 'Reviewed source', 'Review explanation', 'source-review', 'English alternative');
    putDoc(id, `page:${pageId}`, { original: rawHash, prepared: rawHash, preparedAt: 40, dpi: 144, thumbnail: cleanHash, thumbnailAt: 40 }, 0);
    const p = getDoc(`page:${pageId}`, {});
    putDoc(id, p.id, { ...p.data, cleaned: cleanHash, cleanBase: cleanHash, mask: cleanHash,
      maskApproved: true, cleanApproved: true, cleanMethod: 'clone', backend: 'local',
      strokes: [{ points: [{ x: 0.1, y: 0.2 }], radius: 8 }], expansion: 3 }, p.revision);
    const region = { polygon: [{ x: 0.1, y: 0.1 }, { x: 0.7, y: 0.1 }, { x: 0.7, y: 0.5 }, { x: 0.1, y: 0.5 }],
      geometryApproved: true, geometryConfidence: 0.99, style: { size: 14, rotation: 5, skewX: 2 }, locked: true, textMask: cleanHash };
    const image = toImage(db.select().from(images).where(eq(images.id, pageId)).get()!);
    const line = toLine(db.select().from(lines).where(eq(lines.id, lineId)).get()!);
    const style = { ...DEFAULT_STYLE, ...region.style };
    const layout = { key: layoutKey(line, region, image, style, 144), rows: [], size: 14, dpi: 144,
      width: 80, height: 100, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100" viewBox="0 0 80 100"><rect x="10" y="10" width="15" height="10" fill="black"/></svg>',
      overflow: false, missingGlyphs: [], hyphenated: false, style, font: { id: '', hash: '', postscriptName: 'Fixture' } };
    putDoc(id, `region:${lineId}`, region, 0);
    putDoc(id, `region:${lineId}`, { ...region, layout }, 1);
    const doc = getDoc(`region:${lineId}`, {});
    putDoc(id, doc.id, { ...doc.data, locked: false }, 2);
    putDoc(id, doc.id, {}, 3, 'undo'); // Exercise both copied undo and redo stacks.
    await writeFile(join(episodeDir(s.slug, id), `${saved.filename}.bak.1`), raw);
  }
  db.insert(lines).values({ id: `${id}-unplaced`, episodeId: id, body: 'Unassigned chapter note', updatedAt: 1 }).run();
  db.update(episodes).set({ numberingStale: false }).where(eq(episodes.id, id)).run();
  return ctx;
}

function savedSource(id: string) {
  return JSON.stringify(['episodes', 'images', 'lines', 'workflow_docs', 'workflow_revisions', 'suggestions'].map(table =>
    sqlite.prepare(`SELECT * FROM ${table} WHERE ${table === 'episodes' ? 'id' : 'episode_id'}=?`).all(id)));
}
const errorStatus = (status: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === status;

test('extraction preserves selected metadata, rendered pages and editable history without changing the source', async () => {
  const ctx = await fixture(), source = ctx.episode.id;
  const before = savedSource(source);
  const extracted = await extractPages(ctx, [`${source}-p2`, `${source}-p0`, `${source}-p2`], '07.5');
  assert.equal(extracted.pageCount, 2);
  assert.equal(extracted.title, '07.5');
  const chapter = db.select().from(episodes).where(eq(episodes.id, extracted.id)).get()!;
  assert.equal(chapter.status, 'typesetting');
  assert.equal(chapter.previewToken, null);
  assert.equal(chapter.numberingStale, false);
  const copied = db.select().from(images).where(eq(images.episodeId, chapter.id)).orderBy(images.sortOrder).all();
  assert.deepEqual(copied.map(p => [p.originalName, p.pageNumber, p.sortOrder]), [['original-0.png', 1, 0], ['original-2.png', 2, 1]]);
  assert.deepEqual(getDoc(`chapter:${chapter.id}`, {}).data, getDoc(`chapter:${source}`, {}).data);
  for (const [index, page] of copied.entries()) {
    const originalId = `${source}-p${index * 2}`;
    const original = db.select().from(images).where(eq(images.id, originalId)).get()!;
    const { id: _id, episodeId: _ep, pageNumber: _pn, sortOrder: _sort, ...metadata } = page;
    assert.deepEqual({ ...metadata }, Object.fromEntries(Object.entries(original).filter(([k]) => !['id', 'episodeId', 'pageNumber', 'sortOrder'].includes(k))));
    const pageDoc = getDoc(`page:${page.id}`, {});
    assert.deepEqual(pageDoc.data, getDoc(`page:${originalId}`, {}).data);
    await preparePage(s, toEpisode(chapter), toImage(page));
    assert.equal(getDoc(`page:${page.id}`, {}).revision, pageDoc.revision, 'opening the copy must not reset its cleaning');
    const line = db.select().from(lines).where(eq(lines.imageId, page.id)).get()!;
    const originalLineId = `${source}-l${index * 2}`;
    const originalLine = db.select().from(lines).where(eq(lines.id, originalLineId)).get()!;
    assert.deepEqual({ ...line, id: originalLine.id, episodeId: source, imageId: originalId }, originalLine);
    const region = getDoc(`region:${line.id}`, {}), originalRegion = getDoc(`region:${originalLineId}`, {});
    assert.deepEqual({ ...region, id: originalRegion.id }, originalRegion);
    assert.equal(region.canUndo, true);
    assert.equal(region.canRedo, true);
    const note = db.select().from(comments).where(eq(comments.lineId, line.id)).get()!;
    assert.equal(note.body, 'Proofreader correction');
    assert.equal(note.correction, true);
    assert.equal(note.revision, 2);
    const suggestion = sqlite.prepare('SELECT * FROM suggestions WHERE line_id=?').get(line.id) as Record<string, unknown>;
    assert.equal(suggestion.translation, 'English alternative');
    assert.equal(suggestion.base_revision, line.revision);
    assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_revisions WHERE entity_id=?').get(region.id) as { n: number }).n, 4);
    for (const suffix of ['', '.orig', '.bak.1']) assert.deepEqual(
      await readFile(join(episodeDir(s.slug, chapter.slug), page.filename + suffix)),
      await readFile(join(episodeDir(s.slug, source), original.filename + suffix)),
    );
    const rawAndTypeset = await capturePageImages(s, toEpisode(chapter), page.id);
    const originalImages = await capturePageImages(s, ctx.episode, originalId);
    assert.deepEqual(rawAndTypeset.raw, originalImages.raw);
    assert.deepEqual(rawAndTypeset.typeset, originalImages.typeset);
    putDoc(chapter.id, region.id, {}, region.revision, 'redo');
    assert.deepEqual(getDoc(originalRegion.id, {}), originalRegion);
  }
  assert.equal(db.select().from(lines).where(eq(lines.episodeId, chapter.id)).all().length, 2);
  assert.equal(savedSource(source), before);
  await deletePages({ ...ctx, episode: toEpisode(chapter) }, [copied[0].id, copied[1].id]);
  assert.equal(db.select().from(images).where(eq(images.episodeId, chapter.id)).all().length, 0);
  assert.equal(savedSource(source), before);
  assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
});

test('selection validation and job locks prevent partial copies/deletions', async () => {
  const ctx = await fixture(), other = await fixture(), id = ctx.episode.id;
  const before = savedSource(id);
  for (const selection of [[], null, 'all', [1], [`${id}-p0`, `${other.episode.id}-p0`], [`${id}-p0`, 'gone']]) {
    await assert.rejects(extractPages(ctx, selection, '21'));
    await assert.rejects(deletePages(ctx, selection));
  }
  for (const title of ['', ' ', '..', '../21', 'chapter 21', '-1', '1/2'])
    await assert.rejects(extractPages(ctx, [`${id}-p0`], title), errorStatus(400));
  sqlite.prepare("INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,created_at,updated_at) VALUES(?,?,'clean','running','{}',1,1)").run('busy-job', id);
  await assert.rejects(extractPages(ctx, [`${id}-p0`], '21'), errorStatus(409));
  await assert.rejects(deletePages(ctx, [`${id}-p0`]), errorStatus(409));
  sqlite.prepare('DELETE FROM workflow_jobs WHERE id=?').run('busy-job');
  assert.equal(savedSource(id), before);
});

test('conflicts, missing files and database failures leave no partial destination', async () => {
  const ctx = await fixture(), id = ctx.episode.id;
  const selection = [`${id}-p0`, `${id}-p2`];
  const racing = extractPages(ctx, selection, '22');
  db.update(images).set({ caption: 'A concurrent edit' }).where(eq(images.id, selection[0])).run();
  await assert.rejects(racing, errorStatus(409));
  await assert.rejects(access(episodeDir(s.slug, '22')));
  assert.equal(db.select().from(episodes).where(eq(episodes.slug, '22')).get(), undefined);
  const copies = await Promise.allSettled([extractPages(ctx, selection, '23'), extractPages(ctx, selection, '23')]);
  assert.equal(copies.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(copies.filter(r => r.status === 'rejected').length, 1);
  await access(episodeDir(s.slug, '23'));
  await assert.rejects(extractPages(ctx, selection, '23'), errorStatus(409));
  sqlite.exec(`CREATE TRIGGER reject_extraction BEFORE INSERT ON lines WHEN NEW.episode_id!='${id}' BEGIN SELECT RAISE(ABORT,'Simulated insert failure'); END`);
  try { await assert.rejects(extractPages(ctx, selection, '24'), /Simulated insert failure/); }
  finally { sqlite.exec('DROP TRIGGER reject_extraction'); }
  assert.equal(db.select().from(episodes).where(eq(episodes.slug, '24')).get(), undefined);
  await assert.rejects(access(episodeDir(s.slug, '24')));
  const page = db.select().from(images).where(eq(images.id, selection[1])).get()!;
  await rm(join(episodeDir(s.slug, id), page.filename));
  await rm(join(episodeDir(s.slug, id), `${page.filename}.orig`));
  await assert.rejects(extractPages(ctx, selection, '25'), /ENOENT/);
  assert.equal(db.select().from(episodes).where(eq(episodes.slug, '25')).get(), undefined);
  await assert.rejects(access(episodeDir(s.slug, '25')));
});

test('bulk deletion removes only selected pages and their dependent metadata', async () => {
  const ctx = await fixture(), id = ctx.episode.id;
  await pushUndo(s.slug, id, { type: 'pixels', imageId: `${id}-p1` });
  await pushUndo(s.slug, id, { type: 'pixels', imageId: `${id}-p0` });
  await pushUndo(s.slug, id, { type: 'split', originalId: `${id}-p1`, createdId: `${id}-p2`, order: [] });
  await pushUndo(s.slug, id, { type: 'reslice', dir: 'unused', previous: [], createdIds: [`${id}-p0`, `${id}-p1`], lines: [] });
  await pushUndo(s.slug, id, { type: 'reorder', order: [0, 1, 2].map(n => ({ id: `${id}-p${n}`, sortOrder: n })) });
  const before = savedSource(id);
  sqlite.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON images WHEN OLD.id='${id}-p2' BEGIN SELECT RAISE(ABORT,'Simulated delete failure'); END`);
  try { await assert.rejects(deletePages(ctx, [`${id}-p0`, `${id}-p2`]), /Simulated delete failure/); }
  finally { sqlite.exec('DROP TRIGGER reject_delete'); }
  assert.equal(savedSource(id), before, 'a failed bulk delete must restore every page and its metadata');
  const result = await deletePages(ctx, [`${id}-p2`, `${id}-p0`, `${id}-p0`]);
  assert.deepEqual(result.deletedIds, [`${id}-p0`, `${id}-p2`]);
  assert.deepEqual(db.select().from(images).where(eq(images.episodeId, id)).all().map(p => p.id), [`${id}-p1`]);
  assert.deepEqual(db.select().from(lines).where(eq(lines.episodeId, id)).all().map(l => l.id).sort(), [`${id}-l1`, `${id}-unplaced`]);
  assert.equal(getDoc(`page:${id}-p0`, {}).revision, 0);
  assert.equal(getDoc(`region:${id}-l0`, {}).revision, 0);
  assert.equal(db.select().from(comments).where(eq(comments.lineId, `${id}-l0`)).all().length, 0);
  assert.equal(sqlite.prepare('SELECT 1 FROM suggestions WHERE line_id=?').get(`${id}-l0`), undefined);
  assert.equal(db.select().from(episodes).where(eq(episodes.id, id)).get()!.numberingStale, true);
  assert.deepEqual(await readUndoLog(s.slug, id), [
    { type: 'pixels', imageId: `${id}-p1` },
    { type: 'reorder', order: [{ id: `${id}-p1`, sortOrder: 1 }] },
  ]);
  assert.deepEqual(sqlite.pragma('foreign_key_check'), []);
});

after(() => { sqlite.close(); });

test('combine requires adjacent pages, joins RTL pixels and restores pages and regions on undo', async () => {
  const { combineSpread, undoPageOp } = await import('../src/lib/server/pageEdit');
  const ctx = await fixture(), id = ctx.episode.id;
  const ids = [0, 1, 2].map(n => `${id}-p${n}`);
  await assert.rejects(combineSpread(ctx, [ids[0]]), /exactly two consecutive/);
  await assert.rejects(combineSpread(ctx, [ids[0], ids[2]]), /exactly two consecutive/);
  await assert.rejects(combineSpread(ctx, [ids[0], ids[0]]), /exactly two consecutive/);
  const { imagePath } = await import('../src/lib/server/storage');
  for (const [index, color] of ['#ff0000', '#0000ff'].entries()) {
    const row = db.select().from(images).where(eq(images.id, ids[index])).get()!;
    await writeFile(imagePath(s.slug, ctx.episode.slug, row.filename), await sharp({ create: {
      width: 80, height: 100, channels: 3, background: color,
    } }).png().toBuffer());
  }
  const before = ids.slice(0, 2).map(pageId => db.select().from(images).where(eq(images.id, pageId)).get()!);
  const spread = await combineSpread(ctx, [ids[1], ids[0]]);
  assert.equal(spread.width, 160);
  assert.equal(spread.height, 100);
  const pixels = await sharp(await readFile(imagePath(s.slug, ctx.episode.slug, spread.filename)))
    .removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 3)], [0, 0, 255]);
  assert.deepEqual([...pixels.subarray(80 * 3, 80 * 3 + 3)], [255, 0, 0]);
  const right = db.select().from(lines).where(eq(lines.id, `${id}-l0`)).get()!;
  const left = db.select().from(lines).where(eq(lines.id, `${id}-l1`)).get()!;
  assert.equal(right.x, 0.55);
  assert.equal(left.x, 0.05);
  assert.equal(left.imageId, ids[0]);
  assert.equal(db.select().from(images).where(eq(images.id, ids[1])).get(), undefined);
  await undoPageOp(ctx);
  const restored = db.select().from(images).where(eq(images.id, ids[1])).get()!;
  assert.equal(restored.filename, before[1].filename);
  assert.equal(db.select().from(images).where(eq(images.id, ids[0])).get()!.width, 80);
  assert.equal(db.select().from(lines).where(eq(lines.id, left.id)).get()!.imageId, ids[1]);
  assert.equal(db.select().from(lines).where(eq(lines.id, right.id)).get()!.x, 0.1);
});


test('shared comparison snapshots serve APNG and GIF without a session', async () => {
  const { shareRegionComparison, sharedComparisonResponse } = await import('../src/lib/server/sharedComparison');
  const ctx = await fixture(), id = ctx.episode.id;
  const page = toImage(db.select().from(images).where(eq(images.id, `${id}-p0`)).get()!);
  const line = toLine(db.select().from(lines).where(eq(lines.id, `${id}-l0`)).get()!);
  const shared = await shareRegionComparison(ctx.series, ctx.episode, line, page);
  const token = shared.apngSrc.split('/')[3];
  assert.match(token, /^[a-f0-9]{48}$/);
  const snapshot = await (await sharedComparisonResponse(token, 'apng')).arrayBuffer();
  assert.equal(Buffer.from(snapshot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const gif = await sharedComparisonResponse(token, 'gif');
  assert.equal(gif.headers.get('content-type'), 'image/gif');
  assert.equal((await sharp(Buffer.from(await gif.arrayBuffer()), { animated: true }).metadata()).pages, 2);
  const doc = getDoc(`page:${page.id}`, {});
  putDoc(id, doc.id, {}, doc.revision);
  assert.deepEqual(Buffer.from(await (await sharedComparisonResponse(token, 'apng')).arrayBuffer()), Buffer.from(snapshot));
  await assert.rejects(sharedComparisonResponse('0'.repeat(48), 'gif'), /Not found/);
  await assert.rejects(sharedComparisonResponse(token, 'mask'), /Not found/);
  await assert.rejects(sharedComparisonResponse('../private', 'apng'), /Not found/);
});
