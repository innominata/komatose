import { json } from "@sveltejs/kit";
import { readUserSettings, saveUserAutoApplyClean, saveUserRegionColors } from "$lib/server/userSettings";
import { fail, messageOf, requireUser, statusOf } from "$lib/server/http";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  try {
    return json(readUserSettings(requireUser(locals.user).id));
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const PUT: RequestHandler = async ({ locals, request }) => {
  try {
    const user = requireUser(locals.user);
    const body = await request.json().catch(() => ({}));
    // Each setting saves only when sent, so one panel never resets another's.
    let saved = readUserSettings(user.id);
    if (body && "regionColors" in body) saved = saveUserRegionColors(user.id, body.regionColors);
    if (body && "autoApplyClean" in body) saved = saveUserAutoApplyClean(user.id, body.autoApplyClean);
    return json(saved);
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
