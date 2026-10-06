import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
/** Hold new work while a Python runtime is replaced; let accepted work drain. */
import { AsyncLocalStorage } from 'node:async_hooks';
const held = new AsyncLocalStorage<Set<string>>();
type Slot = { active: number; maintenance: boolean; released?: Promise<void>; release?: () => void };
const global = globalThis as typeof globalThis & { __komatosePythonSlots?: Map<string, Slot> };
const slots = global.__komatosePythonSlots ??= new Map<string, Slot>();
function slot(id: string) {
  let value = slots.get(id);
  if (!value) slots.set(id, value = { active: 0, maintenance: false });
  return value;
}
export async function withPythonRuntime<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (held.getStore()?.has(id)) return run();
  const value = slot(id);
  while (value.maintenance) await value.released;
  value.active++;
  try { return await held.run(new Set([...(held.getStore() || []), id]), run); } finally { value.active--; }
}
export async function maintainPythonRuntime(id: string, abort?: AbortSignal): Promise<() => void> {
  const value = slot(id);
  if (value.maintenance) throw Object.assign(new Error('Environment maintenance is already running'), { status: 409 });
  value.maintenance = true;
  value.released = new Promise(resolve => { value.release = resolve; });
  const release = () => {
    value.maintenance = false;
    value.release?.();
    value.release = undefined;
  };
  try {
    while (value.active) {
      abort?.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    abort?.throwIfAborted();
    return release;
  } catch (error) { release(); throw error; }
}

/** Resolve the environment directory, keeping the venv's interpreter symlink intact. */
export function pythonRuntimePath(python: string): string {
  try { return join(realpathSync(dirname(python)), basename(python)); }
  catch { return python; }
}
