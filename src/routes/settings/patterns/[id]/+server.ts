import { json } from "@sveltejs/kit";
import { requireUser, requireClean, fail, messageOf, statusOf } from "$lib/server/http";
import { deletePattern, getPattern, listPatterns, renamePattern } from "$lib/server/patterns";
import { readAsset, WorkflowError } from "$lib/server/workflowStore";
import type { RequestHandler } from "./$types";

/** The stored tile (patterns never change under an id, so it caches for good). */
export const GET: RequestHandler = async ({ locals, params }) => {
  requireUser(locals.user);
  const pattern = getPattern(params.id);
  if (!pattern) return fail(404, "Pattern not found");
  return new Response(new Uint8Array(await readAsset(pattern.hash)), {
    headers: { "content-type": pattern.mime, "cache-control": "private, max-age=31536000, immutable" },
  });
};

/** Body: `{ name }`. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  try {
    requireClean(requireUser(locals.user));
    const body = await request.json();
    return json({ ok: true, patterns: renamePattern(params.id, String(body.name ?? "")) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};

/** `?force=1` also clears the pattern from styles that still use it. */
export const DELETE: RequestHandler = async ({ locals, params, url }) => {
  try {
    requireClean(requireUser(locals.user));
    const result = deletePattern(params.id, url.searchParams.get("force") === "1");
    return json({ ok: true, ...result, patterns: listPatterns() });
  } catch (e) {
    const usage = e instanceof WorkflowError ? (e.current as { usage?: unknown } | undefined)?.usage : undefined;
    return fail(statusOf(e), messageOf(e), usage ? { usage } : undefined);
  }
};
