import { episodeOwnsAsset, readAsset } from "$lib/server/workflowStore";
import { sqlite } from "$lib/server/db";
import { fail, requireUser, requireEpisodeAccess } from "$lib/server/http";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ locals, params, url }) => {
  const user = requireUser(locals.user);
  const { series, episode } = await requireEpisodeAccess(user, params.eid);
  if (!/^[a-f0-9]{64}$/.test(params.hash)) return fail(404, "Asset not found");
  const font = sqlite
    .prepare(
      "SELECT filename FROM font_assets WHERE series_id=? AND hash=? UNION ALL SELECT filename FROM global_font_assets WHERE hash=?",
    )
    .get(series.id, params.hash, params.hash) as
    { filename: string } | undefined;
  const owned = font || episodeOwnsAsset(episode.id, params.hash);
  if (!owned) return fail(404, "Asset not found");
  const bytes = await readAsset(params.hash);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": font
        ? /otf$/i.test(font.filename)
          ? "font/otf"
          : "font/ttf"
        : url.searchParams.has("download")
          ? "application/zip"
          : "image/png",
      "cache-control": "private, max-age=31536000, immutable",
      ...(url.searchParams.has("download")
        ? {
            "content-disposition": `attachment; filename="${(url.searchParams.get("download") || "chapter.zip").replace(/[^a-zA-Z0-9_.-]/g, "_")}"`,
          }
        : {}),
    },
  });
};
