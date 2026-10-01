import { json } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { canEditTranslations } from '$lib/server/access';
import { logActivity } from '$lib/server/activity';
import { isAiUserId } from '$lib/server/aiUser';
import { db } from '$lib/server/db';
import { comments, lines, users } from '$lib/server/db/schema';
import { assertEpisodeIdle, fail, messageOf, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { toComment } from '$lib/server/queries';
import { broadcast } from '$lib/server/realtime';
import type { RequestHandler } from './$types';

async function loadNamed(id: string) {
	const row = await db
		.select({
			id: comments.id,
			revision: comments.revision,
			lineId: comments.lineId,
			userId: comments.userId,
			body: comments.body,
			correction: comments.correction,
			createdAt: comments.createdAt,
			username: users.username
		})
		.from(comments)
		.innerJoin(users, eq(comments.userId, users.id))
		.where(eq(comments.id, id))
		.get();
	if (!row) return null;
	return toComment(row, row.username);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireEdit(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const existing = await db.select().from(comments).where(eq(comments.id, params.cid)).get();
		if (!existing) return fail(404, 'Comment not found');
		const line = await db
			.select()
			.from(lines)
			.where(and(eq(lines.id, existing.lineId), eq(lines.episodeId, episode.id)))
			.get();
		if (!line) return fail(404, 'Comment not found');
		const body = await request.json();
		const patch: { body?: string; correction?: boolean } = {};
		if (typeof body.body === 'string') {
			if(!Number.isInteger(body.expectedRevision))return fail(428,'A base comment revision is required');
			if(body.expectedRevision!==existing.revision)return fail(409,'This comment changed. Your draft is retained.',{current:{...existing}});
			const text = body.body.trim();
			if (!text) return fail(400, 'body required');
			patch.body = text;
		}
		if ('correction' in body) patch.correction = Boolean(body.correction);
		if (!Object.keys(patch).length) return fail(400, 'Nothing to update');
		if (patch.correction) {
			const siblings = await db.select().from(comments).where(eq(comments.lineId, existing.lineId));
			for (const s of siblings) {
				if (s.id === existing.id || !s.correction) continue;
				await db.update(comments).set({ correction: false }).where(eq(comments.id, s.id));
			}
		}
		const updated=await db.update(comments).set(patch).where(and(eq(comments.id,existing.id),eq(comments.revision,existing.revision)));
		if(!updated.changes)return fail(409,'This comment changed during saving');
		const comment = await loadNamed(existing.id);
		if (!comment) return fail(404, 'Comment not found');
		broadcast(episode.id, { type: 'comment:add', comment });
		if (body.log !== false) {
			const entry = await logActivity({
				seriesId: series.id,
				episodeId: episode.id,
				userId: user.id,
				action: patch.correction ? 'pr_correction' : 'updated_comment',
				payload: { lineId: existing.lineId, id: existing.id }
			});
			broadcast(episode.id, { type: 'activity', entry });
		}
		return json({ comment });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const row = await db.select().from(comments).where(eq(comments.id, params.cid)).get();
		if (!row) return fail(404, 'Comment not found');
		if (isAiUserId(row.userId)) {
			if (!canEditTranslations(user)) return fail(403, 'You can only remove your own comments');
		} else if (row.userId !== user.id && user.role !== 'admin') {
			return fail(403, 'You can only remove your own comments');
		}
		const line = await db.select().from(lines).where(and(eq(lines.id, row.lineId), eq(lines.episodeId, episode.id))).get();
		if (!line) return fail(404, 'Comment not found');
		await db.delete(comments).where(eq(comments.id, row.id));
		broadcast(episode.id, { type: 'comment:delete', id: row.id, lineId: row.lineId });
		const entry = await logActivity({
			seriesId: series.id,
			episodeId: episode.id,
			userId: user.id,
			action: 'deleted_comment',
			payload: { lineId: row.lineId, id: row.id }
		});
		broadcast(episode.id, { type: 'activity', entry });
		return json({ ok: true });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
