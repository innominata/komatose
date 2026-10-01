import { json } from '@sveltejs/kit';
import { logActivity } from '$lib/server/activity';
import { db } from '$lib/server/db';
import { lines } from '$lib/server/db/schema';
import { assertEpisodeIdle, fail, messageOf, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { nid, now } from '$lib/server/ids';
import { parseTranslation } from '$lib/parser';
import { listImages, listLines, toLine } from '$lib/server/queries';
import { broadcast } from '$lib/server/realtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireEdit(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const body = await request.json();
		const text = String(body.text || '');
		if (!text.trim()) return fail(400, 'Empty script');
		const parsed = parseTranslation(text);
		const imgs = await listImages(episode.id);
		const existing = await listLines(episode.id);
		const created = [];
		const t = now();
		for (let i = 0; i < parsed.lines.length; i++) {
			const item = parsed.lines[i];
			const image = item.page ? imgs[item.page - 1] : undefined;
			const row = {
				id: nid(),
				episodeId: episode.id,
				imageId: image?.id ?? null,
				body: item.body,
				lineType: item.lineType,
				status: 'none' as const,
				placed: false,
				x: null,
				y: null,
				w: null,
				h: null,
				sidebarX: null,
				sidebarY: null,
				sidebarW: 0.92,
				sidebarH: 0.12,
				sortOrder: existing.length + i,
				createdBy: user.id,
				updatedBy: user.id,
				updatedAt: t
			};
			await db.insert(lines).values(row);
			const line = toLine(row);
			created.push(line);
			broadcast(episode.id, { type: 'line:upsert', line });
		}
		const entry = await logActivity({
			seriesId: series.id,
			episodeId: episode.id,
			userId: user.id,
			action: 'imported_script',
			payload: { count: created.length, hasPages: parsed.hasPages }
		});
		broadcast(episode.id, { type: 'activity', entry });
		return json({ lines: created, hasPages: parsed.hasPages });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
