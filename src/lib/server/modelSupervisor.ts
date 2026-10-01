import { envVar } from './envFile';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdapterRequest, PackageCommand } from '../modelPackage';
import { ModelTaskError, TASK_CONTRACT_VERSION, type ModelTaskId } from '../modelTasks';
import { devicePref } from './computeDevices';
import { modelPackage, modelPackageError, type DiscoveredPackage } from './modelPackages';

type ServiceState = { state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; active: number; error?: string };
const services = new Map<string, ServiceState>();
const queues = new Map<string, Promise<void>>();
export function serviceIdentity(pkg: DiscoveredPackage) { return pkg.manifest.service?.id || pkg.manifest.id; }
function operatorDevice(pkg: DiscoveredPackage) {
  const chosen = devicePref(pkg.manifest.id);
  return chosen && chosen !== 'auto' ? chosen : pkg.manifest.service?.device;
}
export function packageServiceStatus(pkg: DiscoveredPackage): ServiceState {
  return { ...(services.get(serviceIdentity(pkg)) || { state: 'stopped', active: 0 }) };
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function exclusive<T>(key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = queues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  const tail = previous.catch(() => {}).then(() => gate);
  queues.set(key, tail);
  try {
    await abortable(previous.catch(() => {}), signal);
    signal?.throwIfAborted();
    return await run();
  } finally {
    release();
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  }
}

type Waiter = { weight: number; grant: () => void; reject: (error: unknown) => void; signal?: AbortSignal; abort: () => void };
type Lane = { capacity: number; used: number; waiting: Waiter[] };
const lanes = new Map<string, Lane>();
function drain(lane: Lane) {
  while (lane.waiting.length && lane.used + lane.waiting[0].weight <= lane.capacity) {
    const waiter = lane.waiting.shift()!;
    waiter.signal?.removeEventListener('abort', waiter.abort);
    lane.used += waiter.weight;
    waiter.grant();
  }
}
async function serviceSlot<T>(pkg: DiscoveredPackage, all: boolean, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const id = serviceIdentity(pkg);
  let lane = lanes.get(id);
  if (!lane) {
    lane = { capacity: pkg.manifest.service?.concurrency || 1, used: 0, waiting: [] };
    lanes.set(id, lane);
  }
  const current = lane;
  const weight = all ? current.capacity : 1;
  await new Promise<void>((grant, reject) => {
    const waiter: Waiter = { weight, grant, reject, signal, abort: () => {
      const index = current.waiting.indexOf(waiter);
      if (index >= 0) current.waiting.splice(index, 1);
      reject(signal?.reason);
      drain(current);
    } };
    current.waiting.push(waiter);
    signal?.addEventListener('abort', waiter.abort, { once: true });
    drain(current);
  });
  try { signal?.throwIfAborted(); return await run(); }
  finally { current.used -= weight; drain(current); }
}
async function serviceLock<T>(pkg: DiscoveredPackage, all: boolean, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const resource = pkg.manifest.service?.resource || (pkg.manifest.service?.device ? `device:${pkg.manifest.service.device}` : undefined);
  return serviceSlot(pkg, all, () => resource ? exclusive(resource, run, signal) : run(), signal);
}

export async function superviseModel<T>(pkg: DiscoveredPackage, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const id = serviceIdentity(pkg);
  return serviceLock(pkg, false, async () => {
    const state = services.get(id) || { state: 'stopped' as const, active: 0 };
    services.set(id, state);
    state.active++;
    try { return await run(); }
    finally { state.active--; }
  }, signal);
}

/** JSONL protocol: stdout is protocol only, diagnostics belong on stderr. */
export async function runPackageCommand(pkg: DiscoveredPackage, command: PackageCommand, request: AdapterRequest,
  signal?: AbortSignal, onProgress?: (message: string) => void): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const expand = (s: string) => s.replaceAll('{package}', pkg.directory).replaceAll('{work}', request.settings.workDirectory).replaceAll('{root}', process.env.SCAN_ROOT || process.cwd());
    const executable = expand((command.executableEnv && envVar(command.executableEnv)) || command.executable);
    const child = spawn(executable.startsWith('.') ? resolve(pkg.directory, executable) : executable,
      (command.args || []).map(expand), { cwd: pkg.directory, env: { ...process.env, ...command.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let buffer = '', stderr = '', bytes = 0, final: any, failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.pid) {
        try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* exited */ }
        killTimer = setTimeout(() => { try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, 'SIGKILL'); } catch {} }, 1500);
        killTimer.unref();
      }
    };
    const cancel = () => { failure = signal?.reason?.name === 'TimeoutError' ? new ModelTaskError('error', 'Adapter timed out') : new ModelTaskError('cancelled', 'Cancelled'); stop(); };
    const timer = setTimeout(() => { failure = new ModelTaskError('error', 'Adapter timed out'); stop(); }, request.action === 'install' ? 60 * 60_000 : 10 * 60_000);
    signal?.addEventListener('abort', cancel, { once: true });
    const line = (text: string) => {
      if (!text.trim()) return;
      try {
        const event = JSON.parse(text);
        if (event.requestId !== request.requestId || event.protocol !== 1) throw new Error('Adapter response identity/version mismatch');
        if (event.type === 'progress') { onProgress?.(String(event.message || '')); return; }
        if (event.type !== 'result' || final) throw new Error('Expected exactly one final adapter result');
        final = event;
      } catch (e) { failure = new ModelTaskError('failed_validation', (e as Error).message); stop(); }
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) { failure = new ModelTaskError('error', 'Adapter output exceeds protocol limit'); stop(); return; }
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.stdin.on('error', () => {});
    child.on('error', e => { failure = new ModelTaskError('error', e.message); });
    child.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      if (buffer.trim()) line(buffer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ModelTaskError('error', `Adapter exited ${code}: ${stderr}`));
      if (!final) return reject(new ModelTaskError('failed_validation', 'Adapter returned no result'));
      if (final.ok !== true) {
        const outcome = ['unsupported', 'failed_validation', 'cancelled', 'error'].includes(final.error?.kind) ? final.error.kind : 'error';
        return reject(new ModelTaskError(outcome, final.error?.message || 'Adapter failed'));
      }
      resolveResult(final.output);
    });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}

export async function invokePackage(pkg: DiscoveredPackage, action: AdapterRequest['action'], input: Record<string, any> = {},
  opts: { task?: ModelTaskId; signal?: AbortSignal; slug?: string; progress?: (message: string) => void } = {}): Promise<any> {
  if (action === 'install' && pkg.manifest.setup && !pkg.manifest.lifecycle?.install ||
      action === 'installation-status' && pkg.manifest.artifacts?.length && !pkg.manifest.lifecycle?.['installation-status']) {
    const { operateBuiltinPackage } = await import('./modelAdapterLifecycle');
    return operateBuiltinPackage(pkg, action, opts.signal, opts.progress);
  }
  const command = action === 'execute' ? pkg.manifest.adapter.command : pkg.manifest.lifecycle?.[action] || pkg.manifest.adapter.command;
  if (!command && action !== 'execute') {
    const { operateBuiltinPackage } = await import('./modelAdapterLifecycle');
    return operateBuiltinPackage(pkg, action, opts.signal, opts.progress);
  }
  if (!command) throw new ModelTaskError('unsupported', `Adapter does not implement ${action}`);
  const directory = await mkdtemp(join(tmpdir(), 'komatose-adapter-'));
  try {
    const attachments: AdapterRequest['attachments'] = [];
    const convert = async (value: any, name: string): Promise<any> => {
      if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        const path = join(directory, `input-${attachments.length}.bin`);
        await writeFile(path, value);
        attachments.push({ name, path, mimeType: name.toLowerCase().includes('mask') ? 'image/png' : 'image/jpeg' });
        return { attachment: name };
      }
      if (Array.isArray(value)) return Promise.all(value.map((v, i) => convert(v, `${name}.${i}`)));
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k,v] of Object.entries(value)) if (k !== 'abort') out[k] = await convert(v, name ? `${name}.${k}` : k);
        return out;
      }
      return value;
    };
    const request: AdapterRequest = { protocol: 1, requestId: randomUUID(), action,
      task: opts.task ? { id: opts.task, version: TASK_CONTRACT_VERSION } : undefined,
      input: await convert(input, ''), attachments,
      model: { id: pkg.manifest.id, slug: opts.slug || pkg.manifest.model || pkg.manifest.id,
        revision: pkg.manifest.revision, config: pkg.manifest.config || {} },
      settings: { workDirectory: directory, device: operatorDevice(pkg) },
    };
    const output = await runPackageCommand(pkg, command, request, opts.signal, opts.progress);
    // Materialize output images before removing the request directory.
    if (output && typeof output === 'object') for (const field of ['image', 'mask']) {
      const value = (output as any)[field];
      if (typeof value === 'string' && !value.startsWith('data:')) {
        let path: string;
        try { path = await realpath(isAbsolute(value) ? value : resolve(directory, value)); }
        catch { throw new ModelTaskError('failed_validation', 'Adapter output file is missing'); }
        if (relative(directory, path).startsWith('..')) throw new ModelTaskError('failed_validation', 'Output files must belong to this request');
        (output as any)[field] = `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
      }
    }
    return output;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function operatePackage(id: string, action: Exclude<AdapterRequest['action'], 'execute'>,
  signal?: AbortSignal, progress?: (message: string) => void, ancestors: string[] = []): Promise<any> {
  const discoveryError = modelPackageError(id);
  if (discoveryError) throw new Error(`Invalid model package ${id}: ${discoveryError}`);
  let pkg = modelPackage(id);
  if (!pkg) {
    const { findRegistryRow } = await import('./modelRegistryStore');
    const { packageForRow } = await import('./modelTaskRunner');
    const row = findRegistryRow(id);
    if (row) pkg = packageForRow(row);
  }
  if (!pkg) throw new Error(`Unknown model package: ${id}`);
  if (ancestors.includes(id)) throw new Error(`Package dependency cycle: ${[...ancestors, id].join(' → ')}`);
  const service = serviceIdentity(pkg);
  const state = services.get(service) || { state: 'stopped' as const, active: 0 };
  services.set(service, state);
  if (action === 'stop' && state.active) throw new Error('Model is in use');
  if (action === 'install') for (const dependency of pkg.manifest.dependencies || []) {
    const status = await operatePackage(dependency, 'installation-status', signal, progress, [...ancestors, id]);
    if (!status?.installed) await operatePackage(dependency, 'install', signal, progress, [...ancestors, id]);
  }
  return serviceLock(pkg, true, async () => {
    if (action === 'install' && state.active) throw new Error('Model is in use');
    if (action === 'start') {
      const installation = await invokePackage(pkg, 'installation-status', {}, { signal });
      if (installation?.installed !== true) throw new ModelTaskError('error', installation?.reason || 'Install this package before starting it');
      state.state = 'starting';
    }
    if (action === 'stop') state.state = 'stopping';
    try {
      const result = await invokePackage(pkg, action, {}, { signal, progress });
      if (action === 'start') {
        const deadline = Date.now() + 60_000;
        while (true) {
          const health = await invokePackage(pkg, 'health', {}, { signal });
          if (health?.ready) break;
          if (Date.now() >= deadline) throw new Error('Model did not become ready');
          await abortable(new Promise(resolve => setTimeout(resolve, 250)), signal);
        }
        state.state = 'running';
      }
      if (action === 'stop') state.state = 'stopped';
      delete state.error;
      return result;
    } catch (e) { if (action === 'start' || action === 'stop') { state.state = 'error'; state.error = (e as Error).message; } throw e; }
  }, signal);
}

export type PackageOperation = {
  id: string; action: string; state: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number; endedAt?: number; messages: string[]; error?: string;
};
const operations = new Map<string, { operation: PackageOperation; abort: AbortController }>();
export function packageOperation(id: string): PackageOperation | undefined {
  const entry = operations.get(id)?.operation;
  return entry ? { ...entry, messages: [...entry.messages] } : undefined;
}
export function cancelPackageOperation(id: string) { operations.get(id)?.abort.abort(); }
export function startPackageOperation(id: string, action: 'install' | 'start' | 'stop' | 'restart'): PackageOperation {
  const active = operations.get(id);
  if (active?.operation.state === 'running') throw new Error('A package operation is already running');
  const operation: PackageOperation = { id, action, state: 'running', startedAt: Date.now(), messages: [] };
  const abort = new AbortController();
  operations.set(id, { operation, abort });
  const progress = (message: string) => {
    operation.messages.push(message.slice(-2000));
    if (operation.messages.length > 100) operation.messages.shift();
  };
  void (async () => {
    if (action === 'restart') await operatePackage(id, 'stop', abort.signal, progress);
    return operatePackage(id, action === 'restart' ? 'start' : action, abort.signal, progress);
  })().then(() => { operation.state = 'completed'; }, error => {
    operation.state = abort.signal.aborted ? 'cancelled' : 'failed';
    operation.error = error instanceof Error ? error.message : String(error);
  }).finally(() => { operation.endedAt = Date.now(); });
  return packageOperation(id)!;
}
