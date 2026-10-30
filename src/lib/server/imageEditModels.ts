import { join } from 'node:path';
import { IMAGE_EDIT_MODELS, type ImageEditModelId } from '../imageEdit';
import { imageEditModelDir, imageEditModelsDir, imageEditTextEncoderDir } from './gpuMode';

export const flux3Dir = () => join(imageEditModelsDir(), 'flux-3-image-klein');

/**
 * Where the artwork editor's weights live and how stable-diffusion.cpp must load them.
 * Qwen-Image-Edit-2511 is a 20B transformer that needs Qwen2.5-VL-7B and its own VAE.
 */
export type ImageEditModelFiles = {
  id: ImageEditModelId;
  label: string;
  /** Directory holding this editor's marker and its diffusion weights. */
  dir: string;
  /** Marker the installer writes for this quant: installed.json for Q4_K_M. */
  marker: string;
  /** Text encoder directory, and the files inside it the server loads. */
  encoderDir: string;
  encoderFile: string;
  /** Vision projector loaded with `--llm_vision`; empty when the architecture needs none. */
  encoderVisionFile: string;
  /** Extra `--model-args` stable-diffusion.cpp needs for this architecture. */
  modelArgs: string[];
  /** Plain CLI flags this architecture needs next to the shared set. */
  flags: string[];
  /** Fallbacks used only when installed.json has no file names, e.g. a hand-built install. */
  fallback: { diffusion: string; vae: string };
};

/** Resolves one descriptor per editor, in the same order as IMAGE_EDIT_MODELS. */
export function imageEditModelFiles(): Record<ImageEditModelId, ImageEditModelFiles> {
  return {
    'qwen-image-edit-2511': {
      id: 'qwen-image-edit-2511',
      label: 'Qwen-Image-Edit 2511',
      dir: imageEditModelDir('qwen-image-edit-2511'),
      marker: 'installed.json',
      // scripts/install-image-edit-model.py writes Qwen2.5-VL into the model's own directory.
      encoderDir: imageEditTextEncoderDir('qwen-image-edit-2511'),
      encoderFile: process.env.SCAN_IMAGE_EDIT_TEXT_ENCODER || 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf',
      encoderVisionFile: 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf',
      // Without zero_cond_t stable-diffusion.cpp degrades 2511 edits badly.
      modelArgs: ['qwen_image_zero_cond_t=true'],
      // 20B weights plus a 5.4GB encoder leave too little free VRAM to encode a crop's init
      // image in one go, so the VAE runs in tiles instead of failing the second patch.
      flags: ['--vae-tiling'],
      fallback: { diffusion: 'qwen-image-edit-2511-Q4_K_M.gguf', vae: join('VAE', 'Qwen_Image-VAE.safetensors') },
    },
    'qwen-image-edit-2511-lightning': {
      id: 'qwen-image-edit-2511-lightning',
      label: 'Qwen-Image-Edit 2511 Lightning',
      // The LoRA is the only file Lightning owns. The 20B weights stay in the 2511 directory.
      dir: imageEditModelDir('qwen-image-edit-2511'),
      marker: 'installed.json',
      encoderDir: imageEditTextEncoderDir('qwen-image-edit-2511'),
      encoderFile: process.env.SCAN_IMAGE_EDIT_TEXT_ENCODER || 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf',
      encoderVisionFile: 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf',
      modelArgs: ['qwen_image_zero_cond_t=true'],
      flags: ['--vae-tiling'],
      fallback: { diffusion: 'qwen-image-edit-2511-Q4_K_M.gguf', vae: join('VAE', 'Qwen_Image-VAE.safetensors') },
    },
    'qwen-image-edit-2511-q3': quantVariant('qwen-image-edit-2511-q3', 'Qwen-Image-Edit 2511 Q3_K_M', 'q3_k_m', 'Q3_K_M'),
    'qwen-image-edit-2511-q2': quantVariant('qwen-image-edit-2511-q2', 'Qwen-Image-Edit 2511 Q2_K', 'q2_k', 'Q2_K'),
    // FLUX.3 Image Klein: a FLUX.3 transformer, the FLUX.2 VAE, and Qwen3-VL 4B as its text
    // encoder (stable-diffusion.cpp docs/flux3.md). The reference image goes through the VAE,
    // so the encoder needs no vision projector.
    'flux-3-image-klein': {
      id: 'flux-3-image-klein',
      label: 'FLUX 3 Image Klein',
      // Its own folder: SCAN_IMAGE_EDIT_MODEL_DIR names the Qwen weights, not every editor's.
      dir: flux3Dir(),
      marker: 'installed.json',
      encoderDir: flux3Dir(),
      encoderFile: process.env.SCAN_IMAGE_EDIT_FLUX3_TEXT_ENCODER || 'Qwen3VL-4B-Instruct-Q8_0.gguf',
      encoderVisionFile: '',
      modelArgs: [],
      flags: [],
      fallback: { diffusion: 'flux3-image-klein-Q8_0.gguf', vae: 'flux2-vae.safetensors' },
    },
  };
}

/** A smaller diffusion quant in the 2511 directory, reusing its VAE and Qwen2.5-VL encoder. */
function quantVariant(id: ImageEditModelId, label: string, quant: string, suffix: string): ImageEditModelFiles {
  return {
    id,
    label,
    dir: imageEditModelDir('qwen-image-edit-2511'),
    marker: `installed-${quant}.json`,
    encoderDir: imageEditTextEncoderDir('qwen-image-edit-2511'),
    encoderFile: process.env.SCAN_IMAGE_EDIT_TEXT_ENCODER || 'Qwen2.5-VL-7B-Instruct.Q5_K_M.gguf',
    encoderVisionFile: 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf',
    modelArgs: ['qwen_image_zero_cond_t=true'],
    flags: ['--vae-tiling'],
    fallback: { diffusion: `qwen-image-edit-2511-${suffix}.gguf`, vae: join('VAE', 'Qwen_Image-VAE.safetensors') },
  };
}

export function imageEditModelIds(): ImageEditModelId[] {
  return IMAGE_EDIT_MODELS.map((model) => model.id);
}
