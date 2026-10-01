import { and, eq, gt } from 'drizzle-orm';
import { AI_USER_ID, type Role } from '../types';
import { listUserActivity, type UserActivityItem } from './activity';
import { db } from './db';
import { sessions, users } from './db/schema';
import { now } from './ids';

/** A session counts as signed in if it was touched within this window. */
export const SIGNED_IN_MS = 15 * 60 * 1000;

export type SignedInUser = {
	id: string;
	username: string;
	role: Role;
	lastSeenAt: number;
	actions: UserActivityItem[];
};

export async function listSignedInUsers(at = now()): Promise<SignedInUser[]> {
	const rows = await db
		.select({
			id: users.id,
			username: users.username,
			role: users.role,
			lastSeenAt: sessions.lastSeenAt
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(and(gt(sessions.expiresAt, at), gt(sessions.lastSeenAt, at - SIGNED_IN_MS)));
	const latest = new Map<string, (typeof rows)[number]>();
	for (const row of rows) {
		if (row.id === AI_USER_ID) continue;
		const prev = latest.get(row.id);
		if (!prev || row.lastSeenAt > prev.lastSeenAt) latest.set(row.id, row);
	}
	const usersOnline = [...latest.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	const out: SignedInUser[] = [];
	for (const row of usersOnline) {
		out.push({
			id: row.id,
			username: row.username,
			role: row.role as Role,
			lastSeenAt: row.lastSeenAt,
			actions: await listUserActivity(row.id, 20)
		});
	}
	return out;
}
