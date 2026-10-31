import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { DEFAULT_POSTPROCESS, isPostprocessMethod, POSTPROCESS_METHODS, type CleanFinish, type PostprocessMethod } from "../postprocess";
import { localOperation } from "./localWorker";
import { DATA_DIR } from "./paths";
import { assetPath, readAsset, storeAsset, WorkflowError } from "./workflowStore";

const SETTINGS = () => join(DATA_DIR, "postprocess.json");

/** The method new image-editor cleans are finished with. */
export function defaultPostprocess(): PostprocessMethod {
  try {
    if (existsSync(SETTINGS())) {
      const method = JSON.parse(readFileSync(SETTINGS(), "utf8")).method;
      if (isPostprocessMethod(method)) return method;
    }
  } catch {
    /* A damaged file falls back to the default. */
  }
  return DEFAULT_POSTPROCESS;
}

export function setDefaultPostprocess(method: unknown) {
  if (!isPostprocessMethod(method)) throw new WorkflowError("Unknown post-processing method");
  writeFileSync(SETTINGS(), JSON.stringify({ method }));
  return method;
}

/**
 * Matches an image editor's answer to the page in place. A finishing failure keeps the
 * answer as the editor returned it.
 */
export async function finishEditorAnswer(page: string, answer: string, mask: string, method: PostprocessMethod = defaultPostprocess(), signal?: AbortSignal) {
  try {
    return (await localOperation({ cmd: "finish", path: page, answer, mask, out: answer, method }, signal)).postprocess;
  } catch (e) {
    signal?.throwIfAborted();
    console.warn("Post-processing skipped:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

/** Finishes a saved answer with `method` over the whole page; returns the new artwork. */
export async function refinish(finish: CleanFinish, method: PostprocessMethod) {
  const dir = join(DATA_DIR, "workflow", `finish-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const out = join(dir, "out.png");
    await writeFile(out, await readAsset(finish.answer));
    await localOperation({ cmd: "finish", path: assetPath(finish.base), answer: out, mask: assetPath(finish.mask), out, method });
    return storeAsset(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The mask's bounds plus context, the area every preview shows. */
async function previewBox(mask: Buffer) {
  const { data, info } = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  let [x0, y0, x1, y1] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[y * info.width + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new WorkflowError("The cleaned mask is empty");
  const margin = Math.max(48, Math.round(Math.max(x1 - x0, y1 - y0) * 0.15));
  const left = Math.max(0, x0 - margin), top = Math.max(0, y0 - margin);
  return { left, top, width: Math.min(info.width, x1 + margin + 1) - left, height: Math.min(info.height, y1 + margin + 1) - top };
}

/** One crop per method, made from the saved answer without running the editor again. */
export async function postprocessPreviews(finish: CleanFinish) {
  const maskBytes = await readAsset(finish.mask);
  const box = await previewBox(maskBytes);
  const crop = async (hash: string) => sharp(await readAsset(hash)).extract(box).png().toBuffer();
  const dir = join(DATA_DIR, "workflow", `finish-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  try {
    const [page, answer, mask] = [join(dir, "page.png"), join(dir, "answer.png"), join(dir, "mask.png")];
    const { width, height } = await sharp(await readAsset(finish.base)).metadata();
    const answerBytes = await sharp(await readAsset(finish.answer)).resize(width, height, { fit: "fill" }).png().toBuffer();
    await Promise.all([
      writeFile(page, await crop(finish.base)),
      writeFile(answer, await sharp(answerBytes).extract(box).png().toBuffer()),
      writeFile(mask, await sharp(maskBytes).extract(box).png().toBuffer()),
    ]);
    const previews = [];
    for (const m of POSTPROCESS_METHODS) {
      const out = join(dir, `${m.id}.png`);
      const started = Date.now();
      try {
        await localOperation({ cmd: "finish", path: page, answer, mask: mask, out, method: m.id });
        previews.push({ method: m.id, asset: await storeAsset(await readFile(out)), ms: Date.now() - started });
      } catch (e) {
        previews.push({ method: m.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { box, previews, before: await storeAsset(await crop(finish.base)) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
