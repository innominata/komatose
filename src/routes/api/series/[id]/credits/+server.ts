import { json } from '@sveltejs/kit';
import { logActivity } from '$lib/server/activity';
import { fail, messageOf, requireSeriesAccess, requireUpload, requireUser, statusOf } from '$lib/server/http';
import { clearSeriesCredit, saveSeriesCredit } from '$lib/server/seriesCredits';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const s = await requireSeriesAccess(user, params.id);
		requireUpload(user);
		if (request.headers.get('content-type')?.includes('multipart/form-data')) {
			const form = await request.formData();
			const file = form.get('file');
			if (!(file instanceof File) || !file.size) return fail(400, 'Choose a credits image');
			const credits = await saveSeriesCredit(
				s.id,
				form.get('kind'),
				file.name,
				Buffer.from(await file.arrayBuffer()),
				file.type
			);
			await logActivity({
				seriesId: s.id,
				userId: user.id,
				action: 'uploaded_series_credit',
				payload: { kind: String(form.get('kind') || '') }
			});
			return json({ ok: true, credits });
		}
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		if (body.op === 'clear') {
			const credits = await clearSeriesCredit(s.id, body.kind);
			await logActivity({
				seriesId: s.id,
				userId: user.id,
				action: 'cleared_series_credit',
				payload: { kind: String(body.kind || '') }
			});
			return json({ ok: true, credits });
		}
		return fail(400, 'Unknown operation');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
