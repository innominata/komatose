import { json } from "@sveltejs/kit";
import { requireUser, fail, messageOf, statusOf } from "$lib/server/http";
import { fontGlyphs } from "$lib/server/typesetting";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
  try {
    requireUser(locals.user);
    return json(await fontGlyphs(null, params.id), {
      headers: { "cache-control": "private, max-age=3600" },
    });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
