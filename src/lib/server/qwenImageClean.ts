import sharp from 'sharp';
import {
  IMAGE_EDIT_ALIGN,
  IMAGE_EDIT_MODELS,
  buildImageEditPrompt, imageEditModelOf, imageEditTuning,
  normalizeImageEditPrompt, parseImageEditLoras, type ImageEditModelId,
} from '../imageEdit';
import { installedImageEdit, withImageEdit } from './imageEdit';

// Same tiling as the Codex method so both reconstructions are composited alike.
const CORE = 768;
const CONTEXT = 128;

type Crop = { left: number; top: number; width: number; height: number };

/**
 * The local editors want both crop sides divisible by 32, or the result blurs and drifts.
 * Every editor in IMAGE_EDIT_MODELS shares that requirement, so one helper covers both.
 */
const align = (value: number) => Math.max(IMAGE_EDIT_ALIGN, Math.ceil(value / IMAGE_EDIT_ALIGN) * IMAGE_EDIT_ALIGN);

function minSide(id: ImageEditModelId) {
  const configured = imageEditTuning(imageEditModelOf(id), process.env, 'MIN_SIDE', 512);
  return align(configured > 0 ? configured : 512);
}

/**
 * Sampling controls for stable-diffusion.cpp's OpenAI route. The schema mirrors its C
 * struct, not the CLI: a top-level `cfg_scale` is silently ignored, text guidance must be
 * sent as `sample_params.guidance.txt_cfg`.
 */
function sampleArgs(id: ImageEditModelId) {
  const model = imageEditModelOf(id);
  const tuning = (key: string, fallback: number) => imageEditTuning(model, process.env, key, fallback);
  const sample: Record<string, unknown> = {
    sample_steps: Math.max(1, Math.min(100, Math.round(tuning('STEPS', model.sampling.steps)))),
    sample_method: 'euler',
    guidance: { txt_cfg: tuning('CFG', model.sampling.cfg) },
  };
  // 2.1 selects a resolution-dependent flow schedule; the edit weights expect 3.
  const flowShift = tuning('FLOW_SHIFT', model.sampling.flowShift ?? NaN);
  if (Number.isFinite(flowShift)) sample.flow_shift = flowShift;
  const args: Record<string, unknown> = { sample_params: sample };
  // Without full strength the sampler only truncates the schedule and the marked
  // lettering survives; the removal mask decides what is repainted instead.
  const denoise = tuning('DENOISE', model.sampling.denoise);
  args.strength = Math.min(1, Math.max(0.05, denoise));
  // Fixed seeds make cleaning runs reproducible for benchmarking; -1 varies each run.
  const seed = Number(process.env.SCAN_IMAGE_SEED);
  if (Number.isInteger(seed)) args.seed = seed;
  // ComfyUI-style style LoRAs, resolved against --lora-model-dir by the server. A LoRA is
  // bound to one architecture, so the edit model may name its own set.
  const loras = parseImageEditLoras(
    process.env[`${model.envPrefix}_LORAS`] ?? process.env.SCAN_IMAGE_LORAS,
  );
  if (loras.length) args.lora = loras;
  return args;
}

/**
 * The tile a group of marked pixels is rebuilt in: the marked bounds plus context for the
 * model to continue lines and shading from, grown to a useful working size and snapped to
 * the /32 grid. The rectangle may hang off the page; renderCrop pads it by repeating the
 * edge pixels, which keeps artwork next to the seam instead of the white that used to make
 * the model paint blank corners.
 */
function cropRect(bounds: Crop, pageWidth: number, pageHeight: number, id: ImageEditModelId): Crop {
  const left = Math.max(0, bounds.left - CONTEXT);
  const top = Math.max(0, bounds.top - CONTEXT);
  const want: Crop = {
    left, top,
    width: Math.min(pageWidth, bounds.left + bounds.width + CONTEXT) - left,
    height: Math.min(pageHeight, bounds.top + bounds.height + CONTEXT) - top,
  };
  const side = minSide(id);
  const width = Math.max(side, align(want.width));
  const height = Math.max(side, align(want.height));
  return {
    left: Math.round(want.left + (want.width - width) / 2),
    top: Math.round(want.top + (want.height - height) / 2),
    width, height,
  };
}

/** Extracts the crop, repeating edge pixels wherever the rectangle leaves the page. */
function renderCrop(pixels: Buffer, pageWidth: number, pageHeight: number, channels: number, crop: Crop) {
  const rendered = Buffer.alloc(crop.width * crop.height * channels);
  for (let y = 0; y < crop.height; y++) {
    const sourceY = Math.min(pageHeight - 1, Math.max(0, crop.top + y));
    for (let x = 0; x < crop.width; x++) {
      const sourceX = Math.min(pageWidth - 1, Math.max(0, crop.left + x));
      const from = (sourceY * pageWidth + sourceX) * channels, to = (y * crop.width + x) * channels;
      for (let c = 0; c < channels; c++) rendered[to + c] = pixels[from + c];
    }
  }
  return rendered;
}

/**
 * Qwen-Image-2.1 takes a reference image plus an instruction. stable-diffusion.cpp's
 * OpenAI-compatible route needs the native sampling controls embedded in the prompt.
 */
async function editCrop(
  baseUrl: string,
  id: ImageEditModelId,
  image: Buffer,
  mask: Buffer,
  width: number,
  height: number,
  instructions: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const form = new FormData();
  form.append('prompt', `${buildImageEditPrompt(instructions)} <sd_cpp_extra_args>${JSON.stringify(sampleArgs(id))}</sd_cpp_extra_args>`);
  form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'crop.png');
  form.append('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');
  form.append('size', `${width}x${height}`);
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/images/edits`, {
    method: 'POST', body: form, signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`The local image editor returned HTTP ${response.status}: ${detail}`);
  }
  const body = (await response.json()) as { data?: { b64_json?: string }[] };
  const encoded = body.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded)
    throw new Error('The local image editor returned no image');
  return Buffer.from(encoded, 'base64');
}

/**
 * Rebuilds every marked tile with one of the local editors. `model` picks which weights and
 * text encoder the shared sd-server loads, so the caller can compare the two on one page.
 */
export async function cleanWithQwenImage(opts: {
  path: string;
  mask: string;
  out: string;
  prompt?: string;
  model?: ImageEditModelId;
}, signal?: AbortSignal) {
  const model = imageEditModelOf(opts.model ?? IMAGE_EDIT_MODELS[0].id);
  if (!installedImageEdit(model.id))
    throw new Error(`${model.label} is not installed. See docs/WORKFLOW.md for the installer.`);
  try {
    signal?.throwIfAborted();
    return await cleanCrops(opts, model.id, signal);
  } catch (error) {
    // Cancellation surfaces from fetch as a raw AbortError mid-crop; the job log
    // should read the same as the other cleaning methods.
    if (signal?.aborted) throw new Error('Cancelled');
    throw error;
  }
}

/** The crop loop, wrapped by cleanWithQwenImage for cancellation reporting. */
async function cleanCrops(opts: {
  path: string;
  mask: string;
  out: string;
  prompt?: string;
}, id: ImageEditModelId, signal?: AbortSignal) {
  const model = imageEditModelOf(id);
  const instructions = normalizeImageEditPrompt(opts.prompt);
  const source = await sharp(opts.path).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(opts.mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = source.info;
  if (mask.info.width !== width || mask.info.height !== height)
    throw new Error('Removal mask dimensions do not match the prepared page');
  const groups = new Map<string, { bounds: Crop }>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask.data[y * width + x]) continue;
      const cx = Math.floor(x / CORE) * CORE, cy = Math.floor(y / CORE) * CORE;
      const key = `${cx}:${cy}`;
      const group = groups.get(key);
      if (group) {
        const right = Math.max(group.bounds.left + group.bounds.width, x + 1);
        group.bounds.left = Math.min(group.bounds.left, x);
        group.bounds.width = right - group.bounds.left;
        group.bounds.height = y + 1 - group.bounds.top;
      } else groups.set(key, { bounds: { left: x, top: y, width: 1, height: 1 } });
    }
  }
  if (!groups.size) throw new Error('The approved removal mask is empty');
  const output = Buffer.from(source.data);
  let patches = 0;
  await withImageEdit(id, async (baseUrl) => {
    for (const { bounds } of groups.values()) {
      signal?.throwIfAborted();
      const crop = cropRect(bounds, width, height, id);
      const selection = Buffer.alloc(crop.width * crop.height);
      for (let y = 0; y < crop.height; y++) {
        const sourceY = crop.top + y;
        if (sourceY < 0 || sourceY >= height) continue;
        for (let x = 0; x < crop.width; x++) {
          const sourceX = crop.left + x;
          if (sourceX < 0 || sourceX >= width) continue;
          if (mask.data[sourceY * width + sourceX]) selection[y * crop.width + x] = 255;
        }
      }
      if (!selection.some((value) => value !== 0)) continue;
      // Overlapping crops start from the latest reconstruction, so later calls
      // cannot restore lettering or artwork from the original page.
      const image = await sharp(renderCrop(output, width, height, channels, crop), {
        raw: { width: crop.width, height: crop.height, channels },
      }).png().toBuffer();
      const maskImage = await sharp(selection, { raw: { width: crop.width, height: crop.height, channels: 1 } }).png().toBuffer();
      const generated = await editCrop(baseUrl, id, image, maskImage, crop.width, crop.height, instructions, signal ?? new AbortController().signal);
      patches++;
      signal?.throwIfAborted();
      const meta = await sharp(generated).metadata();
      if (!meta.width || !meta.height || Math.abs(meta.width / meta.height - crop.width / crop.height) > .02)
        throw new Error('The local image editor returned a different image framing; retry cleaning');
      const fill = await sharp(generated).resize(crop.width, crop.height, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
      for (let y = 0; y < crop.height; y++) {
        const sourceY = crop.top + y;
        if (sourceY < 0 || sourceY >= height) continue;
        for (let x = 0; x < crop.width; x++) {
          const sourceX = crop.left + x;
          if (sourceX < 0 || sourceX >= width) continue;
          const from = (y * crop.width + x) * channels, to = (sourceY * width + sourceX) * channels;
          // Keep the complete reconstruction, including changes outside the mask.
          const alpha = fill[from + 3] / 255;
          for (let c = 0; c < 3; c++) output[to + c] = Math.round(fill[from + c] * alpha + output[to + c] * (1 - alpha));
          mask.data[sourceY * width + sourceX] = 0;
        }
      }
    }
  }, signal);
  signal?.throwIfAborted();
  await sharp(output, { raw: source.info }).png().toFile(opts.out);
  return { method: model.method, backend: `${model.label} · stable-diffusion.cpp`, patches };
}
