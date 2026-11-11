/** What page upload pickers accept: any image, Photoshop files (flattened to PNG), and zip/cbz archives of either. */
export const PAGE_FILE_ACCEPT = "image/*,.psd,.zip,.cbz,application/zip,application/x-zip-compressed,application/vnd.comicbook+zip";

export const isPsdFile = (file: File) => /\.psd$/i.test(file.name) || file.type === "image/vnd.adobe.photoshop";

export const isZipFile = (file: File) =>
  /\.(zip|cbz)$/i.test(file.name) ||
  ["application/zip", "application/x-zip-compressed", "application/vnd.comicbook+zip"].includes(file.type);

/** Browsers report PSDs as `image/vnd.adobe.photoshop`, or with no type at all. */
export const isPageFile = (file: File) => file.type.startsWith("image/") || isPsdFile(file) || isZipFile(file);

const ENTRY_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  psd: "image/vnd.adobe.photoshop",
};

/** The page file type for a name inside an archive, or null when it is not a page. */
export function zipEntryType(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  if (!base || base.startsWith(".") || path.split("/").some((part) => part === "__MACOSX")) return null;
  return ENTRY_TYPES[base.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/**
 * The upload name for an archive entry. Folders are kept in the name ("ch1/003.jpg" becomes
 * "ch1 - 003.jpg") so the upload preview's name sort keeps the archive's folder order.
 * A folder shared by every entry adds nothing and is dropped.
 */
export function zipEntryName(path: string, commonPrefix: string): string {
  return path.slice(commonPrefix.length).split("/").filter(Boolean).join(" - ");
}

export function commonFolder(paths: string[]): string {
  if (!paths.length) return "";
  let prefix = paths[0].slice(0, paths[0].lastIndexOf("/") + 1);
  for (const path of paths) while (prefix && !path.startsWith(prefix)) prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
  return prefix;
}

/**
 * Replaces each zip or cbz with the images and PSDs inside it. Other files pass through.
 * `skipped` names archives that could not be read or had no pages.
 */
export async function expandPageFiles(files: File[]): Promise<{ files: File[]; skipped: string[] }> {
  if (!files.some(isZipFile)) return { files, skipped: [] };
  const { default: JSZip } = await import("jszip");
  const out: File[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (!isZipFile(file)) {
      out.push(file);
      continue;
    }
    try {
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entries = Object.values(zip.files).filter((entry) => !entry.dir && zipEntryType(entry.name));
      const prefix = commonFolder(entries.map((entry) => entry.name));
      const found = await Promise.all(
        entries.map(async (entry) => {
          const bytes = await entry.async("arraybuffer");
          return new File([bytes], zipEntryName(entry.name, prefix), {
            type: zipEntryType(entry.name)!,
            lastModified: entry.date?.getTime() ?? Date.now(),
          });
        }),
      );
      if (found.length) out.push(...found);
      else skipped.push(`${file.name} has no images`);
    } catch {
      skipped.push(`${file.name} could not be read as a zip`);
    }
  }
  return { files: out, skipped };
}
