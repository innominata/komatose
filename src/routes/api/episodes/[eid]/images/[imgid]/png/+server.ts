import { pagePng } from '$lib/server/finishedExport';
import { attachmentFilename } from '$lib/server/export';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    const user = requireUser(locals.user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    const variant = url.searchParams.get('variant');
    if (variant !== 'clean' && variant !== 'typeset') return fail(400, 'Choose clean or typeset');
    const file = await pagePng(series, episode, params.imgid, variant);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'content-type': 'image/png',
        'content-disposition': attachmentFilename(file.filename),
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};
