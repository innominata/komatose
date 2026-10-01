import { json } from "@sveltejs/kit";
import {
  requireUser,
  requireClean,
  fail,
  messageOf,
  statusOf,
} from "$lib/server/http";
import { deleteFont, listFonts } from "$lib/server/typesetting";
import { readAsset, WorkflowError } from "$lib/server/workflowStore";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, params }) => {
  requireUser(locals.user);
  const font = listFonts(null).find((f) => f.id === params.id);
  if (!font) return fail(404, "Font not found");
  return new Response(new Uint8Array(await readAsset(font.hash)), {
    headers: {
      "content-type": font.format === "OTF" ? "font/otf" : "font/ttf",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
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
