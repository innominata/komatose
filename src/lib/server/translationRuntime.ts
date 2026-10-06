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
type State = { queue: Promise<unknown>; service?: Service; idle?: NodeJS.Timeout };
const global = globalThis as typeof globalThis & { __scanTranslationRuntime?: State };
const state = global.__scanTranslationRuntime ??= { queue: Promise.resolve() };
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

async function connection(model: TranslationModel, signal: AbortSignal): Promise<Connection> {
  assertTranslationModelReady(model);
  const cfg = translationModelConfig(model);
  if (cfg.url) return cfg;
  const key = JSON.stringify([model.id, cfg.runtime, cfg.path, cfg.bin, cfg.device, cfg.runtime === 'pytorch' ? pythonRuntimePath(cfg.bin) : undefined]);
  const current = state.service;
  if (current?.key === key && current.child.exitCode === null && current.child.signalCode === null && !current.child.killed)
    return current;
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
      '--api-key', token, '--jinja', '-c', '8192', '-np', '1', '-b', '512', '-ub', '128',
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

/** One owned model/process at a time; cancellation never frees capacity before it stops. */
export async function completeTranslation(model: TranslationModel, request: TranslationRequest, abort?: AbortSignal) {
  abort?.throwIfAborted();
  const task = state.queue.catch(() => {}).then(() => withPythonRuntime('env-review', async () => {
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
      state.idle = setTimeout(() => { void stopTranslationRuntime(); }, 5 * 60_000);
      state.idle.unref();
    }
  }));
  state.queue = task.catch(() => {});
  if (!abort) return task;
  // A cancelled item waiting in the queue returns promptly and never starts a model.
  return new Promise<unknown>((resolve, reject) => {
    const cancel = () => reject(abort.reason ?? new Error('Cancelled'));
    abort.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => abort.removeEventListener('abort', cancel));
    if (abort.aborted) cancel();
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
