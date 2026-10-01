import { json } from '@sveltejs/kit';
import { startPageProofread, startPageProofreadFollowUp } from '$lib/server/pageProofread';
import { assertProofreaderGrant } from '$lib/server/proofreadService';
import { isProofreaderId } from '$lib/proofreaders';
import { fail, messageOf, requireEdit, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import { listImages } from '$lib/server/queries';
import { listJobs } from '$lib/server/jobs';
import type { RequestHandler } from './$types';

function pastedImages(raw: unknown): Buffer[] {
	if (!Array.isArray(raw)) return [];
	const out: Buffer[] = [];
	for (const item of raw.slice(0, 8)) {
		if (!item || typeof item !== 'object') continue;
		const rec = item as { data?: unknown };
		const data = String(rec.data || '').replace(/^data:[^;]+;base64,/, '');
		if (!data) continue;
		try {
			const bytes = Buffer.from(data, 'base64');
			if (bytes.length) out.push(bytes);
		} catch {
			/* Skip a malformed paste rather than failing the whole follow-up. */
		}
	}
	return out;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    requireEdit(user);
    const body = await request.json();
    if (isProofreaderId(String(body?.model?.engine || ''))) {
      assertProofreaderGrant(user, String(body.model.engine) as never);
    }
    if (body?.followUpOf) {
      const parent = listJobs(episode.id).find((job) => job.id === body.followUpOf);
      const imageId = String(parent?.payload?.imageId || '');
      if (!imageId || !(await listImages(episode.id)).some((image) => image.id === imageId))
        return fail(404, 'Page not found');
      return json(startPageProofreadFollowUp({
        series,
        episode,
        parentJobId: String(body.followUpOf),
        prompt: String(body.prompt || ''),
        images: pastedImages(body.images),
      }), { status: 202 });
    }
    if (!(await listImages(episode.id)).some(image => image.id === body.imageId)) return fail(404, 'Page not found');
    return json(startPageProofread({ series, episode, imageId: body.imageId, model: body.model }), { status: 202 });
  } catch (error) { return fail(statusOf(error), messageOf(error)); }
};
