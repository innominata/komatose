import { json } from '@sveltejs/kit';
import { assertEpisodeIdle, fail, messageOf, requireEpisodeAccess, requireUpload, requireUser, statusOf } from '$lib/server/http';
import { replaceImage } from '$lib/server/replaceImage';
import { deletePages } from '$lib/server/pageSelection';
import type { RequestHandler } from './$types';

/** Replace the raw in place from an uploaded PSD (flattened) or image. Undo via Prepare's page-edit stack. */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireUpload(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const form = await request.formData();
		const file = form.get('file');
		if (!(file instanceof File) || !file.size) return fail(400, 'No file');
		const result = await replaceImage({
			series,
			episode,
			user,
			imageId: params.imgid,
			bytes: Buffer.from(await file.arrayBuffer()),
			name: file.name
		});
		return json({ ok: true, ...result });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		requireUpload(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		await deletePages({ series, episode, user }, [params.imgid]);
		return json({ ok: true });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
