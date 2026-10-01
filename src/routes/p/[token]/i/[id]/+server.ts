import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { episodes, images, series } from '$lib/server/db/schema';
import { renderGuestPage } from '$lib/server/finishedExport';
import { fail, messageOf, statusOf } from '$lib/server/http';
import { toEpisode, toImage, toSeries } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const token = params.token;
		if (!token || token.length < 20) return fail(404, 'Not found');
		const ep = await db.select().from(episodes).where(eq(episodes.previewToken, token)).get();
		if (!ep) return fail(404, 'Not found');
		const img = await db
			.select()
			.from(images)
			.where(and(eq(images.id, params.id), eq(images.episodeId, ep.id)))
			.get();
		if (!img) return fail(404, 'Not found');
		const s = await db.select().from(series).where(eq(series.id, ep.seriesId)).get();
		if (!s) return fail(404, 'Not found');
		const bytes = await renderGuestPage(toSeries(s), toEpisode(ep), toImage(img));
		return new Response(new Uint8Array(bytes), {
			headers: {
				'content-type': 'image/png',
				'content-length': String(bytes.length),
				'cache-control': 'public, max-age=60',
				'x-robots-tag': 'noindex'
			}
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
