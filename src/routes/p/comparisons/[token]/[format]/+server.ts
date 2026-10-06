import { sharedComparisonResponse } from '$lib/server/sharedComparison';
import { fail, messageOf, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  try {
    return await sharedComparisonResponse(params.token, params.format);
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
