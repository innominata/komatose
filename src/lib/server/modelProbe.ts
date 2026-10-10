import { truncateOutputPreview, type ModelRow, type ProbeSample } from '../modelRegistry';
import { MODEL_TASK_IDS, ModelTaskError, TASK_CONTRACT_VERSION, taskDefinition, type ModelTaskId } from '../modelTasks';
import { VISION_PROBE_JPEG } from './fixtures/visionProbe';
import { modelTaskContract } from './modelTaskCatalog';
export { taskFixture, validateFixtureResult } from './modelTaskCatalog';
import { rowTaskFingerprints } from './modelPackages';
import type { DetectedBox } from './llm';

export type ProbeDeps = {
  abort?: AbortSignal;
  translate?(row: ModelRow): Promise<DetectedBox[]>;
  vision?(row: ModelRow, jpeg: Buffer): Promise<{ source: string; lineType?: string }>;
  ocr?(id: string, jpeg: Buffer): Promise<string>;
  specialist?(id: string, source: string): Promise<string>;
  describe?(row: ModelRow, jpeg: Buffer): Promise<string>;
  task?(row: ModelRow, operation: ModelTaskId): Promise<any>;
  invoke?(row: ModelRow, operation: ModelTaskId, input: Record<string, any>): Promise<any>;
};
export async function visionProbeJpeg() { return Buffer.from(VISION_PROBE_JPEG); }
export function probeOperationsFor(_row: ModelRow): ModelTaskId[] { return [...MODEL_TASK_IDS]; }

export async function probeModelRow(row: ModelRow, operation: ModelTaskId = 'translate', deps: ProbeDeps = {}): Promise<ProbeSample> {
  const started = Date.now();
  const fingerprint = rowTaskFingerprints(row)[operation];
  try {
    const contract = modelTaskContract(operation);
    const fixtures = await contract.fixtures();
    // Language fixtures (Japanese and Korean) and detect crops each count on their own.
    // One pass is enough. Source choice is the exception: every candidate order must pass.
    const requireAll = operation === 'sourceDecide';
    const acceptEither = !requireAll && fixtures.length > 1;
    let lastFailure: unknown;
    const failures: { label: string; reason: string; outcome: 'failed_validation' | 'error' | 'cancelled' }[] = [];
    const passed: { label: string; value: unknown }[] = [];
    for (const [index, input] of fixtures.entries()) {
    const label = input.probeLabel || (operation === 'translate' || operation === 'vision' ? String(input.lang || 'fixture') : index === 0 ? 'dialogue' : 'sfx');
    try {
    input.model = row.slug;
    let invoke = deps.invoke ? () => deps.invoke!(row, operation, input) : undefined;
    if (!invoke && operation === 'translate' && deps.translate) invoke = () => deps.translate!(row);
    if (!invoke && operation === 'vision' && deps.vision) invoke = () => deps.vision!(row, input.jpeg);
    if (!invoke && operation === 'describe' && deps.describe) invoke = () => deps.describe!(row, input.jpeg);
    if (!invoke && deps.task) invoke = () => deps.task!(row, operation);
    const value = await contract.run(row, input, { diagnostic: true, abort: deps.abort ? AbortSignal.any([deps.abort, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000), invoke });
    await contract.validateFixture(value, input);
    if (!acceptEither || operation !== 'detect') {
      return { operation, fingerprint, ok: true, outcome: 'passed', at: Date.now(), ms: Date.now() - started,
        reason: acceptEither ? `Passed the ${label} fixture` : undefined,
        outputPreview: truncateOutputPreview(JSON.stringify(value instanceof Map ? Object.fromEntries(value) : value), 2000) };
    }
    passed.push({ label, value });
    } catch (error) {
      if (requireAll || !acceptEither) throw error;
      if (deps.abort?.aborted || (error as Error)?.name === 'AbortError') throw error;
      if (error instanceof ModelTaskError && error.outcome === 'unsupported') throw error;
      lastFailure = error;
      const outcome = error instanceof ModelTaskError && (error.outcome === 'failed_validation' || error.outcome === 'cancelled') ? error.outcome : 'error';
      failures.push({ label, reason: (error as Error).message || String(error), outcome });
    }
    }
    if (acceptEither && passed.length) {
      const value = passed[0].value;
      return { operation, fingerprint, ok: true, outcome: 'passed', at: Date.now(), ms: Date.now() - started,
        reason: `Passed ${passed.map((item) => item.label).join(' + ')} fixture${passed.length === 1 ? '' : 's'}`,
        outputPreview: truncateOutputPreview(JSON.stringify(value instanceof Map ? Object.fromEntries(value as Map<unknown, unknown>) : value), 2000) };
    }
    if (failures.length > 1) {
      const outcome = failures.some((item) => item.outcome === 'error') ? 'error' : failures.some((item) => item.outcome === 'cancelled') ? 'cancelled' : 'failed_validation';
      throw new ModelTaskError(outcome, failures.map((item) => `${item.label}: ${item.reason}`).join(' · '));
    }
    throw lastFailure;
  } catch (error) {
    const outcome = error instanceof ModelTaskError ? error.outcome : (error as Error)?.name === 'AbortError' ? 'cancelled' : 'error';
    return { operation, fingerprint, ok: false, outcome, at: Date.now(), ms: Date.now() - started, reason: (error as Error).message || String(error) };
  }
}
