/** Shared decision contract; no transport or machine paths. */
export const D1_ID = 'd1-3b';
export const DECIDER_MIN_PROBABILITY = 0.80;
export const DECIDER_MIN_MARGIN = 0.15;
export const ABSTENTION_OPTIONS = {
  none: 'None of these candidates exactly matches the visible lettering.',
  unclear: 'The lettering is too unclear to choose a reliable reading.',
};
export type TranscriptionCandidate = { id: string; source: string };
export type TranscriptionChoice = { choice: string; probabilities: Record<string, number> };
export type TranscriptionDecision = {
  modelId: string;
  modelName: string;
  at: number;
  cropHash: string;
  candidates: TranscriptionCandidate[];
  probabilities: Record<string, number>;
  choice: string | null;
  confidence: number;
  margin: number;
  minProbability: number;
  minMargin: number;
  status: 'accepted' | 'abstained' | 'error';
  error?: string;
  applied?: boolean;
  /** Region geometry and source revision at the time this decision was saved. */
  bounds?: string;
  sourceRevision?: number;
  pageSourceStamp?: string;
};
export function decisionThreshold(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error('Decider thresholds must be numbers between 0 and 1');
  return value;
}
export function validateTranscriptionChoice(value: unknown, candidates?: TranscriptionCandidate[]): asserts value is TranscriptionChoice {
  const v = value as TranscriptionChoice;
  if (!v || typeof v.choice !== 'string' || !v.probabilities || typeof v.probabilities !== 'object' || Array.isArray(v.probabilities))
    throw new Error('Decider returned an invalid choice');
  const entries = Object.entries(v.probabilities);
  if (!entries.length || entries.some(([, p]) => typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1)
      || Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > 0.001
      || !Object.hasOwn(v.probabilities, v.choice)
      || v.probabilities[v.choice] + 1e-8 < Math.max(...entries.map(([, p]) => p)))
    throw new Error('Decider returned invalid probabilities');
  if (candidates) {
    const expected = [...candidates.map(c => c.id), ...Object.keys(ABSTENTION_OPTIONS)];
    if (expected.length !== entries.length || expected.some(id => !Object.hasOwn(v.probabilities, id)))
      throw new Error('Decider probabilities do not match the submitted candidates');
  }
}
export function acceptedDecisionSource(decision: TranscriptionDecision): string {
  return decision.status === 'accepted' ? decision.candidates.find(c => c.id === decision.choice)?.source || '' : '';
}

/** Pixels used by OCR change when a source page is prepared or replaced. */
export function deciderPageStamp(page: { prepared?: string; preparedAt?: number; cleaned?: string; cleanBase?: string } = {}) {
  return JSON.stringify([page.prepared || '', page.preparedAt || 0, page.cleaned || '', page.cleanBase || '']);
}
