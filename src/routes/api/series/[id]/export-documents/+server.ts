import { json } from '@sveltejs/kit';
import { asc, eq } from 'drizzle-orm';
import { EXPORT_DOCUMENTS, type ExportDocumentId } from '$lib/exportDocuments';
import { workCredit } from '$lib/workCredit';
import { db, sqlite } from '$lib/server/db';
import { episodes } from '$lib/server/db/schema';
import { toEpisode } from '$lib/server/queries';
import { fail, messageOf, requireSeriesAccess, requireUser, statusOf } from '$lib/server/http';
import { captureExportMetadata } from '$lib/server/finishedExport';
import { exportDocument } from '$lib/server/exportDocuments';
import type { RequestHandler } from './$types';

function seriesChapters(seriesId: string) {
  return db.select().from(episodes).where(eq(episodes.seriesId, seriesId))
    .orderBy(asc(episodes.sortOrder), asc(episodes.createdAt), asc(episodes.id)).all().map(toEpisode);
}

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    const series = await requireSeriesAccess(requireUser(locals.user), params.id);
    return json({
      chapters: seriesChapters(series.id).map(chapter => ({ id: chapter.id, title: chapter.title })),
      files: EXPORT_DOCUMENTS.filter(file => file.id !== 'attribution.txt' || workCredit(series.title)),
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

/** POST carries a chapter selection; this endpoint only reads saved content. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const series = await requireSeriesAccess(requireUser(locals.user), params.id);
    let body;
    try { body = await request.json(); }
    catch { return fail(400, 'Invalid JSON request'); }
    if (!body || !Array.isArray(body.episodeIds) || !body.episodeIds.length || body.episodeIds.some((id: unknown) => typeof id !== 'string'))
      return fail(400, 'Select at least one chapter');
    if (!EXPORT_DOCUMENTS.some(file => file.id === body.file)) return fail(400, 'Unknown metadata file');
    if (body.includeSceneNotes !== undefined && typeof body.includeSceneNotes !== 'boolean')
      return fail(400, 'Invalid scene notes option');
    const selected = new Set<string>(body.episodeIds);
    const chapters = seriesChapters(series.id).filter(chapter => selected.has(chapter.id));
    if (chapters.length !== selected.size) return fail(404, 'Chapter not found in this series');
    const document = sqlite.transaction(() => exportDocument(
      chapters.map(chapter => captureExportMetadata(series, chapter)),
      body.file as ExportDocumentId,
      body.includeSceneNotes !== false,
    ))();
    return json({ document, chapterCount: chapters.length }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
