import { redirect } from '@sveltejs/kit';
import { logActivity } from '$lib/server/activity';
import { destroySession, SESSION_COOKIE } from '$lib/server/auth';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async ({ cookies, locals }) => {
		if (locals.user) await logActivity({ userId: locals.user.id, action: 'signed_out' });
		const sid = cookies.get(SESSION_COOKIE);
		if (sid) await destroySession(sid);
		cookies.delete(SESSION_COOKIE, { path: '/' });
		throw redirect(303, '/login');
	}
};
