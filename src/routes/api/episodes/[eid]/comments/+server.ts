import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { canEditTranslations } from '$lib/server/access';
import { logActivity } from '$lib/server/activity';
import { db } from '$lib/server/db';
import { comments, lines } from '$lib/server/db/schema';
import { assertEpisodeIdle, fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { nid, now } from '$lib/server/ids';
import { toComment } from '$lib/server/queries';
import { broadcast } from '$lib/server/realtime';
import type { RequestHandler } from './$types';

async function clearOtherCorrections(lineId: string, keepId: string) {
	const siblings = await db.select().from(comments).where(eq(comments.lineId, lineId));
	for (const s of siblings) {
		if (s.id === keepId || !s.correction) continue;
		await db.update(comments).set({ correction: false }).where(eq(comments.id, s.id));
	}
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const body = await request.json();
		const lineId = String(body.lineId || '');
		const text = String(body.body || '').trim();
		if (!lineId || !text) return fail(400, 'lineId and body required');
		const line = await db.select().from(lines).where(eq(lines.id, lineId)).get();
		if (!line || line.episodeId !== episode.id) return fail(404, 'Line not found');
		const correction = Boolean(body.correction);
		if (correction && !canEditTranslations(user)) {
			return fail(403, 'Only proofreaders can mark a PR correction');
		}
		const row = {
			id: nid(),
			lineId,
			userId: user.id,
			body: text,
			correction,
			createdAt: now()
		};
		if (correction) await clearOtherCorrections(lineId, row.id);
		await db.insert(comments).values(row);
		const comment = toComment(row, user.username);
		broadcast(episode.id, { type: 'comment:add', comment });
		const entry = await logActivity({
			seriesId: series.id,
			episodeId: episode.id,
			userId: user.id,
			action: correction ? 'pr_correction' : 'commented',
			payload: { lineId }
		});
		broadcast(episode.id, { type: 'activity', entry });
		return json({ comment });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
