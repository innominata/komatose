import { probeModelConnection, modelHttpConfig } from './modelConnection';
import { proofreaderLabel } from "../proofreaders";
import { listProofreaderStatuses, proofreadServiceConfigured, type ProofreaderStatus } from "./proofreadService";
import { cliReadiness, isCliToolId } from "./cliDiscovery";
import { listTranslateEngines, hasRegisteredCliAdapter, registeredCliExecutable } from "./cliTranslate";
import { listRegistryRows } from "./modelRegistryStore";
import type { TranslateEngine } from "../types";
import { translationModel } from '../translationModels';
import { assertTranslationModelReady } from './translationRuntime';
import { resolveLiveAssistant } from './assistantRoute';
import { isOcrSpecialist, isTranslationSpecialist } from '../modelRegistry';
import { installedLocalReviewModels } from './localReview';
import { missingApiKeyMessage } from './openaiHttp';

function proofreaderEngine(status: Pick<ProofreaderStatus, 'id' | 'label' | 'ready' | 'reason'>) {
  return {
    id: status.id,
    label: status.label || proofreaderLabel(status.id),
    available: status.ready,
    reason: status.reason,
    pageImageOnly: true,
    access: 'proofreader' as const,
    group: 'Proofreaders',
  };
}

export async function engineReadiness() {
  const engines = listTranslateEngines();
  if (!proofreadServiceConfigured()) return engines;
  try {
    const reported = await listProofreaderStatuses();
    const reportedIds = new Set(reported.map((item) => item.id));
    const saved = listRegistryRows()
      .filter((row) => row.access === 'proofreader' && !reportedIds.has(row.id))
      .map((row) => proofreaderEngine({
        id: row.id,
        label: row.name,
        ready: false,
        reason: `${row.name} is not available.`,
      }));
    return [...engines, ...reported.map(proofreaderEngine), ...saved];
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const saved = listRegistryRows()
      .filter((row) => row.access === 'proofreader')
      .map((row) => proofreaderEngine({ id: row.id, label: row.name, ready: false, reason }));
    return [...engines, ...saved];
  }
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
