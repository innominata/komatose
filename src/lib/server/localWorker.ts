import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { hipVisibleDevices, hipWorkerEnv, komatoseGpuEnabled } from "./gpuMode";
import { devicePref, resolveDevice, torchDeviceEnv } from "./computeDevices";
import { isAutoChoice, type ResolvedDevice } from "../computeDevices";
import { ROOT } from "./paths";

export type BackendInfo = {
  devices: {
    id: string;
    name: string;
    backend: string;
    free: number;
    total: number;
  }[];
  errors: string[];
  sam: boolean;
  bigLama: boolean;
  bigLamaDevice?: string | null;
  koharu: boolean;
  cpu: boolean;
};
const queues = new Map<string, Promise<unknown>>();
const loads = new Map<string, number>();
const python = () =>
  process.env.SCAN_WORKFLOW_PYTHON ||
  (existsSync(join(ROOT, ".venv-workflow/bin/python"))
    ? join(ROOT, ".venv-workflow/bin/python")
    : join(ROOT, ".venv-ocr/bin/python"));

type Pending = {
  payload: string;
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
};

type Persistent = {
  proc: ChildProcess;
  buf: string;
  current: Pending | null;
  queue: Pending[];
};
const global = globalThis as typeof globalThis & { __scanWorkflowWorker?: Persistent | null };
/** Device-preference key for the cleaning, masking and inpainting worker. */
export const WORKFLOW_DEVICE_KEY = "cleaning-worker";

/** Where Koharu, SAM, Big-LaMa and AOT run; Komatose GPU mode keeps its pinned card as Auto. */
export function workflowResolved(): ResolvedDevice {
  return resolveDevice("torch", devicePref(WORKFLOW_DEVICE_KEY), 2048, {
    env: "env-workflow",
    legacy: komatoseGpuEnabled() ? hipVisibleDevices() : undefined,
  });
}

/** "GPU 1" / "CPU" for step messages and status lines, from the same resolution the worker uses. */
export function cleaningDeviceLabel(): string {
  const resolved = workflowResolved();
  if (resolved.kind !== "gpu") return "CPU";
  return resolved.index != null ? `GPU ${resolved.index}` : resolved.name;
}

function workflowEnv() {
  const env = { ...process.env, SAM2_BUILD_CUDA: "0" };
  const persistent = komatoseGpuEnabled() ? { SCAN_WORKFLOW_PERSISTENT: "1" } : {};
  if (komatoseGpuEnabled() && isAutoChoice(devicePref(WORKFLOW_DEVICE_KEY)))
    return { ...hipWorkerEnv(env), ...persistent };
  return { ...torchDeviceEnv(workflowResolved(), env), ...persistent };
}

/** A device change takes effect on the next spawn; the resident worker is retired now. */
export function restartWorkflowWorker() {
  const existing = global.__scanWorkflowWorker;
  if (existing && existing.proc.exitCode === null) existing.proc.kill("SIGTERM");
  global.__scanWorkflowWorker = null;
}

function settle(pending: Pending, error: Error | null, value?: Record<string, any>) {
  if (pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  if (pending.signal && pending.onAbort)
    pending.signal.removeEventListener("abort", pending.onAbort);
  if (error) pending.reject(error);
  else pending.resolve(value ?? {});
}

/** The persistent worker answers one request at a time. Extra requests wait in
 *  a queue instead of failing with "Cleaning worker is busy", so a backend
 *  probe that lands during startup warmup reports the real models. */
function pump(worker: Persistent) {
  if (worker.current || worker.proc.exitCode !== null || worker.proc.killed) return;
  const next = worker.queue.shift();
  if (!next) return;
  worker.current = next;
  try {
    worker.proc.stdin!.write(next.payload);
  } catch (error) {
    worker.current = null;
    settle(next, error instanceof Error ? error : new Error(String(error)));
    pump(worker);
  }
}

function handleLine(worker: Persistent, line: string) {
  const pending = worker.current;
  worker.current = null;
  if (pending) {
    try {
      const result = JSON.parse(line);
      if (!result.ok) throw new Error(result.error || "Worker stopped");
      settle(pending, null, result);
    } catch (error) {
      settle(pending, error instanceof Error ? error : new Error(String(error)));
    }
  }
  pump(worker);
}

function startPersistent(): Persistent {
  const proc = spawn(python(), ["-u", join(ROOT, "ocr/workflow.py")], {
    cwd: ROOT,
    env: { ...workflowEnv(), SCAN_WORKFLOW_PERSISTENT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const worker: Persistent = { proc, buf: "", current: null, queue: [] };
  proc.stdout.on("data", (chunk: Buffer) => {
    worker.buf += chunk.toString();
    let nl: number;
    while ((nl = worker.buf.indexOf("\n")) >= 0) {
      const line = worker.buf.slice(0, nl).trim();
      worker.buf = worker.buf.slice(nl + 1);
      if (line) handleLine(worker, line);
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[workflow] ${text}`);
  });
  proc.on("error", error => {
    if (worker.current) settle(worker.current, error);
    for (const queued of worker.queue.splice(0)) settle(queued, error);
    if (global.__scanWorkflowWorker === worker) global.__scanWorkflowWorker = null;
  });
  proc.on("exit", () => {
    const stopped = new Error("Cleaning worker stopped");
    if (worker.current) settle(worker.current, stopped);
    worker.current = null;
    for (const queued of worker.queue.splice(0)) settle(queued, stopped);
    if (global.__scanWorkflowWorker === worker) global.__scanWorkflowWorker = null;
  });
  return worker;
}

function persistentWorker() {
  const existing = global.__scanWorkflowWorker;
  if (existing && existing.proc.exitCode === null && !existing.proc.killed) return existing;
  const worker = startPersistent();
  global.__scanWorkflowWorker = worker;
  return worker;
}

function oneShot(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(python(), ["-u", join(ROOT, "ocr/workflow.py")], {
      cwd: ROOT,
      env: workflowEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    const cancel = () => child.kill("SIGKILL");
    const timer = setTimeout(cancel, 10 * 60 * 1000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      err = (err + b).slice(-4000);
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      try {
        const result = JSON.parse(out.trim().split("\n").at(-1) || "{}");
        if (!result.ok)
          throw new Error(
            result.error ||
              (signal?.aborted ? "Cancelled" : err || "Worker stopped"),
          );
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.end(JSON.stringify(payload) + "\n");
  });
}

function persistentExecute(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  if (signal?.aborted) return Promise.reject(new Error("Cancelled"));
  const worker = persistentWorker();
  return new Promise((resolve, reject) => {
    const drop = () => {
      if (worker.current === pending) worker.proc.kill("SIGKILL");
      else {
        const index = worker.queue.indexOf(pending);
        if (index >= 0) worker.queue.splice(index, 1);
      }
    };
    const pending: Pending = {
      payload: JSON.stringify(payload) + "\n",
      resolve,
      reject,
      settled: false,
      signal,
      timer: setTimeout(() => {
        drop();
        settle(
          pending,
          new Error(signal?.aborted ? "Cancelled" : "Cleaning worker timed out"),
        );
      }, 10 * 60 * 1000),
    };
    if (signal) {
      pending.onAbort = () => {
        drop();
        settle(pending, new Error("Cancelled"));
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    worker.queue.push(pending);
    pump(worker);
  });
}

function execute(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, any>> {
  return komatoseGpuEnabled() || workflowWorkerRunning() ? persistentExecute(payload, signal) : oneShot(payload, signal);
}

async function rawProbe(): Promise<BackendInfo> {
  try {
    return (await execute({ cmd: "probe" })) as BackendInfo;
  } catch (e) {
    return {
      devices: [],
      cpu: false,
      sam: false,
      bigLama: false,
      koharu: false,
      errors: [String(e)],
    };
  }
}

/** Set while startup warmup is loading models. A probe issued during that
 *  window waits for it, so the UI never sees a false "environment missing". */
let warmupInFlight: Promise<unknown> | null = null;

export async function probeBackend(): Promise<BackendInfo> {
  if (warmupInFlight) {
    try {
      await warmupInFlight;
    } catch {
      /* A failed warmup still needs a fresh probe to report the reason. */
    }
  }
  return rawProbe();
}

export async function startWorkflowWorker(signal?: AbortSignal) {
  await persistentExecute({ cmd: 'ping' }, signal);
}

export function workflowWorkerRunning() {
  const worker = global.__scanWorkflowWorker;
  return Boolean(worker && !worker.proc.killed && worker.proc.exitCode === null);
}

export async function warmupWorkflow() {
  if (!komatoseGpuEnabled()) return;
  if (warmupInFlight) return warmupInFlight;
  warmupInFlight = (async () => {
    const info = await rawProbe();
    const device = info.devices[0]?.id;
    if (!device) {
      console.error("[workflow] GPU warmup skipped:", info.errors.join("; ") || "no device");
      return info;
    }
    const warmed = await execute({ cmd: "warmup", device });
    console.log("[workflow] models resident on", device, warmed.warm || []);
    if (warmed.failed && Object.keys(warmed.failed).length)
      console.error("[workflow] warmup failures:", warmed.failed);
    return warmed;
  })().finally(() => {
    warmupInFlight = null;
  });
  return warmupInFlight;
}

export async function rawLocalOperation(
  payload: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const mightUseKoharu =
    payload.cmd === "detect-text" ||
    (payload.cmd === "mask" &&
      !!payload.detect &&
      payload.maskEngine !== "ctd");
  const cleanGpu =
    payload.method === "sam" ||
    payload.method === "big-lama" ||
    payload.method === "aot" ||
    (payload.method === "auto" && (komatoseGpuEnabled() || workflowResolved().kind === "gpu"));
  const info =
    payload.device !== "cpu" && (mightUseKoharu || cleanGpu)
      ? await probeBackend()
      : null;
  const maskDetect =
    mightUseKoharu &&
    (payload.cmd === "detect-text" ||
      payload.maskEngine === "koharu" ||
      ((payload.maskEngine === "auto" || !payload.maskEngine) && !!info?.koharu));
  const gpuEligible = maskDetect || cleanGpu;
  const devices =
    info?.devices
      .filter((d) => d.free > 2 * 1024 ** 3)
      .sort(
        (a, b) =>
          (loads.get(a.id) ?? 0) - (loads.get(b.id) ?? 0) || b.free - a.free,
      ) ?? [];
  const device = typeof payload.device === "string" ? payload.device : devices[0]?.id ?? "cpu";
  loads.set(device, (loads.get(device) ?? 0) + 1);
  const previous = queues.get(device) ?? Promise.resolve();
  const task = previous
    .catch(() => {})
    .then(() => execute({ ...payload, device }, signal));
  queues.set(device, task);
  try {
    return await task;
  } finally {
    loads.set(device, (loads.get(device) ?? 1) - 1);
    if (queues.get(device) === task) queues.delete(device);
  }
}

/** Model-backed operations are gated and dispatched just like language tasks. */
export async function localOperation(payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, any>> {
 const { listRegistryRows } = await import('./modelRegistryStore');
 const { rowHasOperation } = await import('../modelRegistry');
 const { imageWorkflowModel } = await import('./modelImageWorkflow');
 const { executeModelTask } = await import('./modelTaskRunner');
 const { readFile, writeFile } = await import('node:fs/promises');
 const { effectiveDefault } = await import('./modelDefaultStore');
 const defaultModel = (task: 'textMask' | 'inpaint') => effectiveDefault(task, listRegistryRows().find(row => !row.disabled && rowHasOperation(row, task))?.id || '');
 let task: import('../modelTasks').ModelTaskId | undefined;
 let id = String(payload.method || '');
 if (payload.cmd === 'detect-sfx') { task = 'detect'; id = 'coo'; }
 if (payload.cmd === 'detect-text') { task = 'detect'; id = 'koharu'; }
 if (payload.cmd === 'mask' && payload.detect) {
  task = 'textMask'; id = payload.maskEngine && payload.maskEngine !== 'auto' ? String(payload.maskEngine) : defaultModel('textMask');
 }
 if (payload.cmd === 'geometry-batch' && id !== 'opencv' && id !== 'split') {
  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  return { regions: await Promise.all(regions.map((region: any, index: number) => localOperation({ ...payload, ...region, cmd: 'geometry', neighbors: regions.filter((_: any, i: number) => i !== index).map((r: any) => r.box) }, signal))) };
 }
 if (payload.cmd === 'geometry' && id !== 'opencv' && id !== 'split') task = 'segmentBubble';
 if (payload.cmd === 'clean') {
  if (id === 'auto') {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'komatose-auto-clean-'));
    const prepared = join(dir, 'flat.png'), remainingMask = join(dir, 'remaining.png');
    try {
      const filled = await rawLocalOperation({ ...payload, cmd: 'clean-flat', out: prepared, remainingMask }, signal);
      if (!filled.remaining) {
        await writeFile(String(payload.out), await readFile(prepared));
        return filled;
      }
      const selected = defaultModel('inpaint');
      if (!selected) throw new Error('Choose a model with a current passing Inpaint test for the remaining mask.');
      return await localOperation({ ...payload, path: prepared, mask: remainingMask, strokes: [], method: selected }, signal);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  if (id === 'lama') id = 'lama-manga';
  if (imageWorkflowModel(id)) task = 'inpaint';
 }
 if (!task) return rawLocalOperation(payload, signal);
 const row = imageWorkflowModel(id);
 if (!row) throw new Error(id ? `Unknown model: ${id}` : `Choose a model with a current passing ${task} test.`);
 const jpeg = await readFile(String(payload.path));
 const mask = payload.mask ? await readFile(String(payload.mask)) : undefined;
 const result = await executeModelTask(row, task, { ...payload, jpeg, mask }, { abort: signal });
 if (task === 'segmentBubble' && !Array.isArray(result.polygon)) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'komatose-segmentation-'));
  try {
   const maskPath = join(directory, 'mask.png');
   await writeFile(maskPath, Buffer.from(result.mask.split(',')[1], 'base64'));
   const geometry = await rawLocalOperation({ ...payload, cmd: 'mask-geometry', mask: maskPath,
    confidence: typeof result.confidence === 'number' ? result.confidence : .5 }, signal);
   Object.assign(result, geometry);
  } finally { await rm(directory, { recursive: true, force: true }); }
 }
 if (payload.out && (result.image || result.mask)) await writeFile(String(payload.out), Buffer.from((result.image || result.mask).split(',')[1], 'base64'));
 if (task === 'detect') {
  const sharp = (await import('sharp')).default;
  const { width = 1, height = 1 } = await sharp(jpeg).metadata();
  return { ...result, width, height, regions: result.regions.map((r: any) => ({...r, box:[r.x * width,r.y * height,(r.x+r.w)*width,(r.y+r.h)*height]})) };
 }
 return { ...result, method: id, backend: 'Model adapter' };
}
