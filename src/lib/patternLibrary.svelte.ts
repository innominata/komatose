import type { PatternAsset } from "./workflow";

/**
 * The shared pattern library as the editor knows it: loaded once, then replaced by the list an
 * upload or sample returns, so every picker shows a new pattern at once.
 */
export const patternLibrary = $state<{ list: PatternAsset[] | null; error: string }>({ list: null, error: "" });

let loading: Promise<void> | null = null;

export function loadPatterns(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const res = await fetch("/settings/patterns");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load patterns");
      patternLibrary.list = body.patterns;
      patternLibrary.error = "";
    } catch (e) {
      patternLibrary.error = e instanceof Error ? e.message : String(e);
      loading = null;
    }
  })();
  return loading;
}

export function setPatterns(list: PatternAsset[]) {
  patternLibrary.list = list;
  patternLibrary.error = "";
}
