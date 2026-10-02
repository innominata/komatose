import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import {
  gemma4ImageTokenBudget,
  gemma4VisionBatchSize,
} from "./gpuMode";
import { dirname, join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelRow } from "../modelRegistry";
import { validateManagedLaunch, type ManagedLaunch } from "../managedModels";
import { expandHomeLaunch, toHomePath } from "./homePath";
import { listRegistryRows, findRegistryRow } from "./modelRegistryStore";
import { modelHttpConfig } from "./modelConnection";
import {
  acquireModelUse,
  activeModelUses,
  lockModelLifecycle,
  managedModelRunning,
  onManagedUseReleased,
  setEffectiveManagedRow,
} from "./modelUsage";
import { launchPreset } from "./managedModelConfig";
import { estimateNeedMiB, llamaDeviceArgs, resolveDevice } from "./computeDevices";
import type { ResolvedDevice } from "../computeDevices";
import { llmListenPort, llamaServerEnv, mmprojDeviceEnv, reservedImageEditPort, reservedReviewService } from "./gpuMode";

export { launchPreset };
export type ManagedState =
  "stopped" | "starting" | "running" | "stopping" | "error";
type Owner = {
  version: 1;
  id: string;
  pid: number;
  birth: string;
  token: string;
  fingerprint: string;
  row: ModelRow;
  /** The device the process was actually started on (Auto resolved). */
  device?: string;
};
type Entry = {
  state: ManagedState;
  operationId?: string;
  error?: string;
  owner?: Owner;
  promise?: Promise<void>;
  /** Admin Start, Restart, or start-with-app. An on-demand task start stays false and unloads after idle. */
  explicit?: boolean;
  idle?: NodeJS.Timeout;
};
const globalManager = globalThis as typeof globalThis & {
  __managedModels?: Map<string, Entry>;
};
const entries = (globalManager.__managedModels ??= new Map<string, Entry>());
const failure = (message: string, status = 409) =>
  Object.assign(new Error(message), { status });
function dataDir() {
  return (
    process.env.SCAN_DATA_DIR ||
    join(process.env.SCAN_ROOT || process.cwd(), "data")
  );
}
function ownerPath(id: string) {
  return join(
    dataDir(),
    "run",
    `managed-${createHash("sha256").update(id).digest("hex").slice(0, 24)}.json`,
  );
}
function birth(pid: number) {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")
      .slice(1)
      .join(") ")
      .split(" ")[19];
  } catch {
    return "";
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function owned(owner: Owner) {
  if (!alive(owner.pid) || !owner.birth || birth(owner.pid) !== owner.birth)
    return false;
  try {
    return readFileSync(`/proc/${owner.pid}/environ`, "utf8")
      .split("\0")
      .includes(`SCAN_MANAGED_OWNER=${owner.token}`);
  } catch {
    return false;
  }
}
function fingerprint(row: ModelRow) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        slug: row.slug,
        launch: row.managedLaunch,
        http: row.http,
        requestPreset: row.requestPreset,
      }),
    )
    .digest("hex");
}
function readOwner(id: string): Owner | undefined {
  try {
    const value = JSON.parse(readFileSync(ownerPath(id), "utf8"));
    return value.version === 1 && value.id === id ? value : undefined;
  } catch {
    return undefined;
  }
}
function writeOwner(owner: Owner) {
  const path = ownerPath(owner.id);
  mkdirSync(join(dataDir(), "run"), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(owner), { mode: 0o600 });
  renameSync(temp, path);
}
function forgetOwner(id: string) {
  try {
    unlinkSync(ownerPath(id));
  } catch {
    /* absent */
  }
  setEffectiveManagedRow(id);
}
function entry(id: string) {
  let value = entries.get(id);
  if (!value) {
    const owner = readOwner(id);
    value = { state: "stopped" };
    if (owner && owned(owner)) {
      value.owner = owner;
      // A saved process must pass /models before it is reported ready.
      value.state = "stopped";
    }
    entries.set(id, value);
  }
  if (value.owner && !owned(value.owner) && value.state !== "starting" && value.state !== "stopping") {
    value.owner = undefined;
    value.state = "stopped";
    forgetOwner(id);
  }
  return value;
}
async function portOccupied(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(false)));
  });
}
function gemma4MtpBesideModel(modelPath: string): string {
  if (!modelPath) return "";
  try {
    const dir = dirname(modelPath);
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith("mtp-") && name.endsWith(".gguf")) {
        return join(dir, name);
      }
    }
  } catch {
    /* ignore missing model dir during dry runs */
  }
  return "";
}

/** Where a recipe runs: its saved device, with Auto resolved against the GPUs present now. */
export function managedDevice(row: ModelRow): ResolvedDevice {
  const r = expandHomeLaunch(validateManagedLaunch(row.managedLaunch));
  const need = estimateNeedMiB([r.modelPath, r.projectorPath], 768 + Math.round(r.contextSize / 64));
  return resolveDevice("llama", r.device, need, { legacy: process.env.SCAN_LLM_DEVICE });
}

export function managedLaunchArgs(row: ModelRow, attempt = 0): string[] {
  // Stored recipes keep home-relative `~/…` paths; expand only for the run.
  const r = expandHomeLaunch(validateManagedLaunch(row.managedLaunch));
  const cfg = modelHttpConfig({ ...row, managedLaunch: r })!;
  const args = [
    "-m",
    r.modelPath,
    "-a",
    row.slug,
    "--host",
    "127.0.0.1",
    "--port",
    String(r.port),
    ...llamaDeviceArgs(managedDevice(row), r.gpuLayers),
    "-c",
    String(r.contextSize),
    "-np",
    String(r.slots),
  ];
  if (cfg.apiKey) args.push("--api-key", cfg.apiKey);
  if (r.projectorPath) args.push("--mmproj", r.projectorPath);
  if (r.templatePath)
    args.push("--jinja", "--chat-template-file", r.templatePath);
  if (r.preset === "qwen38") {
    args.push(
      "-fa",
      "on",
      "-fit",
      attempt === 2 ? "on" : "off",
      "-sm",
      "layer",
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
      "-b",
      "512",
      "-ub",
      "128",
      "-n",
      "32768",
      "--reasoning-format",
      "deepseek",
      "--reasoning-preserve",
      "--reasoning-effort",
      "medium",
      "--reasoning",
      "on",
      "--reasoning-budget",
      "-1",
      "--temp",
      "0.6",
      "--top-p",
      "0.95",
      "--top-k",
      "20",
      "--min-p",
      "0.0",
      "--presence-penalty",
      "0.0",
      "--repeat-penalty",
      "1.0",
    );
    if (attempt !== 1)
      args.push(
        "--spec-type",
        "draft-mtp",
        "--spec-draft-n-max",
        process.env.SCAN_LLM_MTP || "3",
        "--spec-draft-n-min",
        "1",
        "--spec-draft-type-k",
        "q8_0",
        "--spec-draft-type-v",
        "q8_0",
      );
  } else if (r.preset === "gemma4") {
    const imageTokens = gemma4ImageTokenBudget();
    const visionBatch = gemma4VisionBatchSize(imageTokens);
    args.push(
      "--jinja",
      "-fa",
      "on",
      "-sm",
      "layer",
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
      "-b",
      String(visionBatch),
      "-ub",
      String(visionBatch),
      "--image-min-tokens",
      String(imageTokens),
      "--image-max-tokens",
      String(imageTokens),
      "--temp",
      "1.0",
      "--top-p",
      "0.95",
      "--top-k",
      "64",
      "--min-p",
      "0.0",
      "--presence-penalty",
      "0.0",
      "--repeat-penalty",
      "1.0",
    );
    const mtp = gemma4MtpBesideModel(r.modelPath);
    if (existsSync(mtp)) {
      args.push(
        "-md",
        mtp,
        "--spec-type",
        "draft-mtp",
        "--spec-draft-n-max",
        process.env.SCAN_GEMMA4_MTP_DRAFT || "4",
        "--spec-draft-n-min",
        "1",
      );
    }
  }
  return [...args, ...r.extraArgs];
}
async function servedModel(owner: Owner, signal?: AbortSignal) {
  const r = owner.row.managedLaunch!;
  const cfg = modelHttpConfig(owner.row)!;
  const res = await fetch(`http://127.0.0.1:${r.port}/v1/models`, {
    headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
    signal: AbortSignal.any([
      AbortSignal.timeout(2000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { data?: { id: string }[] };
  return body.data?.some((model) => model.id === owner.row.slug) === true;
}
async function terminate(owner: Owner) {
  if (!owned(owner))
    throw failure(
      "Process ownership could not be verified; it was not stopped",
    );
  process.kill(owner.pid, "SIGTERM");
  const deadline = Date.now() + 10000;
  while (owned(owner) && Date.now() < deadline) await delay(100);
  if (owned(owner)) {
    process.kill(owner.pid, "SIGKILL");
    for (let i = 0; i < 30 && owned(owner); i++) await delay(100);
  }
  if (owned(owner)) throw failure("Model did not stop");
  forgetOwner(owner.id);
}
function validateAssets(r: ManagedLaunch) {
  const check = expandHomeLaunch(r);
  for (const [name, value] of Object.entries({
    executable: check.executable,
    weights: check.modelPath,
    projector: check.projectorPath,
    template: check.templatePath,
  })) {
    if (value && (!isAbsolute(value) || !existsSync(value)))
      // Report the portable form: errors surface in the UI and logs.
      throw failure(`Missing ${name}: ${toHomePath(value)}`, 400);
  }
}
async function startRow(row: ModelRow, e: Entry, signal: AbortSignal) {
  const recipe = expandHomeLaunch(validateManagedLaunch(row.managedLaunch));
  validateAssets(recipe);
  // Card 1 is shared with the local artwork editor; starting either unloads the other.
  // Imported lazily so the editor can depend on this module without a cycle.
  const { releaseImageEditForDevice } = await import("./imageEdit");
  const device = managedDevice(row);
  if (device.kind === "gpu") await releaseImageEditForDevice(device.name);
  if (
    listRegistryRows().some(
      (other) =>
        other.id !== row.id && other.managedLaunch?.port === recipe.port,
    )
  )
    throw failure("Another managed model uses this port");
  const reserved = reservedReviewService(recipe.port);
  if (reserved)
    throw failure(
      `Port ${recipe.port} is reserved for ${reserved.label}. Use ${llmListenPort()} for chat models.`,
    );
  if (reservedImageEditPort(recipe.port))
    throw failure(
      `Port ${recipe.port} is reserved for the local image editor. Use ${llmListenPort()} for chat models.`,
    );
  const saved = e.owner || readOwner(row.id);
  if (saved && owned(saved)) {
    e.owner = saved;
    if (saved.fingerprint !== fingerprint(row))
      throw failure(
        "Resident model has pending configuration changes. Use Restart.",
      );
    if (!(await servedModel(saved, signal)))
      throw failure("Resident model identity or readiness check failed");
    setEffectiveManagedRow(row.id, saved.row);
    e.state = "running";
    return;
  }
  if (await portOccupied(recipe.port))
    throw failure(`Port ${recipe.port} is occupied by an unowned service`);
  const tries = recipe.preset === "qwen38" ? 3 : 1;
  for (let attempt = 0; attempt < tries; attempt++) {
    signal.throwIfAborted();
    const logDir = join(dataDir(), "logs");
    mkdirSync(logDir, { recursive: true });
    const fd = openSync(
      join(logDir, `managed-${row.id.replace(/[^\w-]/g, "_")}.log`),
      "a",
      0o600,
    );
    const token = randomUUID();
    const launchEnv: NodeJS.ProcessEnv = mmprojDeviceEnv({
      ...llamaServerEnv(recipe.executable),
      SCAN_MANAGED_OWNER: token,
    }, recipe.projectorPath && device.kind === 'gpu' ? device.name : undefined);
    for (const key of Object.keys(launchEnv))
      if (key.startsWith("LLAMA_ARG_")) delete launchEnv[key];
    if (row.requestPreset === "qwen-thinking")
      launchEnv.LLAMA_ARG_CHAT_TEMPLATE_KWARGS =
        '{"enable_thinking":true,"reasoning_effort":"medium"}';
    let child;
    try {
      child = spawn(recipe.executable, managedLaunchArgs(row, attempt), {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: launchEnv,
      });
    } finally {
      closeSync(fd);
    }
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    const owner: Owner = {
      version: 1,
      id: row.id,
      pid: child.pid!,
      birth: birth(child.pid!),
      token,
      fingerprint: fingerprint(row),
      row: structuredClone(row),
      device: device.kind === "gpu" ? device.name : "CPU",
    };
    writeOwner(owner);
    e.owner = owner;
    const deadline = Date.now() + 15 * 60_000;
    try {
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (child.exitCode !== null || !alive(owner.pid))
          throw failure(`${row.name} exited during startup`);
        try {
          if (owned(owner) && (await servedModel(owner, signal))) {
            setEffectiveManagedRow(row.id, row);
            e.state = "running";
            return;
          }
        } catch {
          signal.throwIfAborted();
        }
        await delay(500, undefined, { signal });
      }
      throw failure(`${row.name} startup timed out`);
    } catch (error) {
      if (owned(owner)) await terminate(owner);
      e.owner = undefined;
      forgetOwner(row.id);
      if (signal.aborted || attempt === tries - 1) throw error;
    }
  }
}
export function managedModelStatus(row: ModelRow) {
  const e = entry(row.id);
  return {
    id: row.id,
    state: e.state,
    operationId: e.operationId,
    error: e.error,
    activeUses: activeModelUses(row.id),
    pendingChanges: Boolean(
      e.owner && e.owner.fingerprint !== fingerprint(row),
    ),
    device: e.owner?.device || e.owner?.row.managedLaunch?.device || row.managedLaunch?.device,
    deviceChoice: row.managedLaunch?.device,
    port: e.owner?.row.managedLaunch?.port || row.managedLaunch?.port,
    pid: e.owner?.pid,
  };
}
export function listManagedStatuses() {
  return listRegistryRows()
    .filter((row) => row.managedLaunch || entries.get(row.id)?.owner)
    .map(managedModelStatus);
}
function idleMs() {
  const seconds = Number(process.env.SCAN_MANAGED_IDLE_SECONDS ?? 300);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}
function clearManagedIdle(e: Entry) {
  clearTimeout(e.idle);
  e.idle = undefined;
}
/** A task-started model gives the device back after it goes unused. An Admin start stays resident. */
function scheduleManagedIdle(id: string) {
  const row = findRegistryRow(id);
  const e = entries.get(id);
  if (!row?.managedLaunch || !e || e.explicit || e.state !== "running") return;
  if (activeModelUses(id) > 0) return;
  const wait = idleMs();
  if (!wait) return;
  clearManagedIdle(e);
  const timer = setTimeout(() => {
    const current = entries.get(id);
    if (!current || current.idle !== timer) return;
    current.idle = undefined;
    if (current.explicit || current.state !== "running" || activeModelUses(id) > 0) return;
    try { operateManagedModel(id, "stop"); } catch { /* a new task or admin action owns it */ }
  }, wait);
  timer.unref?.();
  e.idle = timer;
}
onManagedUseReleased(scheduleManagedIdle);

export function operateManagedModel(
  id: string,
  action: "start" | "stop" | "restart",
  signal = new AbortController().signal,
  explicit = true,
) {
  const row = findRegistryRow(id);
  if (!row) throw failure("Model not found", 404);
  if (
    row.access !== "local_http" ||
    (row.runtime !== "llamacpp" && row.runtime !== "qwen3vl") ||
    !row.managedLaunch
  )
    throw failure("This model is not managed", 400);
  const e = entry(id);
  if (
    action === "start" &&
    (e.state === "starting" ||
      (e.state === "running" && e.owner?.fingerprint === fingerprint(row)))
  ) {
    if (explicit) {
      e.explicit = true;
      clearManagedIdle(e);
    }
    return managedModelStatus(row);
  }
  clearManagedIdle(e);
  if (action === "stop" || !explicit) e.explicit = false;
  else e.explicit = true;
  const unlock = lockModelLifecycle(id, { ignoreJobReservations: action === "start" && !explicit });
  e.operationId = randomUUID();
  e.error = undefined;
  e.state = action === "stop" ? "stopping" : "starting";
  e.promise = (async () => {
    try {
      if (action !== "stop")
        validateAssets(validateManagedLaunch(row.managedLaunch));
      if (action !== "start" && e.owner) {
        await terminate(e.owner);
        e.owner = undefined;
      }
      if (action !== "stop") await startRow(row, e, signal);
      else {
        e.state = "stopped";
        setEffectiveManagedRow(id);
      }
    } catch (error) {
      e.state = "error";
      e.error = error instanceof Error ? error.message : String(error);
    } finally {
      unlock();
    }
  })();
  return managedModelStatus(row);
}
/** Used by startup and isolated integration tests; API actions remain nonblocking. */
export async function waitManagedOperation(id: string) {
  await entries.get(id)?.promise;
}
/**
 * Start a stopped managed model because a task needs it. Admin Start and
 * start-with-app stay resident; this copy unloads after it goes idle.
 */
export async function ensureManagedModel(id: string, signal?: AbortSignal) {
  const row = findRegistryRow(id);
  if (!row?.managedLaunch) return;
  const e = entry(id);
  clearManagedIdle(e);
  if (e.state === "starting" || e.state === "stopping") await e.promise;
  if (e.state === "running" && managedModelRunning(id)) return;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    operateManagedModel(id, "start", ctrl.signal, false);
    await waitManagedOperation(id);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  const after = entry(id);
  if (after.state !== "running")
    throw failure(after.error || `${row.name} could not start`, 503);
}
/** True when a task must start or wait for this managed model before it can run. */
export function managedNeedsStart(id: string) {
  return !managedReadyNow(id);
}
function managedReadyNow(id: string) {
  const e = entry(id);
  return e.state === "running" && managedModelRunning(id);
}
/** Start a managed model when a task needs it, then hold it until the caller releases. */
export function holdManagedModel(
  id: string,
  managed: boolean,
  signal?: AbortSignal,
  jobId?: string,
) {
  if (!managed || managedReadyNow(id)) return acquireModelUse(id, jobId, managed);
  return ensureManagedModel(id, signal).then(() => acquireModelUse(id, jobId, managed));
}
export async function startManagedModels() {
  await Promise.allSettled(
    listRegistryRows()
      .filter(
        (row) =>
          row.managedLaunch &&
          (row.managedLaunch.startOnBoot ||
            Boolean(readOwner(row.id) && owned(readOwner(row.id)!))),
      )
      .map(async (row) => {
        operateManagedModel(row.id, "start");
        await waitManagedOperation(row.id);
      }),
  );
}
