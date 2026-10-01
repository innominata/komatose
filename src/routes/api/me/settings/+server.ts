import { json } from "@sveltejs/kit";
import { readUserSettings, saveUserRegionColors } from "$lib/server/userSettings";
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
    return json(saveUserRegionColors(user.id, body?.regionColors));
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
