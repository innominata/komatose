import { requireUser, requireSeriesAccess, fail, messageOf, statusOf } from '$lib/server/http';
import { fontsZipResponse } from '$lib/server/fontDownloads';
import { listFonts } from '$lib/server/typesetting';
import { getSeries } from '$lib/server/queries';
import type { RequestHandler } from './$types';

/** The fonts this series can use (its own and shared ones) as a zip; `?ids=a,b` for just those. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	try {
		const user = requireUser(locals.user);
		await requireSeriesAccess(user, params.id);
		const series = await getSeries(params.id).catch(() => undefined);
		return fontsZipResponse(listFonts(params.id), url.searchParams.get('ids'), `${series?.title ?? 'Series'} fonts`);
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
