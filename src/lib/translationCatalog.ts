import type { EngineModelOption } from './aiTasks';
import type { TranslateEngine, TranslateEngineInfo } from './types';

export type TranslationCatalog = {
  engines: TranslateEngineInfo[];
  models: Partial<Record<TranslateEngine, EngineModelOption[]>>;
};
let pending: Promise<TranslationCatalog> | undefined;
let loadedAt = 0;

/** Called by mounted editor controls only; share concurrent discovery requests. */
export function loadTranslationCatalog(force = false): Promise<TranslationCatalog> {
  if (force || !pending || Date.now() - loadedAt > 10_000) {
    loadedAt = Date.now();
    pending = fetch('/api/ai/engines').then(async response => {
      if (!response.ok) throw new Error('Could not load translation models');
      const data = await response.json();
      return { engines: data.translationEngines ?? data.engines, models: data.translationModels ?? data.models };
    }).catch(error => { pending = undefined; throw error; });
  }
  return pending;
}
