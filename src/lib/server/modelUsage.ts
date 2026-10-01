import type { ModelRow } from "../modelRegistry";

type UseState = {
  calls: number;
  jobs: Set<string>;
  locked: boolean;
  effective?: ModelRow;
};
const globalState = globalThis as typeof globalThis & {
  __modelUse?: Map<string, UseState>;
};
const states = (globalState.__modelUse ??= new Map());
let managedUseReleased: (id: string) => void = () => {};
/** Managed models register this so an on-demand process can unload after its last task. */
export function onManagedUseReleased(fn: (id: string) => void) {
  managedUseReleased = fn;
}
function state(id: string): UseState {
  let s = states.get(id);
  if (!s) {
    s = { calls: 0, jobs: new Set(), locked: false };
    states.set(id, s);
  }
  return s;
}
export function managedModelRunning(id: string) {
  return Boolean(state(id).effective);
}
export function managedRuntimeSummary() {
  return [...states.entries()]
    .filter(([, s]) => s.effective)
    .map(([id, s]) => ({
      id,
      name: s.effective!.name,
      device: s.effective!.managedLaunch?.device,
      port: s.effective!.managedLaunch?.port,
    }));
}
export function activeModelUses(id: string) {
  const s = state(id);
  return s.calls + s.jobs.size;
}
export function effectiveManagedRow(row: ModelRow): ModelRow {
  return state(row.id).effective ?? row;
}
export function setEffectiveManagedRow(id: string, row?: ModelRow) {
  state(id).effective = row ? structuredClone(row) : undefined;
}
export function reserveModelJob(id: string, jobId: string) {
  const s = state(id);
  if (s.locked)
    throw Object.assign(new Error("Model lifecycle operation is in progress"), {
      status: 409,
    });
  s.jobs.add(jobId);
}
export function releaseModelJob(jobId: string) {
  for (const s of states.values()) s.jobs.delete(jobId);
}
export function acquireModelUse(id: string, jobId?: string, managed = false) {
  const s = state(id);
  if (s.locked)
    throw Object.assign(new Error("Model lifecycle operation is in progress"), {
      status: 409,
    });
  if (managed && !s.effective)
    throw Object.assign(
      new Error("Start this managed model before running a task."),
      { status: 503 },
    );
  if (jobId) s.jobs.add(jobId);
  s.calls++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      s.calls--;
      if (managed) managedUseReleased(id);
    }
  };
}
export function lockModelLifecycle(id: string, opts?: { ignoreJobReservations?: boolean }) {
  const s = state(id);
  const uses = opts?.ignoreJobReservations ? s.calls : activeModelUses(id);
  if (s.locked || uses)
    throw Object.assign(
      new Error("Model is busy. Finish or cancel its jobs first."),
      { status: 409 },
    );
  s.locked = true;
  return () => {
    s.locked = false;
  };
}
export function assertModelIdentityEditable(id: string) {
  const s = state(id);
  if (s.effective || s.locked || activeModelUses(id))
    throw Object.assign(
      new Error("Stop this model before changing its identity or connection."),
      { status: 409 },
    );
}
