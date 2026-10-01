import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { episodes } from '$lib/server/db/schema';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { makePreviewToken, now } from '$lib/server/ids';
import { getEpisodePreviewToken } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const { episode } = await requireEpisodeAccess(user, params.eid);
		const body = await request.json().catch(() => ({}));
		const rotate = Boolean(body.rotate);
		const revoke = Boolean(body.revoke);

		if (revoke) {
			await db
				.update(episodes)
				.set({ previewToken: null, updatedAt: now() })
				.where(eq(episodes.id, episode.id));
			return json({ token: null });
		}

		let token = await getEpisodePreviewToken(episode.id);
		if (!token || rotate) {
			token = makePreviewToken();
			await db
				.update(episodes)
				.set({ previewToken: token, updatedAt: now() })
				.where(eq(episodes.id, episode.id));
		}
		return json({ token });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
