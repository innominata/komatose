import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { AI_USER_ID, AI_USERNAME, type PublicUser, type Role } from '../types';
import { db } from './db';
import { sessions, users } from './db/schema';
import { nid, now } from './ids';

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = 'scan_session';
const SESSION_MS = 1000 * 60 * 60 * 24 * 30;
/** Skip rewriting last_seen_at when the session was touched this recently. */
export const SESSION_TOUCH_MS = 30_000;

export type SessionUser = PublicUser;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = (await scryptAsync(password, salt, 64)) as Buffer;
	return `${salt.toString('hex')}:${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex) return false;
	const salt = Buffer.from(saltHex, 'hex');
	const key = Buffer.from(keyHex, 'hex');
	const test = (await scryptAsync(password, salt, 64)) as Buffer;
	if (test.length !== key.length) return false;
	return timingSafeEqual(test, key);
}

export async function createSession(userId: string): Promise<string> {
	const id = randomBytes(32).toString('hex');
	const t = now();
	await db.insert(sessions).values({
		id,
		userId,
		expiresAt: t + SESSION_MS,
		lastSeenAt: t
	});
	return id;
}

async function closeRealtimeSession(sessionId: string) {
	const { closeSocketsForSession } = await import('./realtime');
	closeSocketsForSession(sessionId);
}

async function closeRealtimeUser(userId: string) {
	const { closeSocketsForUser } = await import('./realtime');
	closeSocketsForUser(userId);
}

export async function destroySession(id: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, id));
	await closeRealtimeSession(id);
}

export async function userCount(): Promise<number> {
	const rows = await db.select({ id: users.id }).from(users);
	return rows.filter((u) => u.id !== AI_USER_ID).length;
}

export async function getUserBySession(sessionId: string | undefined): Promise<SessionUser | null> {
	if (!sessionId) return null;
	const row = await db
		.select({
			id: users.id,
			username: users.username,
			role: users.role,
			expiresAt: sessions.expiresAt,
			lastSeenAt: sessions.lastSeenAt
		})
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, sessionId))
		.get();
	if (!row) return null;
	const t = now();
	if (row.expiresAt < t) {
		await destroySession(sessionId);
		return null;
	}
	if (row.id === AI_USER_ID) {
		await destroySession(sessionId);
		return null;
	}
	if (t - (row.lastSeenAt || 0) >= SESSION_TOUCH_MS) {
		await db.update(sessions).set({ lastSeenAt: t }).where(eq(sessions.id, sessionId));
	}
	return { id: row.id, username: row.username, role: row.role as Role };
}

export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const idx = part.indexOf('=');
		if (idx === -1) continue;
		const k = part.slice(0, idx).trim();
		const v = part.slice(idx + 1).trim();
		try {
			out[k] = decodeURIComponent(v);
		} catch {
			out[k] = v;
		}
	}
	return out;
}

export async function getUserFromCookieHeader(header: string | undefined): Promise<SessionUser | null> {
	const cookies = parseCookies(header);
	return getUserBySession(cookies[SESSION_COOKIE]);
}

export function cookieOptions(secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		sameSite: 'lax' as const,
		secure,
		maxAge: SESSION_MS / 1000
	};
}

export function isSecureRequest(request: Request): boolean {
	const proto = request.headers.get('x-forwarded-proto');
	if (proto) return proto.split(',')[0].trim() === 'https';
	return new URL(request.url).protocol === 'https:';
}

export async function setPassword(userId: string, password: string): Promise<void> {
	await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId));
}

export async function destroyUserSessions(userId: string, exceptId?: string): Promise<void> {
	const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
	for (const row of rows) {
		if (exceptId && row.id === exceptId) continue;
		await destroySession(row.id);
	}
	if (!exceptId) await closeRealtimeUser(userId);
}
export class AlreadyInitializedError extends Error {
	status = 409;
	constructor() {
		super('Already initialized');
	}
}

function assertCreatableUsername(username: string): string {
	const trimmed = username.trim();
	if (trimmed.toLowerCase() === AI_USERNAME.toLowerCase() || trimmed.toLowerCase() === AI_USER_ID) {
		throw new Error('Reserved username');
	}
	return trimmed;
}

export async function createUser(
	username: string,
	password: string,
	role: Role,
	createdBy?: string | null
) {
	const trimmed = assertCreatableUsername(username);
	const id = nid();
	await db.insert(users).values({
		id,
		username: trimmed,
		passwordHash: await hashPassword(password),
		role,
		createdBy: createdBy || null,
		createdAt: now()
	});
	if (role === 'scanlator') {
		const { grantTestSeriesAccess } = await import('./access');
		await grantTestSeriesAccess(id);
	}
	return { id, username: trimmed, role };
}

/** First-run administrator. Rechecks emptiness and inserts in one SQLite transaction. */
export async function createFirstAdmin(username: string, password: string) {
	const trimmed = assertCreatableUsername(username);
	const passwordHash = await hashPassword(password);
	const id = nid();
	const createdAt = now();
	const { sqlite } = await import('./db');
	sqlite.transaction(() => {
		const count = sqlite
			.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ?")
			.get(AI_USER_ID) as { n: number };
		if (count.n > 0) throw new AlreadyInitializedError();
		sqlite
			.prepare(
				"INSERT INTO users(id, username, password_hash, role, created_by, settings, created_at) VALUES(?,?,?,?,?,?,?)",
			)
			.run(id, trimmed, passwordHash, "admin", null, "{}", createdAt);
	})();
	return { id, username: trimmed, role: "admin" as const };
}

/** Stable color seed for presence chips. */
export function userHue(id: string): number {
	const hex = createHash('sha1').update(id).digest('hex').slice(0, 6);
	return parseInt(hex, 16) % 360;
}
