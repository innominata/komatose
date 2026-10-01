import { json } from '@sveltejs/kit';
import { requireUser, requireSeriesAccess, fail, messageOf, statusOf } from '$lib/server/http';
import { fontGlyphs } from '$lib/server/typesetting';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		await requireSeriesAccess(user, params.id);
		return json(await fontGlyphs(params.id, params.fontId), {
			headers: { 'cache-control': 'private, max-age=3600' }
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
