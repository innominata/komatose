import { json } from "@sveltejs/kit";
import { inpaintRegion, undoInpaint } from "$lib/server/inpaint";
import { parsePoly } from "$lib/server/ocr";
import {
  assertEpisodeIdle,
  fail,
  messageOf,
  requireClean,
  requireEpisodeAccess,
  requireUser,
  statusOf,
} from "$lib/server/http";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    requireClean(user);
    const { episode, series } = await requireEpisodeAccess(user, params.eid);
    assertEpisodeIdle(episode.id);
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const imageId = String(body.imageId || "");
    if (!imageId) return fail(400, "imageId required");
    if (body.undo) {
      const result = await undoInpaint({ series, episode, user, imageId });
      return json({ ok: true, ...result });
    }
    return fail(
      409,
      "Cleaning now uses reviewed masks and separate lossless artwork. Open the Clean step to continue.",
      { workflowUrl: `/series/${series.id}/episodes/${episode.id}?step=Clean` },
    );
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
