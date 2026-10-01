import { fail } from "@sveltejs/kit";
import {
  requireUser,
  requireClean,
  messageOf,
  statusOf,
} from "$lib/server/http";
import { canClean } from "$lib/server/access";
import { listFonts, uploadFont } from "$lib/server/typesetting";
import type { Actions, PageServerLoad } from "./$types";
export const load: PageServerLoad = ({ locals }) => {
  const user = requireUser(locals.user);
  return {
    fonts: listFonts(null),
    canManage: canClean(user),
  };
};
export const actions: Actions = {
  upload: async ({ locals, request }) => {
    try {
      requireClean(requireUser(locals.user));
      const form = await request.formData();
      const fonts = form
        .getAll("font")
        .filter((f): f is File => f instanceof File && f.size > 0);
      if (!fonts.length) return fail(400, { error: "Choose a font file" });
      let added = 0;
      let duplicates = 0;
      const category = form.get("category");
      for (const font of fonts) {
        const result = await uploadFont(
          null,
          font.name,
          Buffer.from(await font.arrayBuffer()),
          category,
        );
        if (result.duplicate) duplicates++;
        else added++;
      }
      const message =
        fonts.length === 1
          ? duplicates
            ? "Font already in the library."
            : "Font available to all series."
          : duplicates && added
            ? `Added ${added} fonts (${duplicates} already in the library).`
            : duplicates
              ? `All ${duplicates} fonts already in the library.`
              : `Added ${added} fonts to the library.`;
      return { message };
    } catch (e) {
      return fail(statusOf(e), { error: messageOf(e) });
    }
  },
};
