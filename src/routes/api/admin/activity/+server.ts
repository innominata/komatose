import { json } from '@sveltejs/kit';
import { isAdmin } from '$lib/server/access';
import { listAllUserActivity, listUserActivity } from '$lib/server/activity';
import { fail, messageOf, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** Every user's latest 50 actions; `?user=<id>` returns that user's whole history. */
export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		if (!isAdmin(user)) return fail(403, 'Forbidden');
		const one = url.searchParams.get('user');
		if (one) return json({ id: one, actions: await listUserActivity(one) });
		return json({ users: await listAllUserActivity(50) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
