import { pythonRuntimePath, withPythonRuntime } from './pythonRuntimeMaintenance';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TRANSLATION_MODELS, translationModel, translationRuntimeOf, type TranslationModel } from '../translationModels';
import { DATA_DIR, ROOT } from './paths';
import { llamaServerBin, vulkanLlamaEnv } from './gpuMode';
import { devicePref, estimateNeedMiB, resolveDevice, torchDeviceEnv } from './computeDevices';
import type { ResolvedDevice } from '../computeDevices';
import { aiParallelRequests } from './aiParallel';

export type TranslationMessage = { role: 'system' | 'user'; content: string };
export type TranslationRequest = {
  messages: TranslationMessage[];
  temperature: number;
  max_tokens: number;
  repeat_penalty: number;
  top_k?: number;
  top_p?: number;
  min_p?: number;
  samplers?: string[];
  stop?: string[];
  chat_template_kwargs?: { enable_thinking?: boolean; source_lang_code?: string; target_lang_code?: string };
};
type Connection = { url: string; token: string; model: string };
type Service = Connection & { key: string; child: ChildProcess; closed: Promise<void> };
type Waiter = { key: string; limit: number; go: () => void };
/**
 * Requests in flight and those waiting their turn. Requests for the running model share it up
 * to its slot count; a request for another model waits until the server is idle, then
 * replaces it. Waiters are admitted in arrival order so a model switch is never starved.
 */
type State = { service?: Service; idle?: NodeJS.Timeout; active: number; activeKey: string; waiters: Waiter[] };
const global = globalThis as typeof globalThis & { __scanTranslationRuntime?: State };
const state = global.__scanTranslationRuntime ??= { active: 0, activeKey: '', waiters: [] };
state.waiters ??= [];
state.active ??= 0;
state.activeKey ??= '';
const setting = (model: TranslationModel, suffix: string) => (process.env[`${model.envPrefix}_${suffix}`] || '').trim();

export function translationModelsDir() {
  return process.env.SCAN_TRANSLATION_MODELS_DIR || join(DATA_DIR, 'models/translation');
}

function localGgufPath(model: TranslationModel, folder: string) {
  if (model.weights) return join(folder, model.id, model.weights.filename);
  const dir = join(folder, model.id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return '';
  return readdirSync(dir)
    .filter(name => name.toLowerCase().endsWith('.gguf'))
    .map(name => join(dir, name))
    .filter(path => {
      try { return statSync(path).isFile() && statSync(path).size >= 4; }
      catch { return false; }
    })
    .sort((a, b) => statSync(b).size - statSync(a).size)[0] ?? '';
}

function translationPython() {
  return process.env.SCAN_TRANSLATION_PYTHON || process.env.SCAN_REVIEW_PYTHON || join(ROOT, '.venv-review/bin/python');
}

function translationWorker(model: TranslationModel) {
  if (model.profile === 'ko-en-minrnn') return join(ROOT, 'ocr/ko_en_translate.py');
  if (model.profile === 'opus-mt-ja-en') return join(ROOT, 'ocr/opus_mt_translate.py');
  if (model.profile === 'sugoi-ja-en') return join(ROOT, 'ocr/sugoi_translate.py');
  return '';
}

export function translationModelConfig(model: TranslationModel) {
  const folder = translationModelsDir();
  const runtime = translationRuntimeOf(model);
  const override = setting(model, runtime === 'pytorch' ? 'CKPT' : 'GGUF');
  const path = override || (runtime === 'pytorch'
    ? (model.weights ? join(folder, model.id, model.weights.filename) : '')
    : localGgufPath(model, folder));
  const resolved = translationDevice(model, runtime === 'pytorch' ? 'torch' : 'llama', path);
  return {
    runtime,
    url: setting(model, 'URL').replace(/\/$/, ''),
    token: setting(model, 'API_KEY'),
    model: setting(model, 'MODEL') || model.id,
    path,
    extras: (model.weights?.extras || []).map(file => join(folder, model.id, file.filename)),
    bin: runtime === 'pytorch' ? translationPython() : (process.env.SCAN_TRANSLATION_LLAMA_SERVER || llamaServerBin()),
    worker: translationWorker(model),
    /** `none` (CPU) or a ggml device for llama-server; `cpu` or `cuda` for PyTorch workers. */
    device: resolved.kind === 'cpu' ? (runtime === 'pytorch' ? 'cpu' : 'none') : runtime === 'pytorch' ? 'cuda' : resolved.name,
    resolved,
  };
}

/** Saved choice per translator; SCAN_TRANSLATION_DEVICE remains the Auto answer for llama-server. */
function translationDevice(model: TranslationModel, runtime: 'llama' | 'torch', path: string): ResolvedDevice {
  const need = estimateNeedMiB([path], 512);
  if (runtime === 'torch') return resolveDevice('torch', devicePref(model.id), need, { env: 'env-review' });
  const legacy = (process.env.SCAN_TRANSLATION_DEVICE || '').trim();
  return resolveDevice('llama', devicePref(model.id), need, { legacy: legacy || undefined });
}

function translationChildEnv(cfg: ReturnType<typeof translationModelConfig>) {
  if (cfg.runtime === 'pytorch') return torchDeviceEnv(cfg.resolved);
  if (cfg.resolved.kind === 'cpu') return { ...process.env, CUDA_VISIBLE_DEVICES: '', HIP_VISIBLE_DEVICES: '' };
  return vulkanLlamaEnv();
}

export function translationModelReadiness(model: TranslationModel) {
  const cfg = translationModelConfig(model);
  const result = (available: boolean, reason: string) => ({ id: model.id, label: model.label, available, reason });
  if (cfg.url) {
    try {
      const url = new URL(cfg.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      return result(true, 'Configured translation endpoint; connectivity is checked when run');
    } catch { return result(false, `${model.envPrefix}_URL must be an HTTP(S) API base URL`); }
  }
  if (!cfg.path || !existsSync(cfg.path))
    return result(false, model.weights
      ? 'Not installed. Run python3 scripts/install-translation-models.py'
      : `Weights not published upstream. Convert this fine-tune to GGUF and set ${model.envPrefix}_GGUF, place the .gguf in ${join(translationModelsDir(), model.id)}/, or set ${model.envPrefix}_URL.`);
  if (!statSync(cfg.path).isFile() || statSync(cfg.path).size < 4)
    return result(false, cfg.runtime === 'pytorch' ? 'The configured checkpoint is not a model file' : 'The configured GGUF is not a model file');
  const override = setting(model, cfg.runtime === 'pytorch' ? 'CKPT' : 'GGUF');
  if (model.weights && !override && statSync(cfg.path).size !== model.weights.bytes)
    return result(false, 'Incomplete model download; rerun the translation model installer');
  if (model.weights?.extras && !override) {
    for (const extra of model.weights.extras) {
      const path = join(translationModelsDir(), model.id, extra.filename);
      if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== extra.bytes)
        return result(false, 'Incomplete model download; rerun the translation model installer');
    }
  }
  if (cfg.runtime === 'pytorch' && (!cfg.worker || !existsSync(cfg.worker)))
    return result(false, `The ${model.label} worker is missing from this installation`);
  if (!existsSync(cfg.bin))
    return result(false, cfg.runtime === 'pytorch'
      ? 'Python with PyTorch is missing; configure SCAN_TRANSLATION_PYTHON or SCAN_REVIEW_PYTHON'
      : 'llama-server is missing; configure SCAN_TRANSLATION_LLAMA_SERVER');
  return result(true, cfg.resolved.kind === 'cpu'
    ? 'Installed · CPU, loads on demand'
    : `Installed · ${cfg.resolved.label}, loads on demand`);
}

export const listTranslationModels = () => TRANSLATION_MODELS.map(translationModelReadiness);

export function assertTranslationModelReady(model: TranslationModel) {
  const readiness = translationModelReadiness(model);
  if (!readiness.available) throw Object.assign(new Error(readiness.reason), { status: 503 });
}

export async function stopTranslationRuntime() {
  clearTimeout(state.idle);
  const service = state.service;
  state.service = undefined;
  if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const force = setTimeout(() => service.child.kill('SIGKILL'), 2000);
    void service.closed.then(() => { clearTimeout(force); resolve(); });
    service.child.kill('SIGTERM');
  });
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

/** Requests admitted together share one startup instead of each launching a server. */
let starting: { key: string; ready: Promise<Connection> } | undefined;

async function connection(model: TranslationModel, signal: AbortSignal): Promise<Connection> {
  assertTranslationModelReady(model);
  const cfg = translationModelConfig(model);
  if (cfg.url) return cfg;
  const slots = translationSlots(model);
  const key = JSON.stringify([model.id, cfg.runtime, cfg.path, cfg.bin, cfg.device, cfg.runtime === 'pytorch' ? pythonRuntimePath(cfg.bin) : undefined, slots]);
  const current = state.service;
  if (current?.key === key && current.child.exitCode === null && current.child.signalCode === null && !current.child.killed)
    return current;
  if (starting?.key !== key) {
    const ready = launch(model, cfg, slots, key, signal);
    starting = { key, ready };
    void ready.catch(() => {}).finally(() => { if (starting?.ready === ready) starting = undefined; });
  }
  const pending = starting.ready;
  // A waiter cancelled while another request starts the server leaves without stopping it.
  return await new Promise<Connection>((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function launch(
  model: TranslationModel,
  cfg: ReturnType<typeof translationModelConfig>,
  slots: number,
  key: string,
  signal: AbortSignal,
): Promise<Connection> {
  await stopTranslationRuntime();
  signal.throwIfAborted();
  const port = await freePort();
  const token = randomBytes(24).toString('hex');
  const logDir = join(DATA_DIR, 'logs');
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `translation-${model.id}.log`);
  const log = await open(logPath, 'a', 0o600);
  const threads = String(Math.max(1, Math.min(32, Number(process.env.SCAN_TRANSLATION_THREADS) || 8)));
  const args = cfg.runtime === 'pytorch'
    ? [cfg.worker, '--model-dir', join(translationModelsDir(), model.id), '--checkpoint', cfg.path,
      '--port', String(port), '--token', token, '--threads', threads,
      '--device', cfg.device]
    : [
      '-m', cfg.path, '--alias', model.id, '--host', '127.0.0.1', '--port', String(port),
      // Parallel slots share one unified KV cache: each region prompt is short, so a little
      // extra room per slot is enough and memory barely grows with the slot count.
      '--api-key', token, '--jinja', '-c', String(8192 + 1024 * (slots - 1)), '-np', String(slots),
      ...(slots > 1 ? ['-kvu'] : []), '-b', '512', '-ub', '128',
      '-t', threads, '-dev', cfg.device, '-ngl', cfg.device === 'none' ? '0' : '999', '-fit', 'off',
      ...(model.profile === 'shisa' ? ['--reasoning', 'off', '--reasoning-budget', '0'] : []),
      ...(model.profile === 'translategemma' ? ['--chat-template-file', join(ROOT, 'ocr/translategemma-ja-en.jinja')] : []),
    ];
  let child: ChildProcess;
  let spawnError: Error | undefined;
  let closed: Promise<void>;
  try {
    child = spawn(cfg.bin, args, { cwd: ROOT, env: translationChildEnv(cfg), stdio: ['ignore', log.fd, log.fd] });
    child.on('error', error => { spawnError = error; });
    closed = new Promise<void>(resolve => { child.once('close', resolve); });
  } finally { await log.close(); }
  const service: Service = { key, child, closed, url: `http://127.0.0.1:${port}/v1`, token, model: model.id };
  state.service = service;
  const deadline = Date.now() + 180_000;
  try {
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`${model.label} failed to start. See ${logPath}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
        });
        if (response.ok) return service;
      } catch { signal.throwIfAborted(); }
      await delay(250, undefined, { signal });
    }
    throw new Error(`${model.label} startup timed out. See ${logPath}`);
  } catch (error) {
    await stopTranslationRuntime();
    throw error;
  }
}

/**
 * Requests the translator can serve at once: the Parallel AI requests setting for llama-server
 * and remote endpoints, one for PyTorch workers, which handle a single request at a time.
 */
export function translationSlots(model: TranslationModel) {
  return translationRuntimeOf(model) === 'pytorch' ? 1 : aiParallelRequests();
}

function admit() {
  while (state.waiters.length) {
    const next = state.waiters[0];
    if (state.active > 0 && (next.key !== state.activeKey || state.active >= next.limit)) return;
    state.waiters.shift();
    state.active++;
    state.activeKey = next.key;
    next.go();
  }
}

function release() {
  state.active = Math.max(0, state.active - 1);
  admit();
}

/** Waits for a turn on the translator; a cancelled waiter leaves the line without starting a model. */
function acquire(key: string, limit: number, abort?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { key, limit, go: () => { abort?.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => {
      const at = state.waiters.indexOf(waiter);
      if (at < 0) return; // already admitted: the request itself sees the abort
      state.waiters.splice(at, 1);
      reject(abort?.reason ?? new Error('Cancelled'));
      admit();
    };
    abort?.addEventListener('abort', cancel, { once: true });
    state.waiters.push(waiter);
    admit();
  });
}

/** One owned model/process at a time, shared by up to its slot count; cancellation never frees capacity before it stops. */
export async function completeTranslation(model: TranslationModel, request: TranslationRequest, abort?: AbortSignal) {
  abort?.throwIfAborted();
  const limit = translationSlots(model);
  await acquire(`${model.id}:${limit}`, limit, abort);
  try {
    return await sendTranslation(model, request, abort);
  } finally {
    release();
  }
}

function sendTranslation(model: TranslationModel, request: TranslationRequest, abort?: AbortSignal) {
  return withPythonRuntime('env-review', async () => {
    abort?.throwIfAborted();
    clearTimeout(state.idle);
    const signal = AbortSignal.any([...(abort ? [abort] : []), AbortSignal.timeout(5 * 60_000)]);
    try {
      const host = await connection(model, signal);
      signal.throwIfAborted();
      const response = await fetch(`${host.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(host.token ? { authorization: `Bearer ${host.token}` } : {}) },
        body: JSON.stringify({ ...request, model: host.model, stream: false }),
        signal,
      });
      if (!response.ok) throw new Error(`${model.label} returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const result = await response.json();
      signal.throwIfAborted();
      return result;
    } finally {
      if (signal.aborted) await stopTranslationRuntime();
      clearTimeout(state.idle);
      state.idle = setTimeout(() => { if (!state.active) void stopTranslationRuntime(); }, 5 * 60_000);
      state.idle.unref();
    }
  });
}

// Children are intentionally not detached: they belong to this application runtime.
process.once('exit', () => { state.service?.child.kill('SIGTERM'); });

/** Lifecycle adapter entry points: no inference is performed. */
export async function startTranslationModel(id: string, signal?: AbortSignal) {
  const model = translationModel(id);
  if (!model) throw new Error('Unknown translation recipe');
  return withPythonRuntime('env-review', () => connection(model, signal || AbortSignal.timeout(120_000)));
}
export function translationModelRunning(id: string) {
  return state.service?.model === id && state.service.child.exitCode === null;
}

export function translationWorkerStatus(): { running: boolean; pid?: number; detail?: string } {
  const service = state.service;
  const running = Boolean(service && service.child.exitCode === null && service.child.signalCode === null && !service.child.killed);
  const model = running ? translationModel(service!.model) : undefined;
  return { running, pid: running ? service!.child.pid : undefined, detail: model?.label };
}
