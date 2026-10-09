import { assertEngineReady } from '$lib/server/engineReadiness';
import { json } from '@sveltejs/kit';
import { jobSnapshot, startAiProofread } from '$lib/server/aiTranslate';
import { parseTranslateEngine } from '$lib/server/cliTranslate';
import { fail, messageOf, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { parseOcrLang } from '$lib/server/ocr';
import { preferences } from '$lib/server/workflowService';
import { listLines, listImages } from '$lib/server/queries';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		requireEdit(user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		const existing = await listLines(episode.id);
		if (!existing.length) return fail(400, 'No translations to proofread. Run AI translate first.');
		let body: Record<string, unknown> = {};
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			body = {};
		}
        if (body.imageId !== undefined && (typeof body.imageId !== "string" ||
            !(await listImages(episode.id)).some(p => p.id === body.imageId)))
            return fail(404, "Page not found");
		await assertEngineReady(parseTranslateEngine(body.engine));
		const job = startAiProofread({
			imageIds: typeof body.imageId === "string" ? [body.imageId] : undefined,
			series,
			episode,
			user,
			engine: parseTranslateEngine(body.engine),
			lang: parseOcrLang(body.lang ?? preferences(episode.id, series.id).lang),
			model: typeof body.model === 'string' ? body.model : undefined
		});
		return json({ ok: true, job }, { status: 202 });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const { episode } = await requireEpisodeAccess(user, params.eid);
		return json({ job: jobSnapshot(episode.id) });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
