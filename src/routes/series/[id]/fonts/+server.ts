import { json } from '@sveltejs/kit';
import { requireUser, requireSeriesAccess, fail, messageOf, statusOf } from '$lib/server/http';
import { canClean, canUpload } from '$lib/server/access';
import { listFonts, setFontCategory } from '$lib/server/typesetting';
import type { RequestHandler } from './$types';

/** Body: `{ ids: string[], category }`. Files this series' own fonts under the category. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		await requireSeriesAccess(user, params.id);
		if (!canUpload(user) && !canClean(user)) return fail(403, 'Forbidden');
		const body = await request.json();
		const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
		return json({ ok: true, fonts: setFontCategory(params.id, ids, body.category) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		await requireSeriesAccess(user, params.id);
		return json({ fonts: listFonts(params.id) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
