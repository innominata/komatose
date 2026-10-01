import { json } from '@sveltejs/kit';
import { captureExport, startExport } from '$lib/server/finishedExport';
import { fail, messageOf, requireEpisodeAccess, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** Legacy API uses the same readiness gate and snapshot job as the workflow. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
 try {
  const user = requireUser(locals.user);
  const { episode, series } = await requireEpisodeAccess(user, params.eid);
  const snapshot = await captureExport(series,episode,url.searchParams.get('format') || 'psd',url.searchParams.get('draft') === '1',Number(url.searchParams.get('quality') || 95),url.searchParams.get('includeMetadata') === '1');
  return json({jobId:startExport(snapshot),statusUrl:`/api/episodes/${episode.id}/workflow`},{status:202});
 } catch(e) {return fail(statusOf(e),messageOf(e));}
};
