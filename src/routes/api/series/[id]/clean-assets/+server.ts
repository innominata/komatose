import { json } from "@sveltejs/kit";
import {
  cleanAssetLibrary,
  saveCleanAsset,
  deleteCleanAsset,
} from "$lib/server/cleanAssets";
import { readAsset } from "$lib/server/workflowStore";
import {
  requireUser,
  requireSeriesAccess,
  requireClean,
  fail,
  statusOf,
  messageOf,
} from "$lib/server/http";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ locals, params, url }) => {
  try {
    await requireSeriesAccess(requireUser(locals.user), params.id);
    const library = cleanAssetLibrary(params.id),
      hash = url.searchParams.get("hash");
    if (hash) {
      if (!library.assets.some((a) => a.hash === hash))
        return fail(404, "Asset not found");
      return new Response(new Uint8Array(await readAsset(hash)), {
        headers: {
          "content-type": "image/png",
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }
    return json(library);
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
export const POST: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    await requireSeriesAccess(user, params.id);
    requireClean(user);
    const form = await request.formData(),
      file = form.get("file");
    if (!(file instanceof File) || !file.size) return fail(400, "Choose a PNG");
    return json(
      await saveCleanAsset(
        params.id,
        file.name,
        Buffer.from(await file.arrayBuffer()),
        Number(form.get("revision")),
        String(form.get("replaceId") || "") || undefined,
      ),
    );
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  try {
    const user = requireUser(locals.user);
    await requireSeriesAccess(user, params.id);
    requireClean(user);
    const b = await request.json();
    return json(deleteCleanAsset(params.id, String(b.id), Number(b.revision)));
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
