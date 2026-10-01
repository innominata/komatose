import { error, fail } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import {
	assignableRoles,
	canAssignRole,
	canGrantSeries,
	canManageAccess,
	canManageTargetUser,
	isAdmin,
	grantTestSeriesAccess,
	isScanlator,
	isTestSeries
} from '$lib/server/access';
import { listSignedInUsers } from '$lib/server/signedIn';
import { createUser, destroyUserSessions, SESSION_COOKIE, setPassword } from '$lib/server/auth';
import { ALL_PROOFREADER_IDS, readUserSettings, saveUserProofreaders } from '$lib/server/userSettings';
import { db } from '$lib/server/db';
import { series, seriesMembers, users } from '$lib/server/db/schema';
import { now } from '$lib/server/ids';
import { AI_USER_ID, ROLES, type Role } from '$lib/types';
import type { Actions, PageServerLoad } from './$types';

function asRole(value: string): Role | null {
	return ROLES.includes(value as Role) ? (value as Role) : null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user || !canManageAccess(locals.user)) error(403, 'Forbidden');
	if (isScanlator(locals.user)) await grantTestSeriesAccess(locals.user.id);
	const allUsers = await db.select().from(users);
	const allSeries = await db.select().from(series);
	const members = await db.select().from(seriesMembers);
	const actor = locals.user;
	const visibleUsers = allUsers.filter((u) => {
		if (u.id === AI_USER_ID) return false;
		if (actor.role === 'admin') return true;
		return u.id === actor.id || canManageTargetUser(actor, u);
	});
	const actorSeriesIds = new Set(
		members.filter((m) => m.userId === actor.id).map((m) => m.seriesId)
	);
	const grantableSeries = allSeries.filter((s) => canGrantSeries(actor, s, actorSeriesIds));
	return {
		users: visibleUsers.map((u) => ({
			id: u.id,
			username: u.username,
			role: u.role,
			createdAt: u.createdAt,
			manageable: canManageTargetUser(actor, u),
			proofreaders: readUserSettings(u.id).proofreaders,
			seriesIds: members.filter((m) => m.userId === u.id).map((m) => m.seriesId)
		})),
		series: grantableSeries.map((s) => ({ id: s.id, title: s.title, test: isTestSeries(s) })),
		roles: assignableRoles(actor),
		proofreaderIds: [...ALL_PROOFREADER_IDS],
		me: actor.id,
		scanlator: isScanlator(actor),
		signedIn: isAdmin(actor) ? await listSignedInUsers() : null
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user || !canManageAccess(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const username = String(form.get('username') || '').trim();
		const password = String(form.get('password') || '');
		const role = asRole(String(form.get('role') || 'typesetter'));
		if (!username || password.length < 6) return fail(400, { error: 'Username and 6+ char password required' });
		if (!role || !canAssignRole(locals.user, role)) return fail(400, { error: 'Invalid role' });
		try {
			const created = await createUser(username, password, role, locals.user.id);
			if (isScanlator(locals.user)) await grantTestSeriesAccess(created.id);
		} catch {
			return fail(400, { error: 'Username already exists' });
		}
		return { ok: true };
	},
	role: async ({ request, locals }) => {
		if (!locals.user || !canManageAccess(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const id = String(form.get('id') || '');
		const role = asRole(String(form.get('role') || ''));
		if (id === locals.user.id) return fail(400, { error: 'Cannot change your own role' });
		if (id === AI_USER_ID) return fail(400, { error: 'Cannot change system user' });
		if (!role || !canAssignRole(locals.user, role)) return fail(400, { error: 'Invalid role' });
		const target = await db.select().from(users).where(eq(users.id, id)).get();
		if (!target) return fail(404, { error: 'User not found' });
		if (!canManageTargetUser(locals.user, target)) return fail(403, { error: 'Forbidden' });
		await db.update(users).set({ role }).where(eq(users.id, id));
		if (role === 'scanlator') await grantTestSeriesAccess(id);
		const { closeSocketsForUser } = await import('$lib/server/realtime');
		closeSocketsForUser(id);
		return { ok: true };
	},
	acl: async ({ request, locals }) => {
		if (!locals.user || !canManageAccess(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const userId = String(form.get('userId') || '');
		const seriesId = String(form.get('seriesId') || '');
		const on = form.get('on') === '1';
		if (!userId || !seriesId) return fail(400, { error: 'Missing ids' });
		if (userId === AI_USER_ID) return fail(400, { error: 'Cannot change system user' });
		const target = await db.select().from(users).where(eq(users.id, userId)).get();
		const row = await db.select().from(series).where(eq(series.id, seriesId)).get();
		if (!target || !row) return fail(404, { error: 'Not found' });
		const actorSeriesIds = isScanlator(locals.user)
			? new Set(
					(
						await db
							.select({ seriesId: seriesMembers.seriesId })
							.from(seriesMembers)
							.where(eq(seriesMembers.userId, locals.user.id))
					).map((m) => m.seriesId)
				)
			: undefined;
		if (!canManageTargetUser(locals.user, target) || !canGrantSeries(locals.user, row, actorSeriesIds)) {
			return fail(403, { error: 'Forbidden' });
		}
		if (on) {
			await db
				.insert(seriesMembers)
				.values({ seriesId, userId, createdAt: now() })
				.onConflictDoNothing();
		} else {
			await db
				.delete(seriesMembers)
				.where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.userId, userId)));
			const { closeSocketsForSeriesUser } = await import('$lib/server/realtime');
			closeSocketsForSeriesUser(seriesId, userId);
		}
		return { ok: true };
	},
	remove: async ({ request, locals }) => {
		if (!locals.user || !canManageAccess(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const id = String(form.get('id') || '');
		if (id === locals.user.id) return fail(400, { error: 'Cannot delete yourself' });
		if (id === AI_USER_ID) return fail(400, { error: 'Cannot delete system user' });
		const target = await db.select().from(users).where(eq(users.id, id)).get();
		if (!target) return fail(404, { error: 'User not found' });
		if (!canManageTargetUser(locals.user, target)) return fail(403, { error: 'Forbidden' });
		const { closeSocketsForUser } = await import('$lib/server/realtime');
		closeSocketsForUser(id);
		await db.delete(users).where(eq(users.id, id));
		return { ok: true };
	},
	proofreaders: async ({ request, locals }) => {
		if (!locals.user || !isAdmin(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const id = String(form.get('id') || '');
		const on = form.get('on') === '1';
		const engine = String(form.get('engine') || '');
		if (!id || !engine) return fail(400, { error: 'Missing user or proofreader' });
		if (id === AI_USER_ID) return fail(400, { error: 'Cannot change system user' });
		if (!ALL_PROOFREADER_IDS.includes(engine as never)) return fail(400, { error: 'Unknown proofreader' });
		const target = await db.select().from(users).where(eq(users.id, id)).get();
		if (!target) return fail(404, { error: 'User not found' });
		const current = new Set(readUserSettings(id).proofreaders);
		if (on) current.add(engine as never);
		else current.delete(engine as never);
		saveUserProofreaders(id, [...current]);
		return { ok: true };
	},
	password: async ({ request, locals, cookies }) => {
		if (!locals.user || !canManageAccess(locals.user)) return fail(403, { error: 'Forbidden' });
		const form = await request.formData();
		const id = String(form.get('id') || '');
		const next = String(form.get('next') || '');
		const confirm = String(form.get('confirm') || '');
		if (!id) return fail(400, { error: 'Missing user' });
		if (id === AI_USER_ID) return fail(400, { error: 'Cannot change system user' });
		if (next.length < 6) return fail(400, { error: 'Password must be at least 6 characters' });
		if (next !== confirm) return fail(400, { error: 'New passwords do not match' });
		const row = await db.select().from(users).where(eq(users.id, id)).get();
		if (!row) return fail(404, { error: 'User not found' });
		if (!canManageTargetUser(locals.user, row) && id !== locals.user.id) {
			return fail(403, { error: 'Forbidden' });
		}
		if (isScanlator(locals.user) && id === locals.user.id) {
			return fail(403, { error: 'Use Account to change your password' });
		}
		await setPassword(id, next);
		const keep = id === locals.user.id ? cookies.get(SESSION_COOKIE) : undefined;
		await destroyUserSessions(id, keep);
		return { ok: true, message: 'Password updated' };
	}
};
