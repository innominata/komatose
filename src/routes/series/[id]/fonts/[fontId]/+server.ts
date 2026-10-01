import { json } from '@sveltejs/kit';
import { requireUser, requireSeriesAccess, fail, messageOf, statusOf } from '$lib/server/http';
import { canClean, canUpload } from '$lib/server/access';
import { logActivity } from '$lib/server/activity';
import { deleteFont, listFonts } from '$lib/server/typesetting';
import { readAsset, WorkflowError } from '$lib/server/workflowStore';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals.user);
	await requireSeriesAccess(user, params.id);
	const font = listFonts(params.id).find((f) => f.id === params.fontId);
	if (!font) return fail(404, 'Font not found');
	return new Response(new Uint8Array(await readAsset(font.hash)), {
		headers: {
			'content-type': font.format === 'OTF' ? 'font/otf' : 'font/ttf',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};

/** Removes a font owned by this series. Shared-library fonts are removed in Settings. `?force=1` clears styles that still use it. */
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	try {
		const user = requireUser(locals.user);
		await requireSeriesAccess(user, params.id);
		if (!canUpload(user) && !canClean(user)) return fail(403, 'Forbidden');
		const result = deleteFont(params.id, params.fontId, url.searchParams.get('force') === '1');
		await logActivity({
			seriesId: params.id,
			userId: user.id,
			action: 'removed_series_font',
			payload: { fontId: params.fontId }
		});
		return json({ ok: true, ...result, fonts: listFonts(params.id) });
	} catch (e) {
		const usage = e instanceof WorkflowError ? (e.current as { usage?: unknown } | undefined)?.usage : undefined;
		return fail(statusOf(e), messageOf(e), usage ? { usage } : undefined);
	}
};
