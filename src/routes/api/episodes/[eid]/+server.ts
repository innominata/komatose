import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { logActivity } from '$lib/server/activity';
import { db } from '$lib/server/db';
import { episodes } from '$lib/server/db/schema';
import { assertEpisodeIdle, fail, messageOf, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { now } from '$lib/server/ids';
import { setEpisodeTitle } from '$lib/server/episodes';
import { broadcast } from '$lib/server/realtime';
import { EPISODE_STATUSES, type EpisodeStatus } from '$lib/types';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		const body = await request.json();
		assertEpisodeIdle(episode.id);
		const out: {
			status?: string;
			title?: string;
			slug?: string;
			updatedAt: number;
		} = { updatedAt: now() };

		if (typeof body.title === 'string' && body.title.trim()) {
			requireEdit(user);
			const renamed = await setEpisodeTitle({ series, episode, title: body.title });
			out.title = renamed.title;
			out.slug = renamed.slug;
			const entry = await logActivity({
				seriesId: series.id,
				episodeId: episode.id,
				userId: user.id,
				action: 'renamed_episode',
				payload: { from: episode.title, title: renamed.title, slug: renamed.slug }
			});
			broadcast(episode.id, { type: 'activity', entry });
		}

		if (typeof body.status === 'string') {
			if (!EPISODE_STATUSES.includes(body.status)) return fail(400, 'Invalid status');
			out.status = body.status;
			await db
				.update(episodes)
				.set({ status: body.status, updatedAt: out.updatedAt })
				.where(eq(episodes.id, episode.id));
			const entry = await logActivity({
				seriesId: series.id,
				episodeId: episode.id,
				userId: user.id,
				action: 'episode_status',
				payload: { status: body.status }
			});
			broadcast(episode.id, {
				type: 'episode:status',
				status: body.status as EpisodeStatus,
				updatedAt: out.updatedAt
			});
			broadcast(episode.id, { type: 'activity', entry });
		}

		return json({ ok: true, ...out });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
