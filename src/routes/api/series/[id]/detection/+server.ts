import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { episodes } from '$lib/server/db/schema';
import { detectionRows, seriesDetectionReport } from '$lib/server/detectionLog';
import { fail, messageOf, requireSeriesAccess, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** The series detection report; `?format=csv` lists every detected region and its outcome. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	try {
		const series = await requireSeriesAccess(requireUser(locals.user), params.id);
		const eps = db.select({ id: episodes.id, title: episodes.title }).from(episodes).where(eq(episodes.seriesId, series.id)).all();
		const titles = new Map(eps.map((e) => [e.id, e.title]));
		if (url.searchParams.get('format') === 'csv') {
			const quote = (v: unknown) => {
				const s = String(v ?? '');
				return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
			};
			const header = ['chapter', 'image_id', 'x', 'y', 'w', 'h', 'kind', 'score', 'detectors', 'detector_scores', 'outcome', 'reason', 'detected_at'];
			const body = detectionRows(series.id).map((r) => [
				titles.get(r.episodeId) ?? r.episodeId, r.imageId, r.x.toFixed(4), r.y.toFixed(4), r.w.toFixed(4), r.h.toFixed(4),
				r.kind, r.score, r.sources.join('+'), Object.entries(r.scores).map(([k, v]) => `${k}=${v}`).join(' '), r.outcome, r.reason,
				new Date(r.createdAt).toISOString(),
			].map(quote).join(','));
			return new Response([header.join(','), ...body].join('\n') + '\n', {
				headers: {
					'content-type': 'text/csv; charset=utf-8',
					'content-disposition': `attachment; filename="${series.slug}-detection.csv"`,
					'cache-control': 'no-store',
				},
			});
		}
		return json(seriesDetectionReport(series.id, titles), { headers: { 'cache-control': 'no-store' } });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
