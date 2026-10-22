import { probeModelConnection, modelHttpConfig } from './modelConnection';
import { isProofreaderId } from "../proofreaders";
import { proofreaderStatus } from "./proofreadService";
import { cliReadiness, isCliToolId } from "./cliDiscovery";
import { listTranslateEngines, hasRegisteredCliAdapter, registeredCliExecutable } from "./cliTranslate";
import type { TranslateEngine } from "../types";
import { translationModel } from '../translationModels';
import { assertTranslationModelReady } from './translationRuntime';
import { resolveLiveAssistant } from './assistantRoute';
import { isOcrSpecialist, isTranslationSpecialist } from '../modelRegistry';
import { installedLocalReviewModels } from './localReview';
import { missingApiKeyMessage } from './openaiHttp';

export async function engineReadiness() {
  return Promise.all(
    listTranslateEngines().map(async (engine) => {
      if (isProofreaderId(engine.id)) {
        try {
          const status = await proofreaderStatus(engine.id);
          return {
            ...engine,
            available: status.ready,
            reason: status.reason,
            pageImageOnly: true,
          };
        } catch (error) {
          return {
            ...engine,
            available: false,
            reason: error instanceof Error ? error.message : String(error),
            pageImageOnly: true,
          };
        }
      }
      if (engine.id !== "qwen") {
        return { ...engine };
      }
      // The legacy "qwen" id has no row once the default chat model is removed.
      // Report it unavailable rather than failing every picker that lists engines.
      try {
        return { ...engine, ...await probeModelConnection(resolveLiveAssistant(engine.id).row) };
      } catch (error) {
        return { ...engine, available: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
}
export async function assertEngineReady(engine: TranslateEngine | string, model?: string) {
  let resolved;
  try {
    resolved = resolveLiveAssistant(String(engine || ''), model);
  } catch {
    throw Object.assign(new Error('Engine unavailable'), { status: 503 });
  }
  const { rowAvailability } = await import('./registryPicker');
  const ready = await rowAvailability(resolved.row);
  if (!ready.available) throw Object.assign(new Error(ready.reason || 'Model unavailable'), { status: 503 });
}
