import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { Episode, PublicUser, Series } from '../types';
import { assertEpisodeIdle, isRegionQueueBusy } from './aiTranslate';
import { db, sqlite } from './db';
import { activity, comments, episodes, images, lines, series as seriesTable } from './db/schema';
import { episodeSlugify, nid, now } from './ids';
import { broadcast } from './realtime';
import { discardDeletedPageUndo } from './pageUndo';
import { episodeDir, removeImageFile } from './storage';
import { hash, WorkflowError } from './workflowStore';

type Context = { series: Series; episode: Episode; user: PublicUser };
type StoredDoc = { id: string; revision: number; data: string; undo: string; redo: string; updated_at: number };
type Revision = { entity_id: string; revision: number; data: string; created_at: number };
type Suggestion = {
  id: string; line_id: string; base_revision: number; body: string; reason: string;
  kind: string; state: string; created_at: number; translation: string;
};

function assertIdle(episodeId: string) {
  assertEpisodeIdle(episodeId);
  if (isRegionQueueBusy(episodeId) || sqlite.prepare(
    "SELECT 1 FROM workflow_jobs WHERE episode_id=? AND state IN ('queued','running','cancelling') LIMIT 1",
  ).get(episodeId)) throw new WorkflowError('Finish or cancel running jobs before organizing pages', 409);
}

function selectedPages(episodeId: string, input: unknown) {
  if (!Array.isArray(input) || !input.length || input.some(id => typeof id !== 'string' || !id))
    throw new WorkflowError('Select at least one page');
  const ids = new Set<string>(input);
  const selected = db.select().from(images).where(eq(images.episodeId, episodeId))
    .orderBy(asc(images.sortOrder), asc(images.createdAt), asc(images.id)).all().filter(row => ids.has(row.id));
  if (selected.length !== ids.size) throw new WorkflowError('One or more selected pages no longer belong to this chapter. Refresh and select them again.', 409);
  return selected;
}

function snapshot(ctx: Context, input: unknown) {
  assertIdle(ctx.episode.id);
  const episode = db.select().from(episodes).where(eq(episodes.id, ctx.episode.id)).get();
  const series = db.select().from(seriesTable).where(eq(seriesTable.id, ctx.series.id)).get();
  if (!episode || !series || episode.seriesId !== series.id) throw new WorkflowError('Chapter not found', 404);
  const pages = selectedPages(episode.id, input);
  const pageIds = new Set(pages.map(p => p.id));
  const regions = db.select().from(lines).where(eq(lines.episodeId, episode.id))
    .orderBy(asc(lines.sortOrder), asc(lines.id)).all().filter(line => pageIds.has(line.imageId ?? ''));
  const lineIds = new Set(regions.map(line => line.id));
  const notes = db.select({ comment: comments }).from(comments).innerJoin(lines, eq(comments.lineId, lines.id))
    .where(eq(lines.episodeId, episode.id)).orderBy(asc(comments.id)).all()
    .map(row => row.comment).filter(comment => lineIds.has(comment.lineId));
  const entities = [
    `chapter:${episode.id}`, ...pages.flatMap(p => [`page:${p.id}`, `caption:${p.id}`]),
    ...regions.flatMap(l => [l.id, `region:${l.id}`]), ...notes.map(c => `comment:${c.id}`),
  ];
  const entityJson = JSON.stringify(entities);
  const docs = sqlite.prepare('SELECT id,revision,data,undo,redo,updated_at FROM workflow_docs WHERE episode_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(episode.id, entityJson) as StoredDoc[];
  const history = sqlite.prepare('SELECT entity_id,revision,data,created_at FROM workflow_revisions WHERE episode_id=? AND entity_id IN (SELECT value FROM json_each(?)) ORDER BY id')
    .all(episode.id, entityJson) as Revision[];
  const suggestions = (sqlite.prepare('SELECT * FROM suggestions WHERE episode_id=? ORDER BY id').all(episode.id) as Suggestion[])
    .filter(s => lineIds.has(s.line_id));
  return { episode, series, pages, regions, notes, docs, history, suggestions };
}

/** Copy a saved selection, including editable cleaning/typesetting documents and their history. */
export async function extractPages(ctx: Context, input: unknown, chapterNumber: unknown) {
  const title = typeof chapterNumber === 'string' ? chapterNumber.trim() : '';
  if (title.length > 80 || !/^\d+(?:\.\d+)*$/.test(title))
    throw new WorkflowError('Enter a chapter number, such as 12 or 12.5');
  const slug = episodeSlugify(title);
  const assertAvailable = () => {
    if (db.select({ id: episodes.id }).from(episodes)
      .where(and(eq(episodes.seriesId, ctx.series.id), eq(episodes.slug, slug))).get())
      throw new WorkflowError(`Chapter "${title}" already exists. Choose a different chapter number.`, 409);
  };
  const source = sqlite.transaction(() => { assertAvailable(); return snapshot(ctx, input); })();
  const id = nid();
  const imageMap = new Map(source.pages.map(p => [p.id, nid()]));
  const lineMap = new Map(source.regions.map(l => [l.id, nid()]));
  const commentMap = new Map(source.notes.map(c => [c.id, nid()]));
  const ids = new Map<string, string>([[source.episode.id, id], ...imageMap, ...lineMap, ...commentMap]);
  for (const [oldId, newId] of [...ids]) {
    for (const prefix of ['chapter', 'page', 'caption', 'region', 'comment'])
      ids.set(`${prefix}:${oldId}`, `${prefix}:${newId}`);
  }
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return ids.get(value) ?? value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [ids.get(key) ?? key, remap(item)]));
    return value;
  };
  const remapJson = (value: string) => JSON.stringify(remap(JSON.parse(value)));
  const from = episodeDir(source.series.slug, source.episode.slug);
  const to = episodeDir(source.series.slug, slug);
  let ownsDirectory = false;
  let committed = false;
  try {
    // Exclusively reserve the destination. Never merge with or overwrite another chapter's files.
    await mkdir(join(to, '..'), { recursive: true });
    try { await mkdir(to); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new WorkflowError(`A folder for chapter "${title}" already exists. Choose a different chapter number.`, 409);
      throw e;
    }
    ownsDirectory = true;
    const files = await readdir(from);
    for (const page of source.pages) {
      const working = files.includes(page.filename) ? page.filename : `${page.filename}.orig`;
      await copyFile(join(from, working), join(to, page.filename), constants.COPYFILE_EXCL);
      for (const name of files.filter(name => name === `${page.filename}.orig` || name === `${page.filename}.bak` ||
        (name.startsWith(`${page.filename}.bak.`) && /^\d+$/.test(name.slice(`${page.filename}.bak.`.length)))))
        await copyFile(join(from, name), join(to, name), constants.COPYFILE_EXCL);
    }
    sqlite.transaction(() => {
      assertAvailable();
      // File copies yield to other editors/jobs. Commit only if all saved source data still matches.
      if (JSON.stringify(snapshot(ctx, input)) !== JSON.stringify(source))
        throw new WorkflowError('The chapter changed during extraction. Try again to copy the latest edits.', 409);
      const t = now();
      const sortOrder = (sqlite.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM episodes WHERE series_id=?')
        .get(source.series.id) as { n: number }).n;
      db.insert(episodes).values({ ...source.episode, id, title, slug, sortOrder,
        previewToken: null, createdAt: t, updatedAt: t }).run();
      for (const [index, page] of source.pages.entries()) {
        // Keep updatedAt: preparedAt must still match it or preparing the copy discards cleaning.
        db.insert(images).values({ ...page, id: imageMap.get(page.id)!, episodeId: id,
          sortOrder: index, pageNumber: index + 1 }).run();
      }
      for (const line of source.regions) db.insert(lines).values({ ...line, id: lineMap.get(line.id)!,
        episodeId: id, imageId: imageMap.get(line.imageId!)! }).run();
      for (const comment of source.notes) db.insert(comments).values({ ...comment,
        id: commentMap.get(comment.id)!, lineId: lineMap.get(comment.lineId)! }).run();
      const insertDoc = sqlite.prepare('INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)');
      for (const doc of source.docs) insertDoc.run(ids.get(doc.id)!, id, doc.revision,
        remapJson(doc.data), remapJson(doc.undo), remapJson(doc.redo), doc.updated_at);
      const insertHistory = sqlite.prepare('INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at) VALUES(?,?,?,?,?)');
      for (const revision of source.history) insertHistory.run(id, ids.get(revision.entity_id)!,
        revision.revision, remapJson(revision.data), revision.created_at);
      const insertSuggestion = sqlite.prepare('INSERT INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,state,created_at,translation) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const s of source.suggestions) {
        const lineId = lineMap.get(s.line_id)!;
        const suggestionId = hash(s.translation ? JSON.stringify([lineId, s.base_revision, s.kind, s.body, s.translation])
          : `${lineId}:${s.base_revision}:${s.kind}:${s.body}`);
        insertSuggestion.run(suggestionId, id, lineId, s.base_revision, s.body, s.reason, s.kind, s.state, s.created_at, s.translation);
      }
      // Insert triggers mark numbering stale; this new chapter is already numbered in reading order.
      db.update(episodes).set({ numberingStale: false }).where(eq(episodes.id, id)).run();
      db.insert(activity).values({ id: nid(), seriesId: source.series.id, episodeId: id,
        userId: ctx.user.id, action: 'extracted_pages', payload: JSON.stringify({
          sourceId: source.episode.id, sourceTitle: source.episode.title, imageIds: source.pages.map(p => p.id), title,
        }), createdAt: t }).run();
    })();
    committed = true;
    return { id, title, slug, pageCount: source.pages.length };
  } finally {
    if (ownsDirectory && !committed) await rm(to, { recursive: true, force: true });
  }
}

/** Validate the whole selection first; remove all database records in one transaction. */
export async function deletePages(ctx: Context, input: unknown) {
  const removed = sqlite.transaction(() => {
    assertIdle(ctx.episode.id);
    const pages = selectedPages(ctx.episode.id, input);
    const ids = new Set(pages.map(p => p.id));
    const regions = db.select().from(lines).where(eq(lines.episodeId, ctx.episode.id)).all()
      .filter(line => ids.has(line.imageId ?? ''));
    const deleteDoc = sqlite.prepare('DELETE FROM workflow_docs WHERE episode_id=? AND id=?');
    for (const line of regions) {
      deleteDoc.run(ctx.episode.id, `region:${line.id}`);
      db.delete(lines).where(eq(lines.id, line.id)).run();
    }
    for (const page of pages) {
      deleteDoc.run(ctx.episode.id, `page:${page.id}`);
      sqlite.prepare('DELETE FROM job_pages WHERE image_id=?').run(page.id);
      db.delete(images).where(eq(images.id, page.id)).run();
    }
    db.update(episodes).set({ updatedAt: now() }).where(eq(episodes.id, ctx.episode.id)).run();
    const entry = { id: nid(), seriesId: ctx.series.id, episodeId: ctx.episode.id, userId: ctx.user.id,
      action: 'deleted_images', payload: JSON.stringify({ imageIds: pages.map(p => p.id), filenames: pages.map(p => p.filename) }), createdAt: now() };
    db.insert(activity).values(entry).run();
    return { pages, regions, entry };
  })();
  for (const line of removed.regions) broadcast(ctx.episode.id, { type: 'line:delete', id: line.id });
  for (const page of removed.pages) broadcast(ctx.episode.id, { type: 'image:delete', id: page.id });
  broadcast(ctx.episode.id, { type: 'activity', entry: { ...removed.entry, username: ctx.user.username } });
  await discardDeletedPageUndo(ctx.series.slug, ctx.episode.slug, removed.pages.map(p => p.id));
  for (const page of removed.pages) await removeImageFile(ctx.series.slug, ctx.episode.slug, page.filename);
  return { deletedIds: removed.pages.map(p => p.id) };
}
