import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { loadSetupReport } from '$lib/server/setupLive';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		return json({ ok: true, report: await loadSetupReport() });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
