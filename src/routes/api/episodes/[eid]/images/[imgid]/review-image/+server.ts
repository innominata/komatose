import { capturePageImages } from '$lib/server/pageImages';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    const variant = url.searchParams.get('variant') || 'raw';
    if (!['raw', 'typeset'].includes(variant)) return fail(400, 'Choose raw or typeset');
    const capture = await capturePageImages(series, episode, params.imgid, variant === 'typeset');
    return new Response(new Uint8Array(variant === 'raw' ? capture.raw : capture.typeset!), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store' },
    });
  } catch (error) { return fail(statusOf(error), messageOf(error)); }
};
