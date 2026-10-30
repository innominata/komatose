import JSZip from "jszip";
import { fontCategoryLabel } from "../fontCategories";
import type { FontAsset } from "../workflow";
import { readAsset } from "./workflowStore";

const contentType = (font: FontAsset) => (font.format === "OTF" ? "font/otf" : "font/ttf");

/** `filename*` keeps non-ASCII names; the plain `filename` is an ASCII fallback. */
function disposition(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** The font file, for `@font-face` or, with `download`, saved under its uploaded name. */
export async function fontFileResponse(font: FontAsset, download: boolean) {
  return new Response(new Uint8Array(await readAsset(font.hash)), {
    headers: {
      "content-type": contentType(font),
      "cache-control": "private, max-age=31536000, immutable",
      ...(download ? { "content-disposition": disposition(font.filename) } : {}),
    },
  });
}

/**
 * The fonts as one zip, a folder per category. `ids` (comma-separated, from `?ids=`) limits it
 * to those fonts; same-named files get a numbered suffix rather than overwrite each other.
 */
export async function fontsZipResponse(fonts: FontAsset[], ids: string | null, name: string) {
  const wanted = ids ? new Set(ids.split(",").filter(Boolean)) : null;
  const chosen = wanted ? fonts.filter((f) => wanted.has(f.id)) : fonts;
  if (!chosen.length) return new Response("No fonts to download", { status: 404 });
  const zip = new JSZip();
  const used = new Set<string>();
  for (const font of chosen) {
    const folder = fontCategoryLabel(font.category);
    const dot = font.filename.lastIndexOf(".");
    const stem = dot > 0 ? font.filename.slice(0, dot) : font.filename;
    const ext = dot > 0 ? font.filename.slice(dot) : font.format === "OTF" ? ".otf" : ".ttf";
    let path = `${folder}/${stem}${ext}`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${stem} (${n})${ext}`;
    used.add(path.toLowerCase());
    zip.file(path, await readAsset(font.hash), { date: new Date(0) });
  }
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new Response(bytes, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": disposition(`${name}.zip`),
      "cache-control": "private, no-store",
    },
  });
}
