import { json } from '@sveltejs/kit';
import { receiveSeriesBackup } from '$lib/server/seriesBackups';
import { fail, messageOf, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, request }) => {
  try { return json({ backup: await receiveSeriesBackup(request, requireUser(locals.user)) }); }
  catch (error) { return fail(statusOf(error), messageOf(error)); }
};
