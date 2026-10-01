import sharp from 'sharp';
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { episodes, images, series } from '$lib/server/db/schema';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { imagePath, origImagePath, sniffMime } from '$lib/server/storage';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const img = await db.select().from(images).where(eq(images.id, params.id)).get();
		if (!img) return fail(404, 'Not found');
		await requireEpisodeAccess(user, img.episodeId);
		const ep = await db.select().from(episodes).where(eq(episodes.id, img.episodeId)).get();
		const s = ep ? await db.select().from(series).where(eq(series.id, ep.seriesId)).get() : null;
		if (!ep || !s) return fail(404, 'Not found');
		const working = imagePath(s.slug, ep.slug, img.filename);
		const orig = origImagePath(s.slug, ep.slug, img.filename);
		const path = existsSync(working) ? working : existsSync(orig) ? orig : null;
		if (!path) return fail(404, 'Missing image file');
		const st = await stat(path);
		const format = (await sharp(path).metadata()).format;
		const stream = createReadStream(path);
		return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
			headers: {
				'content-type': format ? `image/${format}` : sniffMime(img.filename),
				'content-length': String(st.size),
				'cache-control': 'private, no-cache'
			}
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
