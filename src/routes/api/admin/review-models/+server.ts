import { startPackageOperation } from '$lib/server/modelSupervisor';
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  fail,
  messageOf,
  requireManageUsers,
  requireUser,
  statusOf,
} from "$lib/server/http";
import {
  listReviewServerStatuses,
  operateReviewServer,
} from "$lib/server/localReview";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    return json({ ok: true, models: await listReviewServerStatuses() });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    requireManageUsers(requireUser(locals.user));
    const body = await request.json();
    if (!["start", "stop", "restart"].includes(body.action))
      return fail(400, "Choose Start, Stop, or Restart");
    const result = startPackageOperation(String(body.id || ""), body.action);
    return json({ ok: true, ...result }, { status: 202 });
  } catch (error) {
    return fail(statusOf(error), messageOf(error));
  }
};
