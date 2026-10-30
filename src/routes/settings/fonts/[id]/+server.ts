import { json } from "@sveltejs/kit";
import {
  requireUser,
  requireClean,
  fail,
  messageOf,
  statusOf,
} from "$lib/server/http";
import { deleteFont, listFonts } from "$lib/server/typesetting";
import { WorkflowError } from "$lib/server/workflowStore";
import { fontFileResponse } from "$lib/server/fontDownloads";
import type { RequestHandler } from "./$types";

/** `?download=1` saves the file under its uploaded name. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
  requireUser(locals.user);
  const font = listFonts(null).find((f) => f.id === params.id);
  if (!font) return fail(404, "Font not found");
  return fontFileResponse(font, url.searchParams.get("download") === "1");
};

/** `?force=1` also clears the font from styles that still use it. */
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
  try {
    requireClean(requireUser(locals.user));
    const result = deleteFont(null, params.id, url.searchParams.get("force") === "1");
    return json({ ok: true, ...result, fonts: listFonts(null) });
  } catch (e) {
    const usage = e instanceof WorkflowError ? (e.current as { usage?: unknown } | undefined)?.usage : undefined;
    return fail(statusOf(e), messageOf(e), usage ? { usage } : undefined);
  }
};
