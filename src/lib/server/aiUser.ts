import { randomBytes } from 'node:crypto';
import { eq, like, or } from 'drizzle-orm';
import { AI_USER_ID, AI_USERNAME, type PublicUser } from '../types';
import { hashPassword } from './auth';
import { db } from './db';
import { comments, users } from './db/schema';
import { now } from './ids';

export { AI_USER_ID, AI_USERNAME };

export function isAiUserId(id: string): boolean {
	return id === AI_USER_ID;
}

function toUser(row: { id: string; username: string; role: string }): PublicUser {
	return { id: row.id, username: row.username, role: row.role as PublicUser['role'] };
}

let ready: Promise<PublicUser> | null = null;

async function bootstrapAiUser(): Promise<PublicUser> {
	let row = await db.select().from(users).where(eq(users.id, AI_USER_ID)).get();
	if (!row) {
		await db.insert(users).values({
			id: AI_USER_ID,
			username: AI_USERNAME,
			passwordHash: await hashPassword(randomBytes(32).toString('hex')),
			role: 'translator',
			createdAt: now()
		});
		row = await db.select().from(users).where(eq(users.id, AI_USER_ID)).get();
	} else if (row.username !== AI_USERNAME) {
		await db.update(users).set({ username: AI_USERNAME }).where(eq(users.id, AI_USER_ID));
		row = { ...row, username: AI_USERNAME };
	}
	await db
		.update(comments)
		.set({ userId: AI_USER_ID })
		.where(
			or(
				like(comments.body, 'Source: %'),
				like(comments.body, 'Note: %'),
				like(comments.body, 'Literal: %')
			)
		);
	return toUser(row!);
}

/** Ensure the non-login AI/OCR user exists, then retag OCR/Qwen notes onto it. */
export function ensureAiUser(): Promise<PublicUser> {
	if (!ready) {
		ready = bootstrapAiUser().catch((err) => {
			ready = null;
			throw err;
		});
	}
	return ready;
}
