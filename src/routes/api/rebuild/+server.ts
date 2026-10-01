import { json } from "@sveltejs/kit";
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from "$lib/server/http";
import { rebuildStatus, startRebuild } from "$lib/server/rebuild";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    return json(await rebuildStatus());
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const POST: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    return json(await startRebuild(), { status: 202 });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
