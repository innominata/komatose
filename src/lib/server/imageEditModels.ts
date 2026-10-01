import { join } from 'node:path';
import { IMAGE_EDIT_MODELS, type ImageEditModelId } from '../imageEdit';
import { imageEditModelDir, imageEditTextEncoderDir } from './gpuMode';

/**
 * Where each editor's weights live and how stable-diffusion.cpp must load them. The model
 * families are not interchangeable: Qwen-Image-2.1 is a 7B transformer conditioned by
 * Qwen3-VL-8B, while Qwen-Image-Edit-2511 is a 20B transformer from the older Qwen-Image
 * line that needs Qwen2.5-VL-7B and its own VAE.
 */
export type ImageEditModelFiles = {
  id: ImageEditModelId;
  label: string;
  /** Directory holding this editor's installed.json and its diffusion weights. */
  dir: string;
  /** Text encoder directory, and the files inside it the server loads. */
  encoderDir: string;
  encoderFile: string;
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
    'qwen-image-2.1': {
      id: 'qwen-image-2.1',
      label: 'Qwen-Image 2.1',
      dir: imageEditModelDir('qwen-image-2.1'),
      // Qwen3-VL-8B is shared with the review installer, so 2.1 is not installed with its
      // own encoder copy.
      encoderDir: imageEditTextEncoderDir('qwen-image-2.1'),
      encoderFile: process.env.SCAN_IMAGE_TEXT_ENCODER || 'Qwen3-VL-8B-Instruct-Q8_0.gguf',
      encoderVisionFile: 'mmproj-F16.gguf',
      modelArgs: [],
      flags: [],
      fallback: { diffusion: 'qwen_image_2.1-Q8_0.gguf', vae: 'pig_qwen_image_2.1_vae_fp32-f16.gguf' },
    },
    'qwen-image-edit-2511': {
      id: 'qwen-image-edit-2511',
      label: 'Qwen-Image-Edit 2511',
      dir: imageEditModelDir('qwen-image-edit-2511'),
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
  };
}

export function imageEditModelIds(): ImageEditModelId[] {
  return IMAGE_EDIT_MODELS.map((model) => model.id);
}
