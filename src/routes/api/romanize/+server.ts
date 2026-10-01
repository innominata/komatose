import { json } from "@sveltejs/kit";
import { fail, messageOf, requireUser, statusOf } from "$lib/server/http";
import { romanizePhrases } from "$lib/server/romanize";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ locals, request }) => {
  try {
    requireUser(locals.user);
    const body = await request.json();
    if (!Array.isArray(body?.texts)) throw Object.assign(new Error("texts required"), { status: 400 });
    const texts = body.texts.slice(0, 200).map((text: unknown) => String(text ?? "").slice(0, 2000));
    return json({ romanizations: await romanizePhrases(texts) });
  } catch (e) {
    return fail(statusOf(e), messageOf(e));
  }
};
