import { json } from "@sveltejs/kit";
import { fail, messageOf, requireClean, requireEpisodeAccess, requireUser, statusOf } from "$lib/server/http";
import { listImages } from "$lib/server/queries";
import { getDoc, readAsset } from "$lib/server/workflowStore";
import { readWorkingOrOrig } from "$lib/server/storage";
import { listPatterns, samplePattern } from "$lib/server/patterns";
import { pageArtwork, type PageData } from "$lib/workflow";
import type { RequestHandler } from "./$types";

/**
 * Body: `{ imageId, box: [x, y, w, h] (fractions of the page), whole? }`. Samples a pattern
 * from the artwork Typeset shows (the cleaned page when it matches the current image).
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    requireClean(user);
    const { series, episode } = await requireEpisodeAccess(user, params.eid);
    const b = await request.json();
    const box = Array.isArray(b.box) ? b.box.map(Number) : [];
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0)
      return fail(400, "Drag an area of the page to sample");
    const images = await listImages(episode.id);
    const img = images.find((p) => p.id === b.imageId);
    if (!img) return fail(404, "Page not found");
    const pageDoc = getDoc<PageData>(`page:${img.id}`, {});
    const prepared = pageDoc.data.preparedAt === img.updatedAt ? pageArtwork(pageDoc.data) : undefined;
    const artwork = prepared ? await readAsset(prepared) : await readWorkingOrOrig(series.slug, episode.slug, img.filename);
    if (!artwork) return fail(404, "Missing page image");
    const result = await samplePattern(artwork, { x: box[0], y: box[1], w: box[2], h: box[3] }, {
      whole: b.whole === true,
      label: `Page ${img.pageNumber ?? images.indexOf(img) + 1}`,
    });
    return json({ ...result, ...("pattern" in result ? { patterns: listPatterns() } : {}) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
