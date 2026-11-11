import { json } from "@sveltejs/kit";
import { requireUser, requireClean, fail, messageOf, statusOf } from "$lib/server/http";
import { listPatterns, uploadPattern } from "$lib/server/patterns";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ locals }) => {
  requireUser(locals.user);
  return json({ patterns: listPatterns() });
};

/** Multipart `pattern` files; each joins the shared library (an identical tile is kept once). */
export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    requireClean(requireUser(locals.user));
    const form = await request.formData();
    const files = form.getAll("pattern").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return fail(400, "Choose an image file");
    const added: string[] = [];
    let duplicates = 0;
    for (const file of files) {
      const result = await uploadPattern(file.name, Buffer.from(await file.arrayBuffer()));
      if (result.duplicate) duplicates++;
      added.push(result.pattern.id);
    }
    return json({ ok: true, added, duplicates, patterns: listPatterns() });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
