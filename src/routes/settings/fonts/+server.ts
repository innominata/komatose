import { json } from "@sveltejs/kit";
import {
  requireUser,
  requireClean,
  fail,
  messageOf,
  statusOf,
} from "$lib/server/http";
import { listFonts, setFontCategory } from "$lib/server/typesetting";
import type { RequestHandler } from "./$types";

/** Body: `{ ids: string[], category }`. Files every listed shared font under the category. */
export const PATCH: RequestHandler = async ({ locals, request }) => {
  try {
    requireClean(requireUser(locals.user));
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return json({ ok: true, fonts: setFontCategory(null, ids, body.category) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

export const GET: RequestHandler = ({ locals }) => {
  requireUser(locals.user);
  return json({ fonts: listFonts(null) });
};
