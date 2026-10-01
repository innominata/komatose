import { json } from '@sveltejs/kit';
import type { SessionUser } from './auth';
import { canClean, canEditStickies, canEditTranslations, canFullAi, canManageUsers, canUpload, hasSeriesAccess } from './access';
import { assertEpisodeIdle as assertIdle } from './aiTranslate';
import { getEpisode, getSeries } from './queries';

export function fail(status: number, message: string, extra?: Record<string, unknown>) {
	return json({ error: message, ...extra }, { status });
}

export function requireUser(user: SessionUser | null): SessionUser {
	if (!user) {
		const err = new Error('Unauthorized');
		(err as Error & { status: number }).status = 401;
		throw err;
	}
	return user;
}

export async function requireSeriesAccess(user: SessionUser, seriesId: string) {
	const s = await getSeries(seriesId);
	if (!s) {
		const err = new Error('Series not found');
		(err as Error & { status: number }).status = 404;
		throw err;
	}
	if (!(await hasSeriesAccess(user, seriesId))) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
	return s;
}

export async function requireEpisodeAccess(user: SessionUser, episodeId: string) {
	const ep = await getEpisode(episodeId);
	if (!ep) {
		const err = new Error('Episode not found');
		(err as Error & { status: number }).status = 404;
		throw err;
	}
	const s = await requireSeriesAccess(user, ep.seriesId);
	return { episode: ep, series: s };
}

export function requireEdit(user: SessionUser) {
	if (!canEditTranslations(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function requireUpload(user: SessionUser) {
	if (!canUpload(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function requireFullAi(user: SessionUser) {
	if (!canFullAi(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function requireManageUsers(user: SessionUser) {
	if (!canManageUsers(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function requireClean(user: SessionUser) {
	if (!canClean(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function requireStickies(user: SessionUser) {
	if (!canEditStickies(user)) {
		const err = new Error('Forbidden');
		(err as Error & { status: number }).status = 403;
		throw err;
	}
}

export function assertEpisodeIdle(episodeId: string) {
	assertIdle(episodeId);
}

export function statusOf(e: unknown): number {
	if (e && typeof e === 'object' && 'status' in e && typeof (e as { status: unknown }).status === 'number') {
		return (e as { status: number }).status;
	}
	return 500;
}

export function messageOf(e: unknown): string {
	if (e instanceof Error) return e.message;
	return 'Server error';
}
