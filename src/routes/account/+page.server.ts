import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import {
	SESSION_COOKIE,
	destroyUserSessions,
	setPassword,
	verifyPassword
} from '$lib/server/auth';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	return { username: locals.user!.username };
};

export const actions: Actions = {
	default: async ({ request, locals, cookies }) => {
		const user = locals.user!;
		const form = await request.formData();
		const current = String(form.get('current') || '');
		const next = String(form.get('next') || '');
		const confirm = String(form.get('confirm') || '');
		if (next.length < 6) return fail(400, { error: 'New password must be at least 6 characters' });
		if (next !== confirm) return fail(400, { error: 'New passwords do not match' });
		const row = await db.select().from(users).where(eq(users.id, user.id)).get();
		if (!row || !(await verifyPassword(current, row.passwordHash))) {
			return fail(400, { error: 'Current password is wrong' });
		}
		await setPassword(user.id, next);
		await destroyUserSessions(user.id, cookies.get(SESSION_COOKIE));
		return { ok: true };
	}
};
