import { desc, eq } from 'drizzle-orm';
import { activity, episodes, series, users } from './db/schema';
import { db } from './db';
import { nid, now } from './ids';
import type { ActivityRow } from '../types';

export async function logActivity(opts: {
	seriesId?: string | null;
	episodeId?: string | null;
	userId?: string | null;
	action: string;
	payload?: unknown;
}): Promise<ActivityRow> {
	const id = nid();
	const createdAt = now();
	const payload = JSON.stringify(opts.payload ?? {});
	await db.insert(activity).values({
		id,
		seriesId: opts.seriesId ?? null,
		episodeId: opts.episodeId ?? null,
		userId: opts.userId ?? null,
		action: opts.action,
		payload,
		createdAt
	});
	let username: string | null = null;
	if (opts.userId) {
		const u = await db.select({ username: users.username }).from(users).where(eq(users.id, opts.userId)).get();
		username = u?.username ?? null;
	}
	return {
		id,
		seriesId: opts.seriesId ?? null,
		episodeId: opts.episodeId ?? null,
		userId: opts.userId ?? null,
		username,
		action: opts.action,
		payload,
		createdAt
	};
}

export async function listActivity(episodeId: string, limit = 80): Promise<ActivityRow[]> {
	const rows = await db
		.select({
			id: activity.id,
			seriesId: activity.seriesId,
			episodeId: activity.episodeId,
			userId: activity.userId,
			username: users.username,
			action: activity.action,
			payload: activity.payload,
			createdAt: activity.createdAt
		})
		.from(activity)
		.leftJoin(users, eq(activity.userId, users.id))
		.where(eq(activity.episodeId, episodeId))
		.orderBy(desc(activity.createdAt))
		.limit(limit);
	return rows.map((r) => ({
		...r,
		username: r.username ?? null
	}));
}

export type UserActivityItem = {
	id: string;
	action: string;
	label: string;
	createdAt: number;
};

export function activityLabel(
	action: string,
	payload: string,
	seriesTitle?: string | null,
	episodeTitle?: string | null
): string {
	const words = action.replace(/_/g, ' ').trim();
	const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
	if (action === 'signed_in' || action === 'signed_out') return label;
	let payloadTitle = '';
	try {
		const parsed = JSON.parse(payload || '{}') as { title?: unknown };
		if (typeof parsed.title === 'string' && parsed.title.trim()) payloadTitle = parsed.title.trim();
	} catch {
		payloadTitle = '';
	}
	const context = episodeTitle || seriesTitle || payloadTitle;
	if (context && context !== label) return `${label} · ${context}`;
	return label;
}

export async function listUserActivity(userId: string, limit = 20): Promise<UserActivityItem[]> {
	const rows = await db
		.select({
			id: activity.id,
			action: activity.action,
			payload: activity.payload,
			createdAt: activity.createdAt,
			seriesTitle: series.title,
			episodeTitle: episodes.title
		})
		.from(activity)
		.leftJoin(series, eq(activity.seriesId, series.id))
		.leftJoin(episodes, eq(activity.episodeId, episodes.id))
		.where(eq(activity.userId, userId))
		.orderBy(desc(activity.createdAt))
		.limit(limit);
	return rows.map((r) => ({
		id: r.id,
		action: r.action,
		label: activityLabel(r.action, r.payload, r.seriesTitle, r.episodeTitle),
		createdAt: r.createdAt
	}));
}
