import { fail, redirect } from '@sveltejs/kit';
import {
	AlreadyInitializedError,
	cookieOptions,
	createFirstAdmin,
	createSession,
	isSecureRequest,
	SESSION_COOKIE,
	userCount
} from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	if ((await userCount()) > 0) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const username = String(form.get('username') || '').trim();
		const password = String(form.get('password') || '');
		if (username.length < 2) return fail(400, { error: 'Username too short' });
		if (password.length < 6) return fail(400, { error: 'Password must be at least 6 characters' });
		try {
			const user = await createFirstAdmin(username, password);
			const sid = await createSession(user.id);
			cookies.set(SESSION_COOKIE, sid, cookieOptions(isSecureRequest(request)));
		} catch (e) {
			if (e instanceof AlreadyInitializedError) return fail(409, { error: 'Already initialized' });
			return fail(400, { error: e instanceof Error ? e.message : 'Could not create administrator' });
		}
		// A brand-new install has nothing configured, so land on the Setup checklist
		// rather than an empty library.
		throw redirect(303, '/admin/setup');
	}
};
