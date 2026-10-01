import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireEdit, requireUser, statusOf } from '$lib/server/http';
import { applyModelProfileAction } from '$lib/server/modelProfileStore';
import { ModelProfileError } from '$lib/modelProfiles';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireEdit(requireUser(locals.user));
		return json({ ok: true, ...applyModelProfileAction('list', {}) });
	} catch (e) {
		if (e instanceof ModelProfileError) return fail(400, e.message, { issues: e.issues || [] });
		return fail(statusOf(e), messageOf(e));
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireEdit(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const result = applyModelProfileAction(String(body.action || ''), body);
		return json({ ok: true, ...result });
	} catch (e) {
		if (e instanceof ModelProfileError) {
			return fail(400, e.message, { issues: e.issues || [] });
		}
		return fail(statusOf(e), messageOf(e));
	}
};
