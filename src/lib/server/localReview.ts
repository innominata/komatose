import { pythonRuntimePath, withPythonRuntime } from './pythonRuntimeMaintenance';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCAL_REVIEW_MODELS, localReviewModel, type LocalReviewModelId } from '../localReviewModels';
import type { OcrLang } from '../types';
import {
  hipVisibleDevices, hipWorkerEnv, komatoseGpuEnabled, llamaServerBin, llmListenPort,
  mmprojDeviceEnv, reviewListenPort, reviewVulkanDevice, vulkanLlamaEnv,
} from './gpuMode';
import {
  clearSavedToken, occupantOnPort, readSavedToken, reviewServiceVerdict, writeSavedToken,
  type PortOccupant,
} from './residentInference';
import { DATA_DIR, ROOT } from './paths';
import { devicePref, ensureTorchProbe, estimateNeedMiB, resolveDevice, torchDeviceEnv } from './computeDevices';
import { isAutoChoice, type ResolvedDevice } from '../computeDevices';
import type { ModelRow } from '../modelRegistry';
import { findRegistryRow, listRegistryRows } from './modelRegistryStore';
import { managedModelStatus, operateManagedModel, waitManagedOperation } from './managedModels';
import { modelHttpConfig } from './modelConnection';

type Service = { child: ChildProcess; url: string; token: string; ready: Promise<void>; adopted?: boolean; runtimePath?: string };
export type ReviewServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type ReviewServerStatus = {
  id: LocalReviewModelId;
  label: string;
  installed: boolean;
  state: ReviewServerState;
  port?: number;
  pid?: number;
  device?: string;
  /** Saved device choice: `auto`, `cpu`, or a device name. */
  deviceChoice?: string;
  served?: string;
  error?: string;
  operationId?: string;
  busy: boolean;
};
type Lifecycle = { state: ReviewServerState; operationId?: string; error?: string; promise?: Promise<void> };
type State = {
  services: Map<string, Service>;
  queue: Promise<unknown>;
  idle?: NodeJS.Timeout;
  cleanupRegistered?: boolean;
  activeRuns: number;
  starting: Map<string, Promise<Service>>;
  lifecycle: Map<string, Lifecycle>;
};
const global = globalThis as typeof globalThis & { __scanLocalReview?: State };
const state: State = global.__scanLocalReview ??= {
  services: new Map(), queue: Promise.resolve(), activeRuns: 0, starting: new Map(), lifecycle: new Map(),
};
state.activeRuns ??= 0;
state.starting ??= new Map();
state.lifecycle ??= new Map();
const root = () => process.env.SCAN_ROOT || ROOT;
const modelDir = () => process.env.SCAN_REVIEW_MODELS_DIR || join(DATA_DIR, 'models/review');
const python = () => process.env.SCAN_REVIEW_PYTHON || join(root(), '.venv-review/bin/python');
const pythonForReview = (id: LocalReviewModelId) => id === 'pp-ocrv5-korean'
  ? process.env.PADDLEOCR_PYTHON || join(root(), '.venv-ocr/bin/python') : python();
const llama = () => process.env.SCAN_REVIEW_LLAMA_SERVER || llamaServerBin() || join(homedir(), 'llama.cpp/build-vulkan/bin/llama-server');
// A plain object keeps keyof equal to the python ids; the annotation would widen it to
// every LocalReviewModelId and collapse LlamaReviewModelId to never.
const PYTHON_REVIEW_SCRIPTS = {
  'hayai-ocr-v2': 'hayai_review.py',
  'hayai-ocr-v2.5-nova': 'hayai_review.py',
  'pp-ocrv5-korean': 'ppocr_korean_review.py',
  'manga-ocr': 'manga_ocr_review.py',
} satisfies Partial<Record<LocalReviewModelId, string>>;
const files: Record<LocalReviewModelId, string[]> = {
  'hayai-ocr-v2': ['model.safetensors', 'config.json', 'modeling_hayai.py', 'configuration_hayai.py', 'tokenizer.json'],
  'hayai-ocr-v2.5-nova': ['model.safetensors', 'config.json', 'modeling_hayai.py', 'configuration_hayai.py', 'tokenizer.json'],
  'pp-ocrv5-korean': ['recognizer/inference.pdiparams', 'recognizer/inference.json', 'recognizer/inference.yml', 'detector/inference.pdiparams', 'detector/inference.json', 'detector/inference.yml'],
  'manga-ocr': ['model.safetensors', 'config.json', 'preprocessor_config.json', 'tokenizer_config.json', 'vocab.txt'],
  'paddleocr-vl-1.6': ['PaddleOCR-VL-1.6-GGUF.gguf', 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', 'chat_template.jinja'],
  'qwen3-vl-8b': ['Qwen3-VL-8B-Instruct-Q8_0.gguf', 'mmproj-F16.gguf'],
};
const pythonReviewModel = (id: LocalReviewModelId) => id in PYTHON_REVIEW_SCRIPTS;
/** The python review script for an id, if that id runs through python rather than llama. */
const pythonReviewScript = (id: LocalReviewModelId): string | undefined =>
  id in PYTHON_REVIEW_SCRIPTS ? PYTHON_REVIEW_SCRIPTS[id as keyof typeof PYTHON_REVIEW_SCRIPTS] : undefined;
export type TranscriptionModelId = Exclude<LocalReviewModelId, 'qwen3-vl-8b'>;
const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

export function installedLocalReviewModels() {
  try {
    const installed = JSON.parse(readFileSync(join(modelDir(), 'installed.json'), 'utf8'));
    return LOCAL_REVIEW_MODELS.filter(model => installed[model.id] &&
      existsSync(pythonReviewModel(model.id) ? pythonForReview(model.id) : llama()) &&
      files[model.id].every(file => existsSync(join(modelDir(), model.id, file))))
      .map(model => reviewResolved(model.id).kind === 'gpu' ? { ...model, label: `${model.label} · GPU` } : model);
  } catch { return []; }
}

function lifecycle(id: string): Lifecycle {
  let entry = state.lifecycle.get(id);
  if (!entry) {
    entry = { state: 'stopped' };
    state.lifecycle.set(id, entry);
  }
  return entry;
}

/**
 * Where a review server runs: its saved choice, with Auto resolved against the GPUs
 * present now. Komatose GPU mode keeps its pinned cards as the Auto answer.
 */
export function reviewResolved(id: LocalReviewModelId): ResolvedDevice {
  if (id === 'pp-ocrv5-korean') return { kind: 'cpu', label: 'CPU', reason: 'PaddlePaddle recognizer runs on CPU, including AMD systems' };
  const need = estimateNeedMiB(files[id].map(file => join(modelDir(), id, file)), pythonReviewModel(id) ? 1536 : 768);
  const pinned = komatoseGpuEnabled();
  if (pythonReviewModel(id))
    return resolveDevice('torch', devicePref(id), need, { env: 'env-review', legacy: pinned ? hipVisibleDevices() : undefined });
  return resolveDevice('llama', devicePref(id), need, { legacy: pinned ? reviewVulkanDevice() : undefined });
}

function reviewDevice(id: LocalReviewModelId) {
  const device = reviewResolved(id);
  return device.kind === 'gpu' ? device.label : 'CPU';
}

function occupiedMessage(id: LocalReviewModelId, occ: PortOccupant, port: number) {
  const want = localReviewModel(id)!;
  const who = occ.alias || 'another process';
  const hint = occ.alias && occ.alias !== id
    ? ` Stop ${who} on Admin → Setup or move it to port ${llmListenPort()} (SCAN_LLM_PORT).`
    : '';
  return `Port ${port} is occupied by ${who}${occ.pid ? ` (pid ${occ.pid})` : ''}, not ${want.label}.${hint}`;
}

function dropService(id: string) {
  state.services.delete(id);
}

export function stopLocalReviewModels() {
  clearTimeout(state.idle);
  for (const service of state.services.values()) {
    if (!service.adopted) service.child.kill('SIGTERM');
  }
  state.services.clear();
}
/** Called after runtime requests drain. External resident services are not ours to retire. */
export async function retirePythonReviewWorkers(runtime: 'env-review' | 'env-ocr' = 'env-review') {
  const ids = Object.keys(PYTHON_REVIEW_SCRIPTS).filter(id => (id === 'pp-ocrv5-korean') === (runtime === 'env-ocr')) as LocalReviewModelId[];
  if (ids.some(id => state.services.get(id)?.adopted)) throw failure('Stop the externally owned Python review server before upgrading its runtime');
  await Promise.all(ids.map(id => terminateOwned(id)));
}
function stopPythonReview() {
  for (const id of Object.keys(PYTHON_REVIEW_SCRIPTS) as LocalReviewModelId[]) {
    const service = state.services.get(id);
    if (!service || service.adopted) continue;
    service.child.kill('SIGTERM');
    state.services.delete(id);
  }
}
// CPU children belong to the app. GPU llama-server/Hayai stay loaded across Svelte rebuilds.
if (!state.cleanupRegistered) {
  state.cleanupRegistered = true;
  if (!komatoseGpuEnabled()) {
    process.once('exit', stopLocalReviewModels);
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        stopLocalReviewModels();
        // Preserve the default signal exit when no other shutdown handler owns it.
        if (!process.listenerCount(signal)) process.kill(process.pid, signal);
      });
    }
  }
}

function adoptedChild(): ChildProcess {
  return { kill() { return true; }, exitCode: null, killed: false, pid: 0 } as ChildProcess;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

type LlamaReviewModelId = Exclude<LocalReviewModelId, keyof typeof PYTHON_REVIEW_SCRIPTS>;

function llamaArgs(id: LlamaReviewModelId, dir: string, port: number, token: string, threads: string, device: ResolvedDevice) {
  const common = ['-m', join(dir, files[id][0]), '--mmproj', join(dir, files[id][1]),
    '--alias', id, '--host', '127.0.0.1', '--port', String(port), '--api-key', token,
    '-t', threads, '-tb', threads, '-c', '8192', '-b', '512', '-ub', '128',
    '--jinja', '--temp', '0',
    ...(id === 'paddleocr-vl-1.6' ? ['--chat-template-file', join(dir, 'chat_template.jinja')] : [])];
  if (device.kind === 'gpu')
    return [...common, '-dev', device.name, '-ngl', '999', '--mmproj-offload', '-fit', 'off', '-fa', 'on',
      '-np', id.startsWith('qwen3-vl') ? '2' : '4'];
  return [...common, '--device', 'none', '-ngl', '0', '--no-mmproj-offload', '-fit', 'off', '-np', '1'];
}

function childEnv(id: LocalReviewModelId): NodeJS.ProcessEnv {
  const threads = String(Math.max(1, Math.min(32, Number(process.env.SCAN_REVIEW_THREADS) || 8)));
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HOME: join(modelDir(), 'hf-cache'), HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
    PYTHONUNBUFFERED: '1', OMP_NUM_THREADS: threads, MKL_NUM_THREADS: threads,
  };
  if (!pythonReviewModel(id)) {
    const device = reviewResolved(id);
    return mmprojDeviceEnv(vulkanLlamaEnv(base), device.kind === 'gpu' ? device.name : undefined);
  }
  if (id === 'pp-ocrv5-korean') return { ...base, CUDA_VISIBLE_DEVICES: '', HIP_VISIBLE_DEVICES: '', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' };
  if (komatoseGpuEnabled() && isAutoChoice(devicePref(id))) return hipWorkerEnv(base, python());
  return torchDeviceEnv(reviewResolved(id), base);
}

function bindUrl(port: number) {
  return `http://127.0.0.1:${port}`;
}

async function verdictFor(id: LocalReviewModelId, url: string, token: string, abort: AbortSignal) {
  return reviewServiceVerdict(id, url, token, abort);
}

async function liveReady(id: LocalReviewModelId, url: string, token: string, abort: AbortSignal) {
  const result = await verdictFor(id, url, token, abort);
  return result.verdict === 'ready' || result.verdict === 'loading';
}

async function adoptResident(id: LocalReviewModelId, abort: AbortSignal): Promise<Service | undefined> {
  if (!komatoseGpuEnabled()) return;
  const port = reviewListenPort(id);
  const occ = occupantOnPort(port);
  if (occ && occ.alias && occ.alias !== id) return;
  const url = bindUrl(port);
  const token = occ?.token || readSavedToken(id);
  if (!token) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    abort.throwIfAborted();
    const result = await verdictFor(id, url, token, abort);
    if (result.verdict === 'mismatch' || result.verdict === 'down') return;
    if (result.verdict === 'unauthorized') {
      const live = occupantOnPort(port)?.token;
      if (live && live !== token) {
        const retry = await verdictFor(id, url, live, abort);
        if (retry.verdict === 'ready' || retry.verdict === 'loading') {
          writeSavedToken(id, live);
          const instance: Service = { child: adoptedChild(), url, token: live, ready: Promise.resolve(), adopted: true };
          state.services.set(id, instance);
          return instance;
        }
      }
      return;
    }
    if (result.verdict === 'ready' || result.verdict === 'loading') {
      writeSavedToken(id, token);
      const instance: Service = { child: adoptedChild(), url, token, ready: Promise.resolve(), adopted: true };
      state.services.set(id, instance);
      return instance;
    }
    await delay(300, undefined, { signal: abort });
  }
}

/**
 * A review model can share its weights with a managed model row — Qwen3-VL is
 * both the OCR reader and the operator's light chat model. When such a row owns
 * a launch, its llama-server is the one copy of the weights and the review path
 * rides it instead of starting a second server of its own.
 */
function managedReviewHost(id: LocalReviewModelId): ModelRow | undefined {
  try {
    return listRegistryRows().find(
      (row) => Boolean(row.managedLaunch) && (row.slug === id || row.id === id),
    );
  } catch { return undefined; }
}

function managedHostStatus(id: LocalReviewModelId, host: ModelRow): ReviewServerStatus {
  const model = localReviewModel(id)!;
  const status = managedModelStatus(findRegistryRow(host.id) || host);
  return {
    id,
    label: model.label,
    installed: installedLocalReviewModels().some(item => item.id === id),
    state: status.state,
    port: status.port,
    pid: status.pid,
    device: status.device || reviewDevice(id),
    deviceChoice: status.deviceChoice || devicePref(id),
    served: status.state === 'running' ? id : undefined,
    error: status.error,
    busy: state.activeRuns > 0,
  };
}

async function managedHostService(id: LocalReviewModelId, host: ModelRow, abort: AbortSignal): Promise<Service> {
  abort.throwIfAborted();
  operateManagedModel(host.id, 'start', abort, false);
  await waitManagedOperation(host.id);
  abort.throwIfAborted();
  const status = managedHostStatus(id, host);
  if (status.state === 'error')
    throw failure(`${host.name} could not start.${status.error ? ` ${status.error}` : ''}`);
  if (!status.port) throw failure(`${host.name} has no launch port`);
  const cfg = modelHttpConfig(findRegistryRow(host.id) || host);
  return { child: adoptedChild(), url: bindUrl(status.port), token: cfg?.apiKey || '', ready: Promise.resolve(), adopted: true };
}

async function startService(id: LocalReviewModelId, abort: AbortSignal): Promise<Service> {
  if (!installedLocalReviewModels().some(model => model.id === id))
    throw new Error(`${id} is not installed. Run scripts/install-review-models.py with the review Python environment.`);
  let existing = state.services.get(id);
  if (existing && !existing.adopted && pythonReviewModel(id) && existing.runtimePath && existing.runtimePath !== pythonRuntimePath(pythonForReview(id))) {
    await terminateOwned(id);
    existing = undefined;
  }
  if (existing?.adopted) {
    if (await liveReady(id, existing.url, existing.token, abort)) {
      await existing.ready;
      abort.throwIfAborted();
      return existing;
    }
    dropService(id);
  } else if (existing && existing.child.exitCode === null && !existing.child.killed) {
    await existing.ready;
    abort.throwIfAborted();
    return existing;
  } else if (existing) {
    dropService(id);
  }
  const host = managedReviewHost(id);
  if (host) return managedHostService(id, host, abort);
  const adopted = await adoptResident(id, abort);
  if (adopted) return adopted;
  const port = komatoseGpuEnabled() ? reviewListenPort(id) : await freePort();
  abort.throwIfAborted();
  if (komatoseGpuEnabled()) {
    const occ = occupantOnPort(port);
    if (occ) {
      if (occ.alias === id) {
        const recovered = await adoptResident(id, abort);
        if (recovered) return recovered;
      }
      throw failure(occupiedMessage(id, occ, port));
    }
  }
  const dir = join(modelDir(), id);
  const token = randomBytes(24).toString('hex');
  const threads = String(Math.max(1, Math.min(32, Number(process.env.SCAN_REVIEW_THREADS) || 8)));
  const script = pythonReviewScript(id);
  if (script && id !== 'pp-ocrv5-korean') await ensureTorchProbe('env-review');
  const device = reviewResolved(id);
  const args = script
    ? [join(root(), 'ocr', script), '--model-dir', dir, '--port', String(port), '--token', token, '--threads', threads,
      '--device', device.kind === 'gpu' ? 'cuda' : 'cpu',
      ...(id.startsWith('hayai-ocr-') ? ['--model-id', id] : [])]
    : llamaArgs(id as LlamaReviewModelId, dir, port, token, threads, device);
  const logs = join(root(), 'data/logs');
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, `review-${id}.log`);
  const log = openSync(logPath, 'a', 0o600);
  const gpu = komatoseGpuEnabled();
  let child: ChildProcess;
  try {
    child = spawn(script ? pythonForReview(id) : llama(), args, {
      cwd: root(), stdio: ['ignore', log, log], env: childEnv(id),
      detached: gpu,
    });
    if (gpu) child.unref();
  } finally { closeSync(log); }
  let spawnError: Error | undefined;
  child.on('error', error => { spawnError = error; });
  writeSavedToken(id, token);
  const instance: Service = { child, url: bindUrl(port), token, ready: Promise.resolve(), runtimePath: script ? pythonRuntimePath(pythonForReview(id)) : undefined };
  state.services.set(id, instance);
  instance.ready = (async () => {
    try {
      const deadline = Date.now() + (komatoseGpuEnabled() ? 300_000 : 180_000);
      while (Date.now() < deadline) {
        abort.throwIfAborted();
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`${id} failed to start. See ${logPath}`);
        const result = await verdictFor(id, instance.url, token, abort);
        if (result.verdict === 'mismatch')
          throw failure(occupiedMessage(id, occupantOnPort(port) || { pid: 0, alias: result.served || 'another process', token: '' }, port));
        if (result.verdict === 'ready') return;
        await delay(300, undefined, { signal: abort });
      }
      throw new Error(`${id} startup timed out. See ${logPath}`);
    } catch (error) {
      child.kill('SIGTERM');
      if (state.services.get(id) === instance) dropService(id);
      throw error;
    }
  })();
  await instance.ready;
  return instance;
}

async function service(id: LocalReviewModelId, abort: AbortSignal): Promise<Service> {
  const pending = state.starting.get(id);
  if (pending) return pending;
  const run = startService(id, abort).finally(() => {
    if (state.starting.get(id) === run) state.starting.delete(id);
  });
  state.starting.set(id, run);
  return run;
}

/** Transport binding for the bundled resident API adapter. */
export async function localReviewHttpConfig(id: LocalReviewModelId, abort: AbortSignal) {
  const host = await service(id, abort);
  return { baseUrl: `${host.url}/v1`, apiKey: host.token, model: id,
    profile: 'llamacpp' as const, rowId: id };
}

export type LocalMessage = { role: 'system' | 'user'; content: string | Array<
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> };

async function request(id: LocalReviewModelId, path: string, body: unknown, abort: AbortSignal) {
  let lastAuthError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = await service(id, abort);
    const response = await fetch(`${host.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        // A launch with no configured key sends no credentials — llama-server
        // started without --api-key accepts unauthenticated local calls, and an
        // empty "Bearer " header is just noise the fetch layer trims away anyway.
        ...(host.token ? { authorization: `Bearer ${host.token}` } : {}) },
      body: JSON.stringify(body), signal: abort,
    });
    if (response.ok) return response.json();
    const text = (await response.text()).slice(0, 500);
    if (response.status === 401 && attempt === 0) {
      lastAuthError = text;
      dropService(id);
      continue;
    }
    if (response.status === 401) {
      const port = Number(new URL(host.url).port);
      const occ = occupantOnPort(port);
      if (occ && occ.alias && occ.alias !== id) throw failure(occupiedMessage(id, occ, port));
      throw new Error(`${id}: the review server rejected its API key. Restart it from Admin → Setup → Local OCR / review servers. ${text}`);
    }
    throw new Error(`${id}: HTTP ${response.status}: ${text}`);
  }
  throw new Error(`${id}: the review server rejected its API key. ${lastAuthError}`);
}

export type LlamaReviewId = LlamaReviewModelId;

export async function localChat(id: LlamaReviewId, messages: LocalMessage[],
  abort: AbortSignal, schema?: unknown, maxTokens = 1536): Promise<string> {
  const result = await request(id, '/v1/chat/completions', {
    model: id, messages, temperature: 0, max_tokens: maxTokens,
    ...(id === 'paddleocr-vl-1.6' ? { top_k: 1 } : {}),
    ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'source_review', strict: true, schema } } } : {}),
  }, abort);
  if (result.choices?.[0]?.finish_reason === 'length')
    throw new Error(`${id} reached its output limit; try a smaller text region.`);
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error(`${id} returned no text`);
  return content.trim();
}

export function imageMessage(crop: Buffer, prompt: string): LocalMessage {
  return { role: 'user', content: [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${crop.toString('base64')}` } },
    { type: 'text', text: prompt },
  ] };
}

export function paddleOcrPrompt(lang?: OcrLang) {
  // Official task token is exactly "OCR:". Replacing it with English instructions
  // drops PaddleOCR-VL out of OCR and it emits other scripts from its 109-language set.
  const name = lang === 'japanese' ? 'Japanese' : lang === 'korean' ? 'Korean' : '';
  return name ? `OCR:\nOCR language: ${name}` : 'OCR:';
}

export async function localTranscription(id: TranscriptionModelId, crop: Buffer, abort: AbortSignal, lang?: OcrLang) {
  if (id === 'pp-ocrv5-korean' && lang && lang !== 'korean') throw failure('PP-OCRv5 Korean supports Korean chapters only', 400);
  if (id === 'paddleocr-vl-1.6') return localChat(id, [imageMessage(crop, paddleOcrPrompt(lang))], abort, undefined, 1024);
  const result = await withPythonRuntime(id === 'pp-ocrv5-korean' ? 'env-ocr' : 'env-review', () => request(id, '/ocr', { image: crop.toString('base64'), language: lang }, abort));
  if (typeof result.source !== 'string') throw new Error(`${id} returned no transcription`);
  return result.source.trim();
}

export async function warmupLocalReviewModels(abort: AbortSignal = new AbortController().signal) {
  const ids = installedLocalReviewModels().map(model => model.id);
  await Promise.all(ids.map(async id => {
    try { await service(id, abort); }
    catch (error) {
      const entry = lifecycle(id);
      if (entry.state === 'starting' || entry.state === 'stopping') return;
      entry.state = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }));
}

/** The signal of the local review holding the queue, for calls made from inside it. */
const reviewSlot = new AsyncLocalStorage<AbortSignal>();

/**
 * Serialize local reviews, including translation, while keeping external reviews independent.
 * A call from inside a running review shares its slot; queueing it would wait on itself.
 */
export async function withLocalReview<T>(run: (signal: AbortSignal) => Promise<T>, abort?: AbortSignal): Promise<T> {
  abort?.throwIfAborted();
  const held = reviewSlot.getStore();
  if (held) {
    const signal = abort ? AbortSignal.any([held, abort]) : held;
    signal.throwIfAborted();
    return run(signal);
  }
  const queued = state.queue.then(() => withPythonRuntime('env-review', async () => {
    abort?.throwIfAborted();
    clearTimeout(state.idle);
    const signal = AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(15 * 60_000)]);
    state.activeRuns++;
    try { return await reviewSlot.run(signal, () => run(signal)); }
    catch (error) {
      // Hayai cannot cancel a running PyTorch generate; terminate it on cancellation.
      if (signal.aborted) komatoseGpuEnabled() ? stopPythonReview() : stopLocalReviewModels();
      throw error;
    } finally {
      state.activeRuns = Math.max(0, state.activeRuns - 1);
      if (!komatoseGpuEnabled()) {
        state.idle = setTimeout(stopLocalReviewModels, 5 * 60_000);
        state.idle.unref();
      }
    }
  }));
  state.queue = queued.catch(() => {});
  if (!abort) return queued;
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(abort.reason ?? new Error('Cancelled'));
    abort.addEventListener('abort', cancel, { once: true });
    queued.then(resolve, reject).finally(() => abort.removeEventListener('abort', cancel));
    if (abort.aborted) cancel();
  });
}

async function terminateOwned(id: LocalReviewModelId) {
  const host = managedReviewHost(id);
  if (host) {
    dropService(id);
    operateManagedModel(host.id, 'stop');
    await waitManagedOperation(host.id);
    return;
  }
  const existing = state.services.get(id);
  if (existing && !existing.adopted) existing.child.kill('SIGTERM');
  dropService(id);
  const port = komatoseGpuEnabled()
    ? reviewListenPort(id)
    : existing ? Number(new URL(existing.url).port) : undefined;
  if (!port) {
    clearSavedToken(id);
    return;
  }
  const occ = occupantOnPort(port);
  if (!occ) {
    clearSavedToken(id);
    return;
  }
  if (occ.alias !== id) throw failure(occupiedMessage(id, occ, port));
  try { process.kill(occ.pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + 10_000;
  while (occupantOnPort(port)?.pid === occ.pid && Date.now() < deadline) await delay(100);
  if (occupantOnPort(port)?.pid === occ.pid) {
    try { process.kill(occ.pid, 'SIGKILL'); } catch { /* already gone */ }
    for (let i = 0; i < 30 && occupantOnPort(port)?.pid === occ.pid; i++) await delay(100);
  }
  if (occupantOnPort(port)?.pid === occ.pid) throw failure(`${localReviewModel(id)!.label} did not stop`);
  clearSavedToken(id);
}

async function probeOne(id: LocalReviewModelId): Promise<ReviewServerStatus> {
  const managedHost = managedReviewHost(id);
  if (managedHost) return managedHostStatus(id, managedHost);
  const model = localReviewModel(id)!;
  const installed = installedLocalReviewModels().some(item => item.id === id);
  const entry = state.lifecycle.get(id);
  const gpu = komatoseGpuEnabled();
  const host = state.services.get(id);
  const port = gpu ? reviewListenPort(id) : host ? Number(new URL(host.url).port) : undefined;
  const occ = port ? occupantOnPort(port) : undefined;
  const token = occ?.token || host?.token || (id && readSavedToken(id)) || '';
  const url = host?.url || (port ? bindUrl(port) : '');
  let served: string | undefined;
  let error: string | undefined;
  let ready = false;
  if (occ && occ.alias && occ.alias !== id) {
    error = occupiedMessage(id, occ, port!);
    served = occ.alias;
  } else if (url && token) {
    const result = await reviewServiceVerdict(id, url, token, undefined, 1500);
    served = result.served;
    if (result.verdict === 'ready' || result.verdict === 'loading') ready = true;
    else if (result.verdict === 'mismatch')
      error = occupiedMessage(id, occ || { pid: 0, alias: result.served || 'another process', token: '' }, port || 0);
    else if (result.verdict === 'unauthorized')
      error = `${model.label} rejected its API key. Restart it from this page.`;
    else if (occ && result.verdict === 'down')
      error = `${model.label} is not responding on port ${port}.`;
  } else if (occ && !occ.alias) error = occupiedMessage(id, occ, port!);
  const base = {
    id, label: model.label, installed, port, pid: occ?.pid, device: reviewDevice(id), deviceChoice: devicePref(id),
    served: ready ? (served || id) : served, busy: state.activeRuns > 0,
  };
  if (entry?.state === 'starting' || entry?.state === 'stopping')
    return { ...base, state: entry.state, operationId: entry.operationId, error: entry.error || error };
  if (ready && (!occ?.alias || occ.alias === id))
    return { ...base, state: 'running', served: served || id };
  if (error) return { ...base, state: 'error', error, operationId: entry?.operationId };
  if (entry?.state === 'error') return { ...base, state: 'error', error: entry.error, operationId: entry.operationId };
  return { ...base, state: 'stopped' };
}

export async function listReviewServerStatuses(): Promise<ReviewServerStatus[]> {
  // Models a managed row hosts appear once, as that managed model.
  return Promise.all(
    LOCAL_REVIEW_MODELS.filter(model => !managedReviewHost(model.id)).map(model => probeOne(model.id)),
  );
}

export function operateReviewServer(id: string, action: 'start' | 'stop' | 'restart') {
  const model = localReviewModel(id);
  if (!model) throw failure('Unknown review model', 404);
  const modelId = model.id;
  if (action !== 'stop' && !installedLocalReviewModels().some(item => item.id === modelId))
    throw failure(`${model.label} is not installed. Run scripts/install-review-models.py.`, 400);
  const entry = lifecycle(modelId);
  if (entry.state === 'starting' || entry.state === 'stopping')
    throw failure('A start or stop is already in progress', 409);
  if ((action === 'stop' || action === 'restart') && state.activeRuns)
    throw failure('A local review is in progress. Finish or cancel it first.', 409);
  entry.operationId = randomUUID();
  entry.error = undefined;
  entry.state = action === 'stop' ? 'stopping' : 'starting';
  // A managed host runs the one server for this model; its lifecycle is the
  // review lifecycle here, so Setup buttons drive the managed model directly.
  const host = managedReviewHost(modelId);
  entry.promise = withPythonRuntime(modelId === 'pp-ocrv5-korean' ? 'env-ocr' : 'env-review', async () => {
    try {
      if (host) {
        operateManagedModel(host.id, action);
        await waitManagedOperation(host.id);
        const status = managedHostStatus(modelId, host);
        entry.state = status.state;
        entry.error = status.error;
        return;
      }
      if (action !== 'start') await terminateOwned(modelId);
      if (action !== 'stop') {
        await service(modelId, new AbortController().signal);
        entry.state = 'running';
      } else entry.state = 'stopped';
    } catch (error) {
      entry.state = 'error';
      entry.error = error instanceof Error ? error.message : String(error);
    }
  });
  return host ? managedHostStatus(modelId, host) : {
    id: modelId,
    label: model.label,
    installed: installedLocalReviewModels().some(item => item.id === modelId),
    state: entry.state,
    operationId: entry.operationId,
    device: reviewDevice(modelId),
    deviceChoice: devicePref(modelId),
    port: komatoseGpuEnabled() ? reviewListenPort(modelId) : undefined,
    busy: state.activeRuns > 0,
  } satisfies ReviewServerStatus;
}

export async function waitReviewOperation(id: string) {
  await state.lifecycle.get(id)?.promise;
}
