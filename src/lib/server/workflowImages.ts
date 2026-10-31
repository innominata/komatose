import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DATA_DIR } from "./paths";
import { finishEditorAnswer } from "./postprocess";
import { localOperation } from "./localWorker";
import { imageWorkflowModel, runImageTaskFiles } from "./modelImageWorkflow";
import { rowHasOperation } from "../modelRegistry";
import {
  readAsset,
  storeAsset,
  assetPath,
  WorkflowError,
} from "./workflowStore";

/** Shared image operation adapter. Neither this nor its callers grant human approval. */
export async function runWorkflowPng(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const output = join(DATA_DIR, "workflow", `${randomUUID()}.png`);
  try {
    await mkdir(join(DATA_DIR, "workflow"), { recursive: true });
    const started = Date.now();
    const model =
      payload.cmd === "clean"
        ? imageWorkflowModel(String(payload.method || "auto"))
        : null;
    const result: Record<string, any> = model
      ? await runImageTaskFiles(
          model,
          payload.task === "cleaning"
            ? "cleaning"
            : rowHasOperation(model, "inpaint")
              ? "inpaint"
              : "cleaning",
          {
            path: String(payload.path),
            mask: String(payload.mask),
            out: output,
            prompt:
              typeof payload.prompt === "string" ? payload.prompt : undefined,
          },
          signal,
        )
      : await localOperation({ ...payload, out: output }, signal);
    signal?.throwIfAborted();
    // An editor redraws the crop slightly off in tone; match it to the page around the mask.
    if (model) result.postprocess = await finishEditorAnswer(String(payload.path), output, String(payload.mask), undefined, signal);
    result.cleanDurationMs = Date.now() - started;
    return { result, artifact: await storeAsset(await readFile(output)) };
  } finally {
    await unlink(output).catch(() => {});
  }
}

/** Enforce the recorded mask even when an image editor changes the rest of the page. */
export async function maskedCleaning(
  base: string,
  mask: string,
  candidate: string,
) {
  const source = await readAsset(base),
    replacement = await readAsset(candidate),
    maskBytes = await readAsset(mask);
  const [a, b, c] = await Promise.all(
    [source, replacement, maskBytes].map((bytes) => sharp(bytes).metadata()),
  );
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.width !== c.width ||
    a.height !== c.height
  )
    throw new WorkflowError("Cleaning output or mask has the wrong dimensions");
  const alpha = await sharp(maskBytes)
    .greyscale()
    .removeAlpha()
    .raw()
    .toBuffer();
  // Materialize RGB before adding alpha: libvips can otherwise apply removeAlpha
  // after joinChannel and silently discard the mask in the same pipeline.
  const rgb = await sharp(replacement)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  const rgba = Buffer.alloc(a.width! * a.height! * 4);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    rgba[pixel * 4] = rgb[pixel * 3];
    rgba[pixel * 4 + 1] = rgb[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = rgb[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = alpha[pixel];
  }
  const overlay = await sharp(rgba, {
    raw: { width: a.width!, height: a.height!, channels: 4 },
  })
    .png()
    .toBuffer();
  return storeAsset(
    await sharp(source)
      .composite([{ input: overlay }])
      .png()
      .toBuffer(),
  );
}
export const workflowAssetPath = assetPath;
