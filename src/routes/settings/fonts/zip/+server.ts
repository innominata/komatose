import { requireUser } from "$lib/server/http";
import { fontsZipResponse } from "$lib/server/fontDownloads";
import { listFonts } from "$lib/server/typesetting";
import type { RequestHandler } from "./$types";

/** The shared library as a zip; `?ids=a,b` for just those fonts. */
export const GET: RequestHandler = async ({ locals, url }) => {
  requireUser(locals.user);
  return fontsZipResponse(listFonts(null), url.searchParams.get("ids"), "Shared fonts");
};
