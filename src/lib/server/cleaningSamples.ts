import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Episode, ImageRow, Series } from "../types";
import type { PageData } from "../workflow";
import { ROOT } from "./paths";
import { getDoc, readAsset, WorkflowError } from "./workflowStore";

const SAMPLE_RE = /^(\d+)-(?:raw|clean)\.(?:png|jpe?g|webp)$/i;

export function cleaningSamplesDir() {
  return process.env.CLEANING_SAMPLES_DIR || join(ROOT, "tests/fixtures/cleaning");
}

export function padCleaningSampleId(id: number) {
  return String(id).padStart(3, "0");
}

export async function nextCleaningSampleId(dir = cleaningSamplesDir()) {
  let max = 0;
  try {
    for (const name of await readdir(dir)) {
      const match = name.match(SAMPLE_RE);
      if (match) max = Math.max(max, Number(match[1]));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return max + 1;
}

function pageAssets(data: PageData) {
  const raw = data.prepared || data.original;
  const clean = data.cleaned || data.cleanBase;
  return { raw, clean };
}

export async function saveCleaningSample(
  series: Series,
  episode: Episode,
  image: ImageRow,
) {
  const doc = getDoc<PageData>(`page:${image.id}`, {});
  const { raw, clean } = pageAssets(doc.data);
  if (!raw) throw new WorkflowError("Prepare the page before saving a cleaning sample");
  if (!clean) throw new WorkflowError("Clean the page before saving a raw/clean sample");

  const dir = cleaningSamplesDir();
  await mkdir(dir, { recursive: true });
  const id = await nextCleaningSampleId(dir);
  const key = padCleaningSampleId(id);
  const rawName = `${key}-raw.png`;
  const cleanName = `${key}-clean.png`;
  const [rawPng, cleanPng] = await Promise.all([
    sharp(await readAsset(raw)).png().toBuffer(),
    sharp(await readAsset(clean)).png().toBuffer(),
  ]);
  const meta = {
    id,
    seriesId: series.id,
    seriesSlug: series.slug,
    episodeId: episode.id,
    episodeSlug: episode.slug,
    imageId: image.id,
    pageNumber: image.pageNumber ?? null,
    originalName: image.originalName,
    raw: rawName,
    clean: cleanName,
    savedAt: Date.now(),
  };
  await Promise.all([
    writeFile(join(dir, rawName), rawPng),
    writeFile(join(dir, cleanName), cleanPng),
    writeFile(join(dir, `${key}.json`), JSON.stringify(meta, null, 2)),
  ]);
  return { ok: true, ...meta, dir };
}
