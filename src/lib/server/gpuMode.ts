import { managedRuntimeSummary } from './modelUsage';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { LOCAL_REVIEW_MODELS, type LocalReviewModelId } from '../localReviewModels';
import { DATA_DIR } from './paths';

export type GpuModeSource = 'env' | 'setting' | 'default';

/**
 * Komatose owns both 7900 XTXs; llama-swap (Hermes) must be stopped first.
 *
 * The switch lives in Admin → Hardware & services (`data/gpu-mode.json`) so the
 * layout is configurable from inside the app. `SCAN_GPU_MODE` in the environment
 * still pins it, for hosts that ship the layout in their unit file or .env.
 */
const GPU_MODE_FILE = join(DATA_DIR, 'gpu-mode.json');
let gpuModeCache: { path: string; mtime: number; enabled: boolean } | null = null;

function storedGpuEnabled(): boolean {
  let mtime = -1;
  try {
    mtime = statSync(GPU_MODE_FILE).mtimeMs;
  } catch {
    mtime = -1; // never switched on: a fresh install stays on CPU
  }
  if (gpuModeCache && gpuModeCache.path === GPU_MODE_FILE && gpuModeCache.mtime === mtime) return gpuModeCache.enabled;
  let enabled = false;
  if (mtime >= 0) {
    try {
      const parsed = JSON.parse(readFileSync(GPU_MODE_FILE, 'utf8')) as { mode?: unknown };
      enabled = String(parsed?.mode ?? '').trim().toLowerCase() === 'komatose';
    } catch {
      enabled = false;
    }
  }
  gpuModeCache = { path: GPU_MODE_FILE, mtime, enabled };
  return enabled;
}

export function komatoseGpuEnabled(): boolean {
  const env = process.env.SCAN_GPU_MODE;
  if (env !== undefined) return env.trim().toLowerCase() === 'komatose';
  return storedGpuEnabled();
}

/** Where the current answer came from, so the switch can say when it is pinned. */
export function komatoseGpuSource(): GpuModeSource {
  if (process.env.SCAN_GPU_MODE !== undefined) return 'env';
  try {
    statSync(GPU_MODE_FILE);
    return 'setting';
  } catch {
    return 'default';
  }
}

export function komatoseGpuState(): { komatose: boolean; source: GpuModeSource } {
  return { komatose: komatoseGpuEnabled(), source: komatoseGpuSource() };
}

export function setKomatoseGpuEnabled(enabled: boolean): { komatose: boolean; source: GpuModeSource } {
  if (process.env.SCAN_GPU_MODE !== undefined) return komatoseGpuState(); // pinned by the host
  mkdirSync(DATA_DIR, { recursive: true });
  const temp = `${GPU_MODE_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, mode: enabled ? 'komatose' : 'cpu' }, null, 2)}\n`);
  renameSync(temp, GPU_MODE_FILE);
  gpuModeCache = null;
  return komatoseGpuState();
}

/** Build folders llama.cpp and stable-diffusion.cpp use for each GPU backend, in preference order. */
const BUILD_DIRS = ['build-vulkan', 'build-cuda', 'build-rocm', 'build-hip', 'build', 'build-metal', 'build-cpu'];

function firstExecutable(candidates: string[]): string | undefined {
  for (const path of candidates) {
    try {
      if (path && existsSync(path) && statSync(path).isFile()) return path;
    } catch {
      /* unreadable candidate */
    }
  }
  return undefined;
}

function discoverBinary(repo: string, name: string): string | undefined {
  const home = homedir();
  const onPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  return firstExecutable([
    ...BUILD_DIRS.map((dir) => join(home, repo, dir, 'bin', name)),
    ...onPath,
    join('/usr/local/bin', name),
  ]);
}

/** SCAN_REVIEW_LLAMA_SERVER wins; otherwise any Vulkan, CUDA, ROCm or CPU build that exists. */
export function llamaServerBin() {
  return process.env.SCAN_REVIEW_LLAMA_SERVER ||
    discoverBinary('llama.cpp', 'llama-server') ||
    join(homedir(), 'llama.cpp/build-vulkan/bin/llama-server');
}

/** First discrete card: Qwen3.8 27B. Vulkan0 is the Raphael iGPU — never use it. */
export function llmVulkanDevice() {
  return process.env.SCAN_LLM_DEVICE || 'Vulkan1';
}

/** Second discrete card: OCR GGUFs. */
export function reviewVulkanDevice() {
  return process.env.SCAN_REVIEW_DEVICE || 'Vulkan2';
}

/**
 * HIP index of the second 7900 XTX. ROCm enumerates iGPU as 0, then the two XTXs.
 * PyTorch must not see the iGPU — mixed-device init has segfaulted on this host.
 */
export function hipVisibleDevices() {
  return process.env.SCAN_HIP_VISIBLE_DEVICES || '2';
}

export function llmListenPort() {
  return Math.max(1, Number(process.env.SCAN_LLM_PORT) || 18080);
}

export function reviewListenPort(id: LocalReviewModelId) {
  const fallback: Record<LocalReviewModelId, number> = {
    'hayai-ocr-v2': 18083,
    'manga-ocr': 18085,
    'paddleocr-vl-1.6': 18081,
    'qwen3-vl-8b': 18082,
  };
  const envName: Record<LocalReviewModelId, string> = {
    'hayai-ocr-v2': 'SCAN_REVIEW_HAYAI_PORT',
    'manga-ocr': 'SCAN_REVIEW_MANGA_PORT',
    'paddleocr-vl-1.6': 'SCAN_REVIEW_PADDLE_PORT',
    'qwen3-vl-8b': 'SCAN_REVIEW_QWEN_PORT',
  };
  return Math.max(1, Number(process.env[envName[id]]) || fallback[id]);
}

/** GPU review servers bind these loopback ports; chat models must not reuse them. */
export function reservedReviewService(port: number) {
  if (!komatoseGpuEnabled()) return;
  return LOCAL_REVIEW_MODELS.find((model) => reviewListenPort(model.id) === port);
}

/** The local image editors hold their ports whenever they run, so chat models stay off them. */
export function reservedImageEditPort(port: number) {
  return komatoseGpuEnabled() && imageEditListenPorts().includes(port);
}

export function qwen38ModelsDir() {
  return process.env.SCAN_LLM_MODELS_DIR ||
    join(homedir(), 'models/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF');
}

export function qwen38ModelPath() {
  return process.env.SCAN_LLM_MODEL ||
    join(qwen38ModelsDir(), 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf');
}

export function qwen38MmprojPath() {
  return process.env.SCAN_LLM_MMPROJ ||
    join(qwen38ModelsDir(), 'mmproj-Qwen3.8-27B-BF16.gguf');
}

export function qwen38ChatTemplatePath() {
  return process.env.SCAN_LLM_CHAT_TEMPLATE ||
    join(homedir(), 'models/chat-templates/qwen38-chat-template.jinja');
}

export type Gemma4Pack = 'e2b' | 'e4b' | '12b' | '26b';

const GEMMA4_PACK_SPECS: Record<Gemma4Pack, { dir: string; model: string; mtp: string }> = {
  e2b: {
    dir: 'gemma-4-E2B-it-GGUF',
    model: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf',
    mtp: 'mtp-gemma-4-E2B-it.gguf',
  },
  e4b: {
    dir: 'gemma-4-E4B-it-GGUF',
    model: 'gemma-4-E4B-it-UD-Q4_K_XL.gguf',
    mtp: 'mtp-gemma-4-E4B-it.gguf',
  },
  '12b': {
    dir: 'gemma-4-12b-it-GGUF',
    model: 'gemma-4-12b-it-UD-Q4_K_XL.gguf',
    mtp: 'mtp-gemma-4-12b-it.gguf',
  },
  '26b': {
    dir: 'gemma-4-26B-A4B-it-GGUF',
    model: 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf',
    mtp: 'mtp-gemma-4-26B-A4B-it.gguf',
  },
};

export function gemma4ModelsRoot() {
  return process.env.SCAN_GEMMA4_MODELS_ROOT || join(homedir(), 'models/unsloth');
}

export function gemma4PackPaths(pack: Gemma4Pack) {
  const spec = GEMMA4_PACK_SPECS[pack];
  const dir = join(gemma4ModelsRoot(), spec.dir);
  return {
    dir,
    model: join(dir, spec.model),
    mmproj: join(dir, 'mmproj-BF16.gguf'),
    mtp: join(dir, spec.mtp),
  };
}

export function gemma4ModelsDir() {
  return process.env.SCAN_GEMMA4_MODELS_DIR || gemma4PackPaths('26b').dir;
}

export function gemma4ModelPath() {
  return process.env.SCAN_GEMMA4_MODEL ||
    join(gemma4ModelsDir(), 'gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf');
}

export function gemma4MmprojPath() {
  return process.env.SCAN_GEMMA4_MMPROJ ||
    join(gemma4ModelsDir(), 'mmproj-BF16.gguf');
}

export function gemma4MtpPath() {
  return process.env.SCAN_GEMMA4_MTP ||
    join(gemma4ModelsDir(), 'mtp-gemma-4-26B-A4B-it.gguf');
}

/**
 * The local artwork editor shares card 1 with the Qwen3.8 27B chat model, so only
 * one of them is resident at a time; Admin → Setup toggles between them.
 */
export function imageEditVulkanDevice() {
  return process.env.SCAN_IMAGE_DEVICE || llmVulkanDevice();
}

export function imageEditListenPort(id?: string) {
  void id;
  return Math.max(1, Number(process.env.SCAN_IMAGE_EDIT_PORT || process.env.SCAN_IMAGE_PORT) || 18092);
}

export function imageEditListenPorts(): number[] {
  return [imageEditListenPort('qwen-image-edit-2511')];
}

export function sdServerBin() {
  return process.env.SCAN_IMAGE_SD_SERVER ||
    discoverBinary('stable-diffusion.cpp', 'sd-server') ||
    join(homedir(), 'stable-diffusion.cpp/build-vulkan/bin/sd-server');
}

export function imageEditModelsDir() {
  return process.env.SCAN_IMAGE_MODELS_DIR || join(DATA_DIR, 'models/image');
}

/** Directory for the Qwen-Image-Edit-2511 weights. */
export function imageEditModelDir(id: string) {
  return process.env.SCAN_IMAGE_EDIT_MODEL_DIR || join(imageEditModelsDir(), id);
}

/** Qwen-Image-Edit-2511 keeps Qwen2.5-VL beside its own weights. */
export function imageEditTextEncoderDir(id: string) {
  return process.env.SCAN_IMAGE_EDIT_TEXT_ENCODER_DIR || imageEditModelDir(id);
}

/** Optional ComfyUI-style LoRAs for the local editor, loaded by name from here. */
export function imageEditLorasDir() {
  return process.env.SCAN_IMAGE_LORAS_DIR || join(imageEditModelsDir(), 'loras');
}

/** Gemma 4 soft-token budgets: 70, 140, 280, 560, or 1120 (max detail / OCR). */
export function gemma4ImageTokenBudget() {
  const raw = Number(
    process.env.SCAN_GEMMA4_IMAGE_TOKENS ??
      process.env.SCAN_GEMMA4_IMAGE_MAX_TOKENS ??
      1120,
  );
  const allowed = [70, 140, 280, 560, 1120];
  return allowed.includes(raw) ? raw : 1120;
}

/** ubatch/batch must fit all image tokens (non-causal vision attention). */
export function gemma4VisionBatchSize(budget = gemma4ImageTokenBudget()) {
  const raw = Number(process.env.SCAN_GEMMA4_VISION_BATCH);
  if (Number.isInteger(raw) && raw >= 512) return raw;
  return Math.max(2048, budget * 2);
}

export function llamaServerEnv(executable: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = vulkanLlamaEnv(env);
  const lib = dirname(executable);
  next.LD_LIBRARY_PATH = next.LD_LIBRARY_PATH ? `${lib}:${next.LD_LIBRARY_PATH}` : lib;
  return next;
}

/** `cleaning` is where Koharu, SAM, Big-LaMa and AOT run — pass `cleaningDeviceLabel()`. */
export function gpuClientStatus(cleaning = `HIP ${hipVisibleDevices()}`) {
  const models = managedRuntimeSummary();
  if (!komatoseGpuEnabled()) return {
    mode: models.length ? 'managed' as const : 'cpu' as const,
    label: models.length ? 'Managed models' : 'CPU',
    models,
    llm: models.map(m => `${m.name} on ${m.device}`).join(', ') || 'CPU',
    ocr: 'Per-model device (see Setup)',
    cleaning: 'Per-model device (see Setup)',
  };
  return {
    mode: 'komatose' as const,
    label: 'GPU',
    models,
    llm: models.length ? models.map(m => `${m.name} on ${m.device}`).join(', ') : 'Managed local models (see Setup for per-model status)',
    ocr: `Hayai, PaddleOCR-VL, and Qwen3-VL on ${reviewVulkanDevice()}`,
    cleaning: `Koharu SAM-TS-L, SAM, Big-LaMa, and AOT on ${cleaning}; LaMa Manga uses PyTorch on the cleaning device`,
  };
}

export function vulkanLlamaEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GGML_VK_ALLOW_GRAPHICS_QUEUE: '1' };
}

/**
 * llama.cpp's CLIP loader ignores `-dev` and puts the projector on the first discrete GPU.
 * `MTMD_BACKEND_DEVICE` is the name `--list-devices` prints (`Vulkan2`).
 * Pass nothing for a CPU launch so a parent environment cannot pin a GPU while offload is off.
 */
export function mmprojDeviceEnv(env: NodeJS.ProcessEnv, deviceName: string | undefined): NodeJS.ProcessEnv {
  const next = { ...env };
  const name = (deviceName || '').trim();
  if (name && name !== 'none' && name !== 'cpu') next.MTMD_BACKEND_DEVICE = name;
  else delete next.MTMD_BACKEND_DEVICE;
  return next;
}

export function hipWorkerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const devices = hipVisibleDevices();
  return {
    ...env,
    HIP_VISIBLE_DEVICES: devices,
    CUDA_VISIBLE_DEVICES: devices,
    HSA_OVERRIDE_GFX_VERSION: env.HSA_OVERRIDE_GFX_VERSION || '11.0.0',
    SAM2_BUILD_CUDA: '0',
  };
}
