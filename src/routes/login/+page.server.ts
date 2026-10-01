import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/activity';
import {
	cookieOptions,
	createSession,
	isSecureRequest,
	SESSION_COOKIE,
	verifyPassword
} from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import {
	clearLoginFailures,
	dummyPasswordHash,
	loginThrottleKey,
	loginThrottleStatus,
	recordLoginFailure
} from '$lib/server/loginThrottle';
import { AI_USER_ID } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const form = await request.formData();
		const username = String(form.get('username') || '').trim();
		const password = String(form.get('password') || '');
		if (!username || !password) return fail(400, { error: 'Username and password required' });
		const key = loginThrottleKey(username, getClientAddress());
		const throttle = loginThrottleStatus(key);
		if (throttle.blocked) {
			return fail(429, { error: 'Too many sign-in attempts. Try again later.' });
		}
		const row = await db.select().from(users).where(eq(users.username, username)).get();
		const hash = row && row.id !== AI_USER_ID ? row.passwordHash : dummyPasswordHash();
		const ok = await verifyPassword(password, hash);
		if (!row || row.id === AI_USER_ID || !ok) {
			recordLoginFailure(key);
			return fail(400, { error: 'Invalid credentials' });
		}
		clearLoginFailures(key);
		const sid = await createSession(row.id);
		await logActivity({ userId: row.id, action: 'signed_in' });
		cookies.set(SESSION_COOKIE, sid, cookieOptions(isSecureRequest(request)));
		throw redirect(303, '/');
	}
};
