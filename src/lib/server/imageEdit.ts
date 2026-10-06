import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_IMAGE_EDIT_MODEL_ID, IMAGE_EDIT_MODELS, imageEditLoraList, imageEditModelOf, imageEditWeightHost, type ImageEditModelId } from '../imageEdit';
import {
  imageEditListenPort, imageEditLorasDir as lorasDir,
  imageEditVulkanDevice, komatoseGpuEnabled, sdServerBin, vulkanLlamaEnv,
} from './gpuMode';
import { imageEditModelFiles, type ImageEditModelFiles } from './imageEditModels';
import { aliasFromArgs, flagValue, occupantOnPort, type PortOccupant } from './residentInference';
import { listManagedStatuses, operateManagedModel, waitManagedOperation } from './managedModels';
import { ROOT } from './paths';
import { devicePref, estimateNeedMiB, ggmlDevices, resolveDevice } from './computeDevices';
import type { ResolvedDevice } from '../computeDevices';

export type ImageEditState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/** One editor model the Admin panel can load into the shared card. */
export type ImageEditModelStatus = {
  id: ImageEditModelId;
  label: string;
  method: string;
  installed: boolean;
  quant?: string;
  /** True when this editor's own service is up. */
  active: boolean;
};

export type ImageEditStatus = {
  id: ImageEditModelId;
  label: string;
  installed: boolean;
  quant?: string;
  state: ImageEditState;
  device: string;
  /** Saved device choice for this editor. */
  deviceChoice: string;
  port: number;
  pid?: number;
  error?: string;
  /** Chat models on the same card that a start would unload. */
  displaced: string[];
  /** Chat models this editor unloaded; the card can be handed back to them. */
  evicted: string[];
  /** Weight servers on the same card that this app cannot unload. */
  foreign: { pid: number; label: string }[];
  /** Style LoRAs SCAN_IMAGE_LORAS asks the server to apply. */
  loras: string[];
  /** Both editors, so the panel can offer either without a second request. */
  models: ImageEditModelStatus[];
  busy: boolean;
};

type Recipe = { model: ImageEditModelFiles; quant: string; diffusion: string; vae: string };
type Service = { child: ChildProcess; url: string; port: number; adopted?: boolean; model: ImageEditModelId };

/**
 * 2511 and Lightning share one sd-server. Each id still has its own bookkeeping
 * so a clean can be busy on one method while the other stays idle.
 */
type ModelState = {
  service?: Service;
  state: ImageEditState;
  error?: string;
  operationId?: string;
  promise?: Promise<void>;
  queue: Promise<unknown>;
  activeRuns: number;
  /** Started from Admin → Models, so it holds its device until stopped by hand. */
  explicit?: boolean;
  evicted?: string[];
  idle?: NodeJS.Timeout;
};
type States = Record<ImageEditModelId, ModelState>;

const freshState = (): ModelState => ({ state: 'stopped', queue: Promise.resolve(), activeRuns: 0, evicted: [] });

const globalState = globalThis as typeof globalThis & { __scanImageEditStates?: States };
const states: States = (globalState.__scanImageEditStates ??= {
  'qwen-image-edit-2511': freshState(),
  'qwen-image-edit-2511-lightning': freshState(),
});

function modelState(id: ImageEditModelId): ModelState {
  const value = (states[id] ??= freshState());
  value.queue ??= Promise.resolve();
  value.activeRuns ??= 0;
  value.evicted ??= [];
  return value;
}

const root = () => process.env.SCAN_ROOT || ROOT;
const port = (id: ImageEditModelId) => imageEditListenPort(id);
const current = (id?: ImageEditModelId) => id ?? DEFAULT_IMAGE_EDIT_MODEL_ID;

/** Disk footprint a recipe will load; used for the VRAM fit checks. */
function needMiBFor(recipe: Recipe | null, id: ImageEditModelId): number {
  return recipe
    ? estimateNeedMiB([join(recipe.model.dir, recipe.diffusion), join(recipe.model.dir, recipe.vae),
      join(recipe.model.encoderDir, recipe.model.encoderFile), join(recipe.model.encoderDir, recipe.model.encoderVisionFile)], 2048)
    : 21_000;
}

/**
 * Where an editor runs: its saved choice, with Auto resolved against the GPUs present now.
 * Komatose GPU mode keeps SCAN_IMAGE_DEVICE (else the chat card) as its Auto answer.
 */
export function imageEditResolved(id?: ImageEditModelId): ResolvedDevice {
  const model = imageEditWeightHost(current(id));
  const recipe = installedImageEdit(current(id));
  const need = needMiBFor(recipe, model);
  const pinned = komatoseGpuEnabled() ? imageEditVulkanDevice() : (process.env.SCAN_IMAGE_DEVICE || '').trim() || undefined;
  return resolveDevice('llama', devicePref(model), need, { legacy: pinned });
}
const gpuOn = (id?: ImageEditModelId) => imageEditResolved(id).kind === 'gpu';
const device = (id?: ImageEditModelId) => {
  const resolved = imageEditResolved(id);
  return resolved.kind === 'gpu' ? resolved.name : 'cpu';
};
/** Readiness and status copy name the card only when the editor really uses one. */
const deviceLabel = (id?: ImageEditModelId) => {
  const resolved = imageEditResolved(id);
  return resolved.kind === 'gpu' ? resolved.label : 'CPU';
};
const bin = () => process.env.SCAN_IMAGE_SD_SERVER || sdServerBin();

/** How long an on-demand editor keeps its device after the last crop. */
function idleMs() {
  const seconds = Number(process.env.SCAN_IMAGE_IDLE_SECONDS ?? 180);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Cleaning starts the editor on demand and must give the card back. An editor
 * started from Admin → Models is the operator's explicit choice and stays up.
 */
function scheduleIdleStop(id: ImageEditModelId) {
  const state = modelState(id);
  if (weightBusy(id) || !gpuOn(id)) return;
  const wait = idleMs();
  if (!wait) return;
  clearTimeout(state.idle);
  const timer = setTimeout(() => {
    state.idle = undefined;
    if (weightBusy(id)) return;
    // Never reap a hand-started sd-server we merely adopted.
    const resident = liveService(id);
    if (!resident || resident.adopted) return;
    void stopImageEditServer(id).catch(() => {});
  }, wait);
  timer.unref?.();
  state.idle = timer;
}

const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

/**
 * Everything stable-diffusion.cpp needs for one editor, written by the matching installer.
 * Returns null when the weights, its text encoder, or the server binary are missing, so a
 * half-finished download never reports itself as usable.
 */
export function installedImageEdit(id: ImageEditModelId): Recipe | null {
  const model = imageEditModelFiles()[id];
  try {
    const marker = JSON.parse(readFileSync(join(model.dir, 'installed.json'), 'utf8'));
    const diffusion = String(marker?.diffusion?.file || model.fallback.diffusion);
    const vae = String(marker?.vae?.file || model.fallback.vae);
    if (!existsSync(join(model.dir, diffusion)) || !existsSync(join(model.dir, vae))) return null;
    // The encoder file name is recorded too, since the installer lets the quant be chosen.
    const encoderFile = String(marker?.textEncoder?.file || model.encoderFile);
    const encoderVision = String(marker?.textEncoder?.vision || model.encoderVisionFile);
    if (!existsSync(join(model.encoderDir, encoderFile))) return null;
    if (!existsSync(join(model.encoderDir, encoderVision))) return null;
    if (!existsSync(bin())) return null;
    const editor = imageEditModelOf(id);
    if (editor.lora) {
      const names = imageEditLoraList(editor, process.env);
      if (!names.length || names.some((lora) => !existsSync(join(lorasDir(), lora.path)))) return null;
    }
    return { model, quant: String(marker.quant || 'q8'), diffusion, vae };
  } catch {
    return null;
  }
}

/** Editors that load one diffusion file share one sd-server. */
function sameWeights(a: ImageEditModelId, b: ImageEditModelId): boolean {
  return imageEditWeightHost(a) === imageEditWeightHost(b);
}

function siblingIds(id: ImageEditModelId): ImageEditModelId[] {
  return IMAGE_EDIT_MODELS.map((entry) => entry.id).filter((other) => sameWeights(other, id));
}

/** The live process for this weight set, whichever editor started it. */
function liveService(id: ImageEditModelId): Service | undefined {
  for (const other of siblingIds(id)) {
    const service = modelState(other).service;
    if (service && service.child.exitCode === null && service.child.signalCode === null) return service;
  }
  return undefined;
}

function weightBusy(id: ImageEditModelId): boolean {
  return siblingIds(id).some((other) => {
    const state = modelState(other);
    return state.explicit || state.activeRuns > 0;
  });
}

/** Every editor and whether its own service is up, for the Admin panel and method picker. */
export function imageEditModelStatuses(): ImageEditModelStatus[] {
  return IMAGE_EDIT_MODELS.map((entry) => {
    const recipe = installedImageEdit(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      method: entry.method,
      installed: Boolean(recipe),
      quant: recipe?.quant,
      active: Boolean(installedImageEdit(entry.id) && liveService(entry.id)),
    };
  });
}

/**
 * Weight servers holding this editor's card, keyed by the app's own row when it has
 * one. Readiness state is not enough here: an adopted process reports "stopped"
 * until it is checked, so occupancy comes from the live pid and its argv device.
 */
function deviceUsers(id: ImageEditModelId): { pid: number; label: string; managed?: string }[] {
  if (!gpuOn(id)) return [];
  const want = device(id);
  const managedByPid = new Map<number, string>();
  for (const row of listManagedStatuses())
    if (typeof row.pid === 'number') managedByPid.set(row.pid, String(row.id));
  let listing = '';
  try {
    listing = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 2000 });
  } catch {
    return [];
  }
  const ours = modelState(id).service?.child.pid;
  const found: { pid: number; label: string; managed?: string }[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === ours) continue;
    const args = match[2].split(/\s+/);
    if (!args.some((arg) => /(?:llama|sd)-server$|hayai_review\.py$/.test(arg))) continue;
    const onDevice =
      flagValue(args, ['-dev', '--device']) === want ||
      args.some((arg) => arg.split(/[=,]/).includes(want));
    if (!onDevice || flagValue(args, ['-ngl', '--n-gpu-layers']) === '0') continue;
    found.push({
      pid,
      label: aliasFromArgs(args) || `${basename(args[0])} (pid ${pid})`,
      managed: managedByPid.get(pid),
    });
  }
  return found;
}

/** Whatever chat model on this editor's device a start would unload. */
export function displacedChatModels(id?: ImageEditModelId): string[] {
  return deviceUsers(current(id))
    .map((user) => user.managed)
    .filter((found): found is string => Boolean(found));
}

/**
 * Weight servers on the editor's card that this app does not manage, so they cannot
 * be unloaded here. Naming them explains why a start still streams weights from RAM.
 */
export function foreignResidentsOnDevice(id?: ImageEditModelId): { pid: number; label: string }[] {
  return deviceUsers(current(id))
    .filter((user) => !user.managed)
    .map(({ pid, label }) => ({ pid, label }));
}

export type ImageEditModule = 'diffusion' | 'te' | 'vae';

export type ImageEditDeviceBudget = {
  name: string;
  freeMiB: number;
  integrated?: boolean;
};

export type ImageEditBackendPlan = {
  /** `--backend` assignment. Each module's weights stay on this compute device. */
  backend: string;
  /** `--max-vram` for integrated cards that must not receive spilled weights. */
  maxVram: string;
};

/** Matches sd.cpp auto-fit: a card's own scratch, on top of the weights. */
const MODULE_RESERVE_MIB: Record<ImageEditModule, number> = { diffusion: 2048, te: 2048, vae: 1024 };
/** sd.cpp subtracts this from free VRAM before it will place weights. */
const DEVICE_SLACK_MIB = 512;
/** Negative GiB: auto-fit treats the card as having no room for weights. */
const HIDDEN_VRAM_GIB = -1024;

/**
 * Auto-fit keeps weights on the compute card, then in RAM, then on whichever
 * other GPU reports the most free memory. An iGPU reports system RAM as VRAM,
 * so it wins that comparison, and ggml-vulkan pins the RAM copy on Vulkan
 * device 0 — the iGPU. A module that does not fit on the chosen card is placed
 * wholly on another discrete card instead, and unused iGPUs are given no budget.
 */
export function placeImageEditModules(
  card: string,
  sizesMiB: Record<ImageEditModule, number>,
  devices: ImageEditDeviceBudget[],
): ImageEditBackendPlan {
  const budget = new Map<string, number>();
  for (const entry of devices) {
    if (entry.integrated && entry.name !== card) continue;
    budget.set(entry.name, Math.max(0, entry.freeMiB - DEVICE_SLACK_MIB));
  }
  if (!budget.has(card)) budget.set(card, Number.POSITIVE_INFINITY);

  const assigned: Record<ImageEditModule, string> = { diffusion: card, te: card, vae: card };
  for (const key of ['diffusion', 'te', 'vae'] as const) {
    const size = Math.max(0, sizesMiB[key] || 0);
    const need = size > 0 ? size + MODULE_RESERVE_MIB[key] : 0;
    const candidates = [...budget.entries()].sort((a, b) => {
      if (a[0] === card) return -1;
      if (b[0] === card) return 1;
      return b[1] - a[1];
    });
    const fit = candidates.find(([, free]) => free >= need);
    // Leave a module that fits nowhere on the chosen card. Auto-fit may then
    // stream it from RAM; it must not also be charged against that card.
    if (!fit) continue;
    assigned[key] = fit[0];
    const left = budget.get(fit[0]);
    if (left !== undefined && Number.isFinite(left)) budget.set(fit[0], left - size);
  }

  const used = new Set(Object.values(assigned));
  const maxVram = devices
    .filter((entry) => entry.integrated && !used.has(entry.name))
    .map((entry) => `${entry.name}=${HIDDEN_VRAM_GIB}`)
    .join(',');
  const backend = (['diffusion', 'vae', 'te'] as const)
    .map((key) => `${key}=${assigned[key]}`)
    .join(',');
  return { backend, maxVram };
}

function fileMiB(path: string): number {
  try {
    return statSync(path).size / (1024 * 1024);
  } catch {
    return 0;
  }
}

function serverArgs(recipe: Recipe, listenPort: number): string[] {
  const { model } = recipe;
  const gpu = gpuOn(model.id);
  const args = [
    '--diffusion-model', join(model.dir, recipe.diffusion),
    '--vae', join(model.dir, recipe.vae),
    '--llm', join(model.encoderDir, model.encoderFile),
    '--llm_vision', join(model.encoderDir, model.encoderVisionFile),
    '--listen-ip', '127.0.0.1',
    '--listen-port', String(listenPort),
  ];
  const card = device(model.id);
  if (gpu) {
    const plan = placeImageEditModules(card, {
      diffusion: fileMiB(join(model.dir, recipe.diffusion)),
      te: fileMiB(join(model.encoderDir, model.encoderFile)) + fileMiB(join(model.encoderDir, model.encoderVisionFile)),
      vae: fileMiB(join(model.dir, recipe.vae)),
    }, ggmlDevices(0).devices);
    args.push('--backend', plan.backend, '--diffusion-fa');
    if (plan.maxVram) args.push('--max-vram', plan.maxVram);
  } else args.push('--backend', 'cpu');
  if (model.modelArgs.length) args.push('--model-args', ...model.modelArgs);
  args.push(...model.flags);
  // Style LoRAs named by SCAN_IMAGE_LORAS resolve against this directory.
  args.push('--lora-model-dir', lorasDir());
  if ((process.env.SCAN_IMAGE_OFFLOAD_TO_CPU || '').trim() === '1') args.push('--offload-to-cpu');
  return args;
}

function childEnv(id: ImageEditModelId): NodeJS.ProcessEnv {
  const threads = String(Math.max(1, Math.min(32, Number(process.env.SCAN_IMAGE_THREADS) || 8)));
  return vulkanLlamaEnv({
    ...process.env,
    OMP_NUM_THREADS: threads,
    MKL_NUM_THREADS: threads,
    ...(gpuOn(id) ? {} : { CUDA_VISIBLE_DEVICES: '', HIP_VISIBLE_DEVICES: '' }),
  });
}

/** One log per editor, so a switch does not bury the previous model's startup. */
function logPath(id: ImageEditModelId) {
  const dir = join(root(), 'data/logs');
  mkdirSync(dir, { recursive: true });
  return join(dir, `image-${id}.log`);
}

/** sd-server exposes no /health; /v1/models only answers once the weights are loaded. */
async function serving(url: string, abort?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(2500)]),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => ({}))) as { data?: { id?: string }[] };
    return (body.data || []).some((row) => typeof row.id === 'string' && row.id.length > 0);
  } catch {
    return false;
  }
}

function occupiedBy(occ: PortOccupant, listenPort: number) {
  const who = occ.alias || 'another process';
  return `Port ${listenPort} is occupied by ${who}${occ.pid ? ` (pid ${occ.pid})` : ''}, not a local artwork editor.`;
}

/** sd-server has no API key, so ownership is proven by the weights in its argv. */
function ownsPort(occ: PortOccupant, id?: ImageEditModelId): boolean {
  const args = processArgsOf(occ.pid);
  const hosts = id
    ? [imageEditWeightHost(id)]
    : [...new Set(IMAGE_EDIT_MODELS.map((entry) => imageEditWeightHost(entry.id)))];
  return hosts.some((host) => {
    const recipe = installedImageEdit(host);
    return recipe ? args.some((arg) => arg.includes(recipe.diffusion)) : false;
  });
}

/** Adopts a hand-started server on this editor's port, after proving its weights. */
async function adopt(abort: AbortSignal, id: ImageEditModelId): Promise<Service | undefined> {
  const listenPort = port(id);
  const occ = occupantOnPort(listenPort);
  if (!occ) return;
  const recipe = installedImageEdit(id);
  const args = processArgsOf(occ.pid);
  if (!recipe || !args.some((arg) => arg.includes(recipe.diffusion)))
    throw failure(occupiedBy(occ, listenPort));
  const url = `http://127.0.0.1:${listenPort}`;
  if (!(await serving(url, abort))) throw failure(occupiedBy(occ, listenPort));
  return { child: adoptedChild(), url, port: listenPort, adopted: true, model: id };
}

function processArgsOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function adoptedChild(): ChildProcess {
  return { kill() { return true; }, exitCode: null, killed: false, pid: 0 } as ChildProcess;
}

function drop(id: ImageEditModelId) {
  const state = modelState(id);
  state.service = undefined;
}

/** Poll a launched or adopted service until it answers /v1/models. */
async function awaitServing(
  id: ImageEditModelId,
  instance: Service,
  path: string,
  abort: AbortSignal,
  spawnError: () => Error | undefined,
): Promise<Service> {
  const deadline = Date.now() + (komatoseGpuEnabled() ? 15 * 60_000 : 5 * 60_000);
  while (Date.now() < deadline) {
    abort.throwIfAborted();
    const failed = spawnError();
    if (failed) throw failed;
    if (instance.child.exitCode !== null || instance.child.signalCode !== null)
      throw new Error(`${modelFiles(id).label} failed to start. See ${path}`);
    if (await serving(instance.url, abort)) return instance;
    await delay(400, undefined, { signal: abort });
  }
  instance.child.kill('SIGTERM');
  if (modelState(id).service === instance) drop(id);
  throw new Error(`${modelFiles(id).label} startup timed out. See ${path}`);
}

const modelFiles = (id: ImageEditModelId) => imageEditModelFiles()[id];

/** The install instruction for whichever editor was asked for. */
export function missingImageEditError(id: ImageEditModelId) {
  const script = id === 'qwen-image-edit-2511-lightning'
    ? 'scripts/install-image-edit-model.py --lightning'
    : 'scripts/install-image-edit-model.py';
  return failure(
    `${modelFiles(id).label} is not installed. Run ${script} and build stable-diffusion.cpp (${bin()}).`,
    400,
  );
}

/**
 * Two editors may share a device only when they fit together. Otherwise a start
 * must not silently unload the other — the operator moves one to another device.
 */
function editorConflictFor(id: ImageEditModelId): { label: string; device: string } | undefined {
  const resolved = imageEditResolved(id);
  if (resolved.kind !== 'gpu') return undefined;
  for (const entry of IMAGE_EDIT_MODELS) {
    if (entry.id === id || sameWeights(entry.id, id)) continue;
    const other = modelState(entry.id);
    if (other.state !== 'running' && other.state !== 'starting') continue;
    const otherResolved = imageEditResolved(entry.id);
    if (otherResolved.kind !== 'gpu' || otherResolved.name !== resolved.name) continue;
    const totalMiB = ggmlDevices().devices.find((item) => item.name === resolved.name)?.totalMiB ?? 0;
    const combined = needMiBFor(installedImageEdit(id), id) + needMiBFor(installedImageEdit(entry.id), entry.id);
    if (totalMiB > 0 && combined > totalMiB * 0.95)
      return { label: modelFiles(entry.id).label, device: resolved.name };
  }
  return undefined;
}

async function start(abort: AbortSignal, id: ImageEditModelId): Promise<Service> {
  const recipe = installedImageEdit(id);
  if (!recipe) throw missingImageEditError(id);
  const state = modelState(id);
  const existing = liveService(id);
  if (existing) {
    // Reuse the process already on the port, ours or adopted, rather than starting a
    // second copy that cannot bind; a dead or hung one is dropped below.
    if (existing.child.exitCode === null && existing.child.signalCode === null) {
      if (await serving(existing.url, abort)) {
        state.service = existing;
        state.state = 'running';
        return existing;
      }
      const ready = await awaitServing(id, existing, logPath(id), abort, () => undefined);
      state.service = ready;
      state.state = 'running';
      return ready;
    }
    drop(id);
  }
  const conflict = editorConflictFor(id);
  if (conflict)
    throw failure(
      `${conflict.label} is resident on ${conflict.device} and the two editors do not fit there together. ` +
      `Move ${modelFiles(id).label} to another device in Admin → Models, or stop ${conflict.label} first.`,
    );
  const adopted = await adopt(abort, id);
  if (adopted) {
    state.service = adopted;
    state.state = 'running';
    return adopted;
  }
  abort.throwIfAborted();
  const listenPort = port(id);
  const path = logPath(id);
  const log = openSync(path, 'a', 0o600);
  let child: ChildProcess;
  try {
    child = spawn(bin(), serverArgs(recipe, listenPort), {
      cwd: root(), stdio: ['ignore', log, log], env: childEnv(id), detached: true,
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  const instance: Service = { child, url: `http://127.0.0.1:${listenPort}`, port: listenPort, model: id };
  state.service = instance;
  const ready = await awaitServing(id, instance, path, abort, () => spawnError);
  // On-demand starts land here too; the state flag is what "Loaded" reads.
  state.state = 'running';
  return ready;
}

async function service(abort: AbortSignal, id: ImageEditModelId): Promise<Service> {
  const state = modelState(id);
  if (state.service && (await serving(state.service.url, abort))) return state.service;
  // The editor shares its card with a chat model. Claiming the card first is what lets the
  // weights sit in VRAM instead of being streamed from RAM on every step.
  if (gpuOn(id)) await releaseCardForImageEdit(id);
  return start(abort, id);
}

/** Unload the chat models on this editor's device before it claims the card. */
export async function releaseCardForImageEdit(id?: ImageEditModelId): Promise<string[]> {
  const model = current(id);
  const displaced = displacedChatModels(model);
  for (const chatId of displaced) {
    operateManagedModel(chatId, 'stop');
    await waitManagedOperation(chatId);
  }
  // Remembered so Admin → Models can hand the card back to the chat model.
  if (displaced.length) modelState(model).evicted = displaced;
  return displaced;
}

/** The reverse toggle: a chat model claiming an editor's device stops that editor. */
export async function releaseImageEditForDevice(claim: string): Promise<boolean> {
  let stopped = false;
  for (const entry of IMAGE_EDIT_MODELS) {
    const id = entry.id;
    const state = modelState(id);
    const matches = claim === device(id) || claim === devicePref(id);
    if (!matches || !gpuOn(id)) continue;
    const occ = occupantOnPort(port(id));
    if (!state.service && !occ) continue;
    if (!state.service && occ && !ownsPort(occ, id)) continue;
    await stopImageEditServer(id);
    stopped = true;
  }
  return stopped;
}

/** One editor's service record: state, device, and what a start would displace. */
export function imageEditStatus(id: ImageEditModelId = DEFAULT_IMAGE_EDIT_MODEL_ID): ImageEditStatus {
  const state = modelState(id);
  const models = imageEditModelStatuses();
  const recipe = installedImageEdit(id);
  const listenPort = port(id);
  const occ = occupantOnPort(listenPort);
  const base = {
    id,
    label: modelFiles(id).label,
    installed: Boolean(recipe),
    quant: recipe?.quant,
    device: deviceLabel(id),
    deviceChoice: devicePref(imageEditWeightHost(id)),
    port: listenPort,
    displaced: displacedChatModels(id),
    evicted: state.evicted ?? [],
    foreign: foreignResidentsOnDevice(id),
    loras: imageEditLoraList(imageEditModelOf(id), process.env).map((lora) => lora.path),
    models,
    busy: state.activeRuns > 0,
  };
  if (occ && !state.service?.adopted && !ownsPort(occ, id))
    return { ...base, state: 'error', pid: occ.pid, error: occupiedBy(occ, listenPort) };
  if (state.state === 'starting' || state.state === 'stopping')
    return { ...base, state: state.state, pid: occ?.pid, error: state.error };
  const resident = liveService(id);
  if (resident && occ && ownsPort(occ, id) && installedImageEdit(id))
    return { ...base, state: 'running', pid: occ.pid };
  if (state.state === 'error') return { ...base, state: 'error', error: state.error };
  return { ...base, state: 'stopped' };
}

/** Both editors, each with its own service record. */
export function imageEditStatuses(): ImageEditStatus[] {
  return IMAGE_EDIT_MODELS.map((entry) => imageEditStatus(entry.id));
}

export async function stopImageEditServer(id: ImageEditModelId = DEFAULT_IMAGE_EDIT_MODEL_ID): Promise<void> {
  const instance = liveService(id);
  const listenPort = port(id);
  const occ = occupantOnPort(listenPort);
  if (instance && !instance.adopted) instance.child.kill('SIGTERM');
  for (const other of siblingIds(id)) {
    drop(other);
    const sibling = modelState(other);
    sibling.explicit = false;
    if (other !== id && (sibling.state === 'running' || sibling.state === 'error')) sibling.state = 'stopped';
  }
  // A foreign service on this port is never touched; ownership comes from the weights.
  if (!occ || !ownsPort(occ, id)) return;
  try { process.kill(occ.pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 15_000;
  while (occupantOnPort(listenPort)?.pid === occ.pid && Date.now() < deadline) await delay(100);
  if (occupantOnPort(listenPort)?.pid === occ.pid) {
    try { process.kill(occ.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 30 && occupantOnPort(listenPort)?.pid === occ.pid; i++) await delay(100);
  }
  if (occupantOnPort(listenPort)?.pid === occ.pid) throw failure(`${modelFiles(id).label} did not stop`);
}

/** Shutdown: both editors are ours to reap. */
export async function stopAllImageEditServers(): Promise<void> {
  for (const entry of IMAGE_EDIT_MODELS) {
    try { await stopImageEditServer(entry.id); } catch { /* best effort */ }
  }
}

/**
 * Starts, stops, or restarts the shared artwork-editor service. Lightning and
 * 2511 load the same weights, so either action applies to that one process.
 */
export function operateImageEditServer(
  action: 'start' | 'stop' | 'restart',
  id: ImageEditModelId = DEFAULT_IMAGE_EDIT_MODEL_ID,
): ImageEditStatus {
  const state = modelState(id);
  if (action !== 'stop' && !installedImageEdit(id)) throw missingImageEditError(id);
  if (state.state === 'starting' || state.state === 'stopping')
    throw failure('A start or stop is already in progress', 409);
  if ((action === 'stop' || action === 'restart') && siblingIds(id).some((other) => modelState(other).activeRuns))
    throw failure('A cleaning run is in progress. Finish or cancel it first.', 409);
  state.operationId = randomUUID();
  state.error = undefined;
  state.state = action === 'stop' ? 'stopping' : 'starting';
  state.explicit = action !== 'stop';
  clearTimeout(state.idle);
  state.idle = undefined;
  const gate = modelState(imageEditWeightHost(id));
  state.promise = gate.queue.then(async () => {
    try {
      if (action !== 'start') await stopImageEditServer(id);
      if (action !== 'stop') {
        if (gpuOn(id)) await releaseCardForImageEdit(id);
        await start(new AbortController().signal, id);
        state.state = 'running';
      } else {
        state.state = 'stopped';
        state.evicted = [];
      }
    } catch (error) {
      state.state = 'error';
      state.error = error instanceof Error ? error.message : String(error);
    }
  });
  gate.queue = state.promise.catch(() => {});
  return imageEditStatus(id);
}

export async function waitImageEditOperation(id: ImageEditModelId = DEFAULT_IMAGE_EDIT_MODEL_ID) {
  await modelState(id).promise;
}

/** Cleaning runs hold the editor open and cancel cleanly; the model is loaded on demand. */
export async function withImageEdit<T>(
  id: ImageEditModelId,
  run: (baseUrl: string) => Promise<T>,
  abort?: AbortSignal,
): Promise<T> {
  abort?.throwIfAborted();
  const state = modelState(id);
  const gate = modelState(imageEditWeightHost(id));
  const queued = gate.queue.then(async () => {
    abort?.throwIfAborted();
    const signal = AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(30 * 60_000)]);
    const host = await service(signal, id);
    state.activeRuns++;
    try { return await run(host.url); }
    finally {
      state.activeRuns = Math.max(0, state.activeRuns - 1);
      scheduleIdleStop(id);
    }
  });
  gate.queue = queued.catch(() => {});
  if (!abort) return queued;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abort.reason ?? new Error('Cancelled'));
    abort.addEventListener('abort', cancel, { once: true });
    queued.then(resolve, reject).finally(() => abort.removeEventListener('abort', cancel));
    if (abort.aborted) cancel();
  });
}

/**
 * Readiness for one editor, for the cleaning method picker. Never starts or unloads
 * anything; it reports what a run would do so the picker can warn about the card.
 */
export async function probeImageEditCleaning(
  id: ImageEditModelId = DEFAULT_IMAGE_EDIT_MODEL_ID,
): Promise<{ available: boolean; reason: string }> {
  const label = modelFiles(id).label;
  if (!installedImageEdit(id))
    return { available: false, reason: `${label} is not installed` };
  const conflict = editorConflictFor(id);
  if (conflict)
    return {
      available: false,
      reason: `${conflict.label} is resident on ${conflict.device} and the two editors do not fit there together — move ${label} to another device in Admin → Models, or stop ${conflict.label}`,
    };
  const resident = liveService(id);
  if (resident && (await serving(resident.url)))
    return { available: true, reason: `${label} is resident on ${deviceLabel(id)}` };
  const displaced = displacedChatModels(id);
  if (displaced.length)
    return {
      available: true,
      reason: `Starting it unloads ${displaced.join(', ')} from ${deviceLabel(id)}; switch in Admin → Models → Hardware`,
    };
  return { available: true, reason: `Starts ${label} on ${deviceLabel(id)} when cleaning runs` };
}

export function stopImageEditOnShutdown() {
  for (const entry of IMAGE_EDIT_MODELS) {
    const state = modelState(entry.id);
    clearTimeout(state.idle);
    if (state.service && !state.service.adopted) state.service.child.kill('SIGTERM');
  }
}

if (!komatoseGpuEnabled() && !(globalThis as { __scanImageEditCleanup?: boolean }).__scanImageEditCleanup) {
  (globalThis as { __scanImageEditCleanup?: boolean }).__scanImageEditCleanup = true;
  process.once('exit', stopImageEditOnShutdown);
}
