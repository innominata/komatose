import type { ModelRow, ProbeSample } from './modelRegistry';
import { MODEL_TASK_IDS, taskLabel, type ModelTaskId } from './modelTasks';

export const CAPABILITIES = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'translation', label: 'Translation' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'imageUnderstanding', label: 'Image Understanding' },
] as const;
export type CapabilityId = typeof CAPABILITIES[number]['id'];
export type QualificationId = CapabilityId | ModelTaskId;
export type CapabilitySample = Omit<ProbeSample, 'operation'> & { capability: CapabilityId };
export const CAPABILITY_VERSION = 1;
export const CAPABILITY_REQUIREMENTS: Partial<Record<ModelTaskId, readonly CapabilityId[]>> = {
  vision: ['transcription'], sourceReview: ['transcription'], translate: ['translation'],
  compactNotes: ['conversation'], chapterReview: ['conversation'],
  alternatives: ['conversation', 'translation'], proofreadEnglish: ['conversation', 'translation'],
  advisory: ['conversation', 'translation'], describe: ['conversation', 'imageUnderstanding'],
  pageImageProofread: ['conversation', 'translation', 'transcription', 'imageUnderstanding'],
};
export const isCapability = (id: string): id is CapabilityId => CAPABILITIES.some(item => item.id === id);
export const qualificationLabel = (id: QualificationId) => CAPABILITIES.find(item => item.id === id)?.label || taskLabel(id);
export function capabilityPassed(row: ModelRow, id: CapabilityId): boolean {
  const sample = row.capabilities?.[id];
  return sample?.ok === true && !!sample.fingerprint && sample.fingerprint === row.capabilityFingerprints?.[id];
}
export function qualificationChecks(row: ModelRow): QualificationId[] {
  switch (row.qualificationAdapter) {
    case 'general': return ['conversation', 'translation', 'transcription', 'imageUnderstanding', ...(row.implementedTasks || []).filter(id => !CAPABILITY_REQUIREMENTS[id])];
    case 'ocr': return ['transcription'];
    case 'translator': return ['translation'];
    default: return (row.implementedTasks || MODEL_TASK_IDS).filter(id => id !== 'sourceReview');
  }
}
export function qualificationSample(row: ModelRow, id: QualificationId) {
  return isCapability(id) ? row.capabilities?.[id] : row.probes?.[id];
}
export function qualificationFingerprint(row: ModelRow, id: QualificationId) {
  return isCapability(id) ? row.capabilityFingerprints?.[id] : row.taskFingerprints?.[id];
}
export function qualificationCurrent(row: ModelRow, id: QualificationId) {
  const sample = qualificationSample(row, id);
  return !!sample?.fingerprint && sample.fingerprint === qualificationFingerprint(row, id);
}
/** Historical checks describe an earlier implementation; they cannot veto this one. */
export function qualificationAllowsUse(row: ModelRow, id: QualificationId): boolean {
  const sample = qualificationSample(row, id);
  return !!sample && (!qualificationCurrent(row, id) || sample.ok);
}
export function qualificationWarnings(row: ModelRow): string[] {
  const checks = new Set<QualificationId>([...qualificationChecks(row), ...Object.keys(row.probes || {}) as ModelTaskId[]]);
  const stale = [...checks].filter(id => qualificationSample(row, id) && !qualificationCurrent(row, id));
  return stale.length ? [`Tests out of date (${stale.map(qualificationLabel).join(', ')}). Outdated results are warnings; retest to update them.`] : [];
}
export function qualificationReason(row: ModelRow, task: ModelTaskId): string {
  if (row.implementedTasks && !row.implementedTasks.includes(task)) return 'Not implemented by this adapter';
  const requirements = row.qualificationAdapter && row.qualificationAdapter !== 'direct' ? CAPABILITY_REQUIREMENTS[task] : undefined;
  if (requirements) {
    const stale = requirements.filter(id => qualificationSample(row, id) && !qualificationCurrent(row, id));
    const missing = requirements.filter(id => !qualificationAllowsUse(row, id));
    if (!missing.length && stale.length) return `Available · ${stale.map(qualificationLabel).join(' + ')} test out of date (warning only)`;
    if (row.probes?.[task] && !qualificationCurrent(row, task) && requirements.every(id => !qualificationCurrent(row, id) || qualificationAllowsUse(row, id))) return 'Available · previous job test out of date (warning only)';
    return missing.length ? `Needs ${missing.map(qualificationLabel).join(' + ')}` : `Available from ${requirements.map(qualificationLabel).join(' + ')}`;
  }
  if (task === 'sourceReview') return 'Uses the transcription check';
  if (qualificationSample(row, task) && !qualificationCurrent(row, task)) return 'Available · test out of date (warning only)';
  return 'Requires a current passing integration check';
}
/** One image request yields two separately validated results. */
export function qualificationQueue<T extends ModelRow>(rows: readonly T[], mode: 'all' | 'untested' | 'failed') {
  const queue: { row: T; op: QualificationId }[] = [];
  for (const row of rows) {
    const checks = qualificationChecks(row).filter(id => mode === 'all' ||
      (mode === 'untested' ? !qualificationCurrent(row, id) : qualificationCurrent(row, id) && qualificationSample(row, id)?.ok === false));
    for (const op of checks) {
      if (row.qualificationAdapter === 'general' && op === 'imageUnderstanding' && checks.includes('transcription')) continue;
      queue.push({ row, op });
    }
  }
  return queue;
}
