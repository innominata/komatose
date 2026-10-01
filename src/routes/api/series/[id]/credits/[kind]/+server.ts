import { fail, messageOf, requireSeriesAccess, requireUser, statusOf } from '$lib/server/http';
import { loadSeriesCreditBytes } from '$lib/server/seriesCredits';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const s = await requireSeriesAccess(user, params.id);
		const { bytes, credit } = await loadSeriesCreditBytes(s, params.kind);
		return new Response(new Uint8Array(bytes), {
			headers: {
				'content-type': 'image/png',
				'cache-control': 'private, max-age=60',
				'content-disposition': `inline; filename="${credit.originalName.replace(/[^a-zA-Z0-9_.-]/g, '_')}"`
			}
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
