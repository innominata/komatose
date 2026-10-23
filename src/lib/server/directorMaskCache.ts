import type { runWorkflowPng } from "./workflowImages";

type Operation = typeof runWorkflowPng;
type Result = Awaited<ReturnType<Operation>>;

/**
 * Text masks for the length of a Director run.
 *
 * Cleaning asks for the same mask again and again: the original lettering for each
 * check, the same region grown the same way for each retry. A mask depends only on
 * the image (its path is a content hash) and the request, so a repeat is answered
 * from the first result instead of another detector call. Kept per run, for the
 * last few runs, so an edited detector never serves a mask from an old run.
 */
const runs = new Map<string, Map<string, Promise<Result>>>();
const KEEP_RUNS = 3;

export function cachedMaskOperation(runId: string, operation: Operation): Operation {
  return (payload, signal) => {
    if (payload.cmd !== "mask") return operation(payload, signal);
    let cache = runs.get(runId);
    if (!cache) {
      cache = new Map();
      runs.set(runId, cache);
      while (runs.size > KEEP_RUNS) runs.delete(runs.keys().next().value!);
    }
    const key = JSON.stringify(payload);
    const hit = cache.get(key);
    if (hit) return hit;
    const pending = operation(payload, signal);
    cache.set(key, pending);
    // A failed or cancelled mask is not remembered.
    pending.catch(() => cache.delete(key));
    return pending;
  };
}

/**
 * Deterministic cleans (LaMa) a run already rejected, by method, input and mask.
 * The same request returns the same pixels, so repeating it only repeats the
 * rejection and its checks (page 15 reran an identical, smudged LaMa clean).
 */
const rejected = new Map<string, Set<string>>();
export function rejectedClean(runId: string, key: string) {
  return rejected.get(runId)?.has(key) ?? false;
}
export function rememberRejectedClean(runId: string, key: string) {
  let keys = rejected.get(runId);
  if (!keys) {
    keys = new Set();
    rejected.set(runId, keys);
    while (rejected.size > KEEP_RUNS) rejected.delete(rejected.keys().next().value!);
  }
  keys.add(key);
}
