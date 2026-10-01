import { and, eq } from 'drizzle-orm';
import {
	AI_USER_ID,
	ROLES,
	STAFF_ROLES,
	TEST_SERIES_SLUG,
	TEST_SERIES_TITLE,
	type Role
} from '../types';
import type { SessionUser } from './auth';
import { db } from './db';
import { series, seriesMembers } from './db/schema';
import { nid, now } from './ids';

export function isAdmin(user: SessionUser): boolean {
	return user.role === 'admin';
}

export function isScanlator(user: SessionUser): boolean {
	return user.role === 'scanlator';
}

export function isStaffRole(role: Role): boolean {
	return (STAFF_ROLES as readonly string[]).includes(role);
}

export function isPrivilegedRole(role: Role): boolean {
	return role === 'admin' || role === 'scanlator';
}

/** Backend services, billed model setup, rebuild, and creating privileged accounts. */
export function canManageUsers(user: SessionUser): boolean {
	return isAdmin(user);
}

/** Users & series ACL page. Scanlators invite staff onto series they can access. */
export function canManageAccess(user: SessionUser): boolean {
	return isAdmin(user) || isScanlator(user);
}

export function canCreateSeries(user: SessionUser): boolean {
	return isAdmin(user) || isScanlator(user);
}

export function canUpload(user: SessionUser): boolean {
	return isAdmin(user) || isScanlator(user) || user.role === 'translator';
}

export function canEditTranslations(user: SessionUser): boolean {
	return (
		isAdmin(user) ||
		isScanlator(user) ||
		user.role === 'translator' ||
		user.role === 'proofreader'
	);
}

export function canFullAi(user: SessionUser): boolean {
	return canUpload(user);
}

export function canClean(user: SessionUser): boolean {
	return isAdmin(user) || isScanlator(user) || user.role === 'translator' || user.role === 'typesetter';
}

export function canEditStickies(user: SessionUser): boolean {
	return (
		isAdmin(user) ||
		isScanlator(user) ||
		user.role === 'translator' ||
		user.role === 'proofreader' ||
		user.role === 'typesetter'
	);
}

export function canComment(user: SessionUser): boolean {
	return true;
}

export function assignableRoles(actor: SessionUser): Role[] {
	if (isAdmin(actor)) return [...ROLES];
	if (isScanlator(actor)) return [...STAFF_ROLES];
	return [];
}

export function canAssignRole(actor: SessionUser, role: Role): boolean {
	return assignableRoles(actor).includes(role);
}

export function canManageTargetUser(
	actor: SessionUser,
	target: { id: string; role: string; createdBy?: string | null }
): boolean {
	if (target.id === AI_USER_ID) return false;
	if (isAdmin(actor)) return true;
	if (!isScanlator(actor)) return false;
	return target.createdBy === actor.id && isStaffRole(target.role as Role);
}

export function isTestSeries(row: { title: string; slug?: string | null }): boolean {
	return row.title === TEST_SERIES_TITLE || row.slug === TEST_SERIES_SLUG;
}

export function canGrantSeries(
	actor: SessionUser,
	row: { id?: string; title: string; slug?: string | null; createdBy?: string | null },
	memberSeriesIds?: ReadonlySet<string>
): boolean {
	if (isAdmin(actor)) return true;
	if (!isScanlator(actor)) return false;
	if (isTestSeries(row) || row.createdBy === actor.id) return true;
	return Boolean(row.id && memberSeriesIds?.has(row.id));
}

export async function hasSeriesAccess(user: SessionUser, seriesId: string): Promise<boolean> {
	if (isAdmin(user)) return true;
	const row = await db
		.select()
		.from(seriesMembers)
		.where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.userId, user.id)))
		.get();
	return Boolean(row);
}

export async function grantSeriesMembership(seriesId: string, userId: string): Promise<void> {
	await db
		.insert(seriesMembers)
		.values({ seriesId, userId, createdAt: now() })
		.onConflictDoNothing();
}

export async function ensureTestSeries(): Promise<{ id: string; title: string; slug: string }> {
	const bySlug = await db.select().from(series).where(eq(series.slug, TEST_SERIES_SLUG)).get();
	if (bySlug) return { id: bySlug.id, title: bySlug.title, slug: bySlug.slug };
	const byTitle = await db.select().from(series).where(eq(series.title, TEST_SERIES_TITLE)).get();
	if (byTitle) return { id: byTitle.id, title: byTitle.title, slug: byTitle.slug };
	const id = nid();
	const t = now();
	await db.insert(series).values({
		id,
		slug: TEST_SERIES_SLUG,
		title: TEST_SERIES_TITLE,
		notes: 'Shared testing area.',
		glossary: '[]',
		createdBy: null,
		createdAt: t,
		updatedAt: t
	});
	return { id, title: TEST_SERIES_TITLE, slug: TEST_SERIES_SLUG };
}

export async function grantTestSeriesAccess(userId: string): Promise<void> {
	const test = await ensureTestSeries();
	await grantSeriesMembership(test.id, userId);
}

export function assertRole(user: SessionUser, allowed: Role[]): void {
	if (!allowed.includes(user.role)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}
