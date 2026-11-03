import { AsyncLocalStorage } from 'node:async_hooks';
import { desc, eq } from 'drizzle-orm';
import { activity, episodes, series, users } from './db/schema';
import { db, sqlite } from './db';
import { nid, now } from './ids';
import { AI_USER_ID, type ActivityRow } from '../types';

/**
 * Per-request flag set whenever an endpoint writes its own activity entry, so the
 * request hook only adds a generic entry for requests that logged nothing.
 */
const requestLog = new AsyncLocalStorage<{ logged: boolean }>();

export function withRequestLog<T>(run: () => Promise<T>): { result: Promise<T>; logged: () => boolean } {
	const state = { logged: false };
	return { result: requestLog.run(state, run), logged: () => state.logged };
}

export async function logActivity(opts: {
	seriesId?: string | null;
	episodeId?: string | null;
	userId?: string | null;
	action: string;
	payload?: unknown;
}): Promise<ActivityRow> {
	const flag = requestLog.getStore();
	if (flag) flag.logged = true;
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

/** Readable names for actions the request hook records, keyed `<area>:<action>`. */
const ACTION_LABELS: Record<string, string> = {
	'workflow:bubble-fill': 'Bubble fill',
	'workflow:clean': 'Cleaned artwork',
	'workflow:mask': 'Edited cleaning mask',
	'workflow:apply-clean': 'Applied cleaning',
	'workflow:clone-brush': 'Clone brush',
	'workflow:blur-brush': 'Blur brush',
	'workflow:restore-brush': 'Restore brush',
	'workflow:raw-brush': 'Raw brush',
	'workflow:compare-clean': 'Compared cleaning methods',
	'workflow:apply-compare-clean': 'Applied compared clean',
	'workflow:apply-postprocess': 'Changed clean post-processing',
	'workflow:postprocess-default': 'Set default post-processing',
	'workflow:save-cleaning-sample': 'Saved cleaning sample',
	'workflow:text-mask': 'Edited text mask',
	'workflow:geometry': 'Detected region shape',
	'workflow:region': 'Edited region',
	'workflow:split': 'Split region',
	'workflow:merge': 'Merged regions',
	'workflow:fit': 'Fitted region text',
	'workflow:transform-text': 'Transformed text',
	'workflow:typeset-all': 'Typeset',
	'workflow:reset-styles': 'Reset styles',
	'workflow:save-style-as': 'Saved style as region type',
	'workflow:assign-character': 'Assigned character',
	'workflow:page': 'Edited page',
	'workflow:page-undo': 'Undid page change',
	'workflow:page-redo': 'Redid page change',
	'workflow:forget-page-history': 'Cleared page history',
	'workflow:suggestion': 'Decided suggestion',
	'workflow:accept-translation-suggestions': 'Accepted translation suggestions',
	'workflow:approve-all-geometry': 'Approved all geometry',
	'workflow:approve-all-translations': 'Approved all translations',
	'workflow:approve-everything': 'Approved everything',
	'workflow:mark-all-complete': 'Marked all complete',
	'workflow:keep-current-layouts': 'Kept current layouts',
	'workflow:glossary-mine': 'Mined glossary',
	'workflow:glossary-decide': 'Decided glossary terms',
	'workflow:renumber': 'Renumbered pages',
	'workflow:export': 'Exported chapter',
	'workflow:cancel': 'Cancelled job',
	'workflow:retry': 'Retried job',
	'workflow:clear-finished': 'Cleared finished jobs',
	'workflow:clear-all': 'Cleared all jobs',
	'workflow:upload-font': 'Uploaded font',
	'inpaint:post': 'Cleaned text',
	'director:start': 'Started director',
	'director:retry-blocked': 'Retried blocked director steps',
	'director:pause': 'Paused director',
	'director:stop': 'Stopped director',
	'director:resume': 'Resumed director',
	'director:undo': 'Undid director change',
	'director:reset-page': 'Reset director page',
	'psd:post': 'Imported PSD',
	'page-proofread:post': 'Proofread page',
	'region-ai:post': 'Asked region AI',
	'images:put': 'Replaced page image',
	'images:delete': 'Deleted page',
	'pages:post': 'Edited pages',
};

function humanize(words: string): string {
	const text = words.replace(/[_:-]+/g, ' ').trim();
	return text ? text.charAt(0).toUpperCase() + text.slice(1) : words;
}

export function activityLabel(
	action: string,
	payload: string,
	seriesTitle?: string | null,
	episodeTitle?: string | null
): string {
	let parsed: { title?: unknown; page?: unknown; count?: unknown; detail?: unknown } = {};
	try {
		parsed = JSON.parse(payload || '{}');
	} catch {
		parsed = {};
	}
	const label = ACTION_LABELS[action] ?? humanize(action);
	if (action === 'signed_in' || action === 'signed_out') return label;
	const payloadTitle = typeof parsed.title === 'string' ? parsed.title.trim() : '';
	const context = episodeTitle || seriesTitle || payloadTitle;
	const parts = [typeof parsed.detail === 'string' && parsed.detail ? `${label} (${parsed.detail})` : label];
	if (context && context !== label) parts.push(context);
	if (typeof parsed.page === 'number') parts.push(`p. ${parsed.page}`);
	const count = typeof parsed.count === 'number' && parsed.count > 1 ? ` ×${parsed.count}` : '';
	return parts.join(' · ') + count;
}

/** Repeats of one action on one target this close together merge into one entry. */
const COALESCE_MS = 2 * 60 * 1000;

/**
 * Record an action the endpoint did not log itself. A burst of the same action on the
 * same target (a slider saving every second, a run of brush strokes) bumps a count on
 * the latest entry instead of flooding the log.
 */
export async function logRequestActivity(opts: {
	seriesId?: string | null;
	episodeId?: string | null;
	userId: string;
	action: string;
	target: string;
	payload: Record<string, unknown>;
}): Promise<ActivityRow | null> {
	const at = now();
	const last = sqlite
		.prepare('SELECT id, action, episode_id, payload, created_at FROM activity WHERE user_id=? ORDER BY created_at DESC LIMIT 1')
		.get(opts.userId) as { id: string; action: string; episode_id: string | null; payload: string; created_at: number } | undefined;
	if (last && last.action === opts.action && last.episode_id === (opts.episodeId ?? null) && at - last.created_at < COALESCE_MS) {
		let previous: Record<string, unknown> = {};
		try {
			previous = JSON.parse(last.payload || '{}');
		} catch {
			previous = {};
		}
		if (previous.target === opts.target) {
			const count = (typeof previous.count === 'number' ? previous.count : 1) + 1;
			sqlite.prepare('UPDATE activity SET payload=?, created_at=? WHERE id=?')
				.run(JSON.stringify({ ...previous, ...opts.payload, target: opts.target, count }), at, last.id);
			return null;
		}
	}
	return logActivity({ ...opts, payload: { ...opts.payload, target: opts.target } });
}

export type UserActivitySummary = {
	id: string;
	username: string;
	role: string;
	lastSeenAt: number | null;
	lastActionAt: number | null;
	total: number;
	actions: UserActivityItem[];
};

/** Every user with their latest actions, most recently active first. */
export async function listAllUserActivity(limit = 50): Promise<UserActivitySummary[]> {
	const rows = sqlite
		.prepare(
			`SELECT u.id, u.username, u.role,
				(SELECT MAX(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS lastSeenAt,
				(SELECT MAX(created_at) FROM activity a WHERE a.user_id = u.id) AS lastActionAt,
				(SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id) AS total
			FROM users u WHERE u.id != ?`,
		)
		.all(AI_USER_ID) as Omit<UserActivitySummary, 'actions'>[];
	rows.sort((a, b) => Math.max(b.lastActionAt ?? 0, b.lastSeenAt ?? 0) - Math.max(a.lastActionAt ?? 0, a.lastSeenAt ?? 0));
	const out: UserActivitySummary[] = [];
	for (const row of rows) {
		out.push({
			...row,
			actions: await listUserActivity(row.id, limit),
		});
	}
	return out;
}

/** Latest actions first; no limit returns the user's whole history. */
export async function listUserActivity(userId: string, limit?: number): Promise<UserActivityItem[]> {
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
		.limit(limit ?? -1);
	return rows.map((r) => ({
		id: r.id,
		action: r.action,
		label: activityLabel(r.action, r.payload, r.seriesTitle, r.episodeTitle),
		createdAt: r.createdAt
	}));
}
