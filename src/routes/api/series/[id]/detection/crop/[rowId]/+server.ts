import sharp from 'sharp';
import { sqlite } from '$lib/server/db';
import { fail, messageOf, requireSeriesAccess, requireUser, statusOf } from '$lib/server/http';
import { readWorkingOrOrig } from '$lib/server/storage';
import type { RequestHandler } from './$types';

/** A detected region cut from its page, with a little of the page around it, as a small JPEG. */
export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const series = await requireSeriesAccess(requireUser(locals.user), params.id);
		const row = sqlite.prepare(
			`SELECT d.x, d.y, d.w, d.h, e.slug AS episode, i.filename FROM detection_regions d
			 JOIN images i ON i.id = d.image_id JOIN episodes e ON e.id = d.episode_id
			 WHERE d.id=? AND d.series_id=?`,
		).get(params.rowId, series.id) as { x: number; y: number; w: number; h: number; episode: string; filename: string } | undefined;
		if (!row) return fail(404, 'Not found');
		const raw = await readWorkingOrOrig(series.slug, row.episode, row.filename);
		if (!raw) return fail(404, 'Page image is missing');
		const { width = 1, height = 1 } = await sharp(raw).metadata();
		const pad = 0.25;
		const x0 = Math.max(0, Math.floor((row.x - row.w * pad) * width));
		const y0 = Math.max(0, Math.floor((row.y - row.h * pad) * height));
		const x1 = Math.min(width, Math.ceil((row.x + row.w * (1 + pad)) * width));
		const y1 = Math.min(height, Math.ceil((row.y + row.h * (1 + pad)) * height));
		if (x1 <= x0 || y1 <= y0) return fail(404, 'Empty region');
		const jpeg = await sharp(raw)
			.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
			.resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
			.jpeg({ quality: 80 })
			.toBuffer();
		return new Response(new Uint8Array(jpeg), {
			headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' },
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
