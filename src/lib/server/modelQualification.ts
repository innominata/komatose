import sharp from 'sharp';
import { CAPABILITY_REQUIREMENTS, capabilityPassed, isCapability, qualificationChecks, qualificationCurrent, qualificationLabel, qualificationReason, qualificationSample, type CapabilityId, type CapabilitySample, type QualificationId } from '../modelCapabilities';
import { rowHasOperation, type ModelRow } from '../modelRegistry';
import { ModelTaskError, taskLabel, type ModelTaskId } from '../modelTasks';
import { findRegistryRow, saveCapabilityResults, saveProbeResult } from './modelRegistryStore';
import { probeModelRow, type ProbeDeps } from './modelProbe';
import { executeModelTask } from './modelTaskRunner';
import { KOREAN_VISION_PROBE_PNG } from './fixtures/koreanVisionProbe';
import { VISION_PROBE_JPEG } from './fixtures/visionProbe';

export async function runQualification(row: ModelRow, check: QualificationId, deps: ProbeDeps = {}) {
  if (!qualificationChecks(row).includes(check)) throw new ModelTaskError('unsupported', 'This adapter does not implement this check');
  if (!isCapability(check)) return { samples: [], sample: await probeModelRow(row, check, deps) };
  const started = Date.now();
  const imagePair = row.qualificationAdapter === 'general' && ['transcription', 'imageUnderstanding'].includes(check);
  const ids: CapabilityId[] = imagePair ? ['transcription', 'imageUnderstanding'] : [check];
  const sample = (capability: CapabilityId, ok: boolean, outcome: CapabilitySample['outcome'], reason?: string, output?: unknown): CapabilitySample => ({
    capability, fingerprint: row.capabilityFingerprints?.[capability], ok, outcome, reason,
    at: Date.now(), ms: Date.now() - started, outputPreview: output === undefined ? undefined : JSON.stringify(output).slice(0, 2000),
  });
  if (check === 'translation' || (check === 'transcription' && !imagePair)) {
    const result = await probeModelRow(row, check === 'translation' ? 'translate' : 'vision', deps);
    return { samples: [{ ...sample(check, result.ok, result.outcome, result.reason), outputPreview: result.outputPreview }], sample: undefined };
  }
  try {
    const abort = deps.abort ? AbortSignal.any([deps.abort, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
    if (imagePair) {
      const second = await sharp(Buffer.from('<svg width="320" height="240"><rect width="320" height="240" fill="white"/><circle cx="160" cy="120" r="65" fill="blue"/></svg>')).jpeg().toBuffer();
      const pages = [
        { label: 'Japanese', bytes: Buffer.from(VISION_PROBE_JPEG), needle: '待って' },
        { label: 'Korean', bytes: await sharp(Buffer.from(KOREAN_VISION_PROBE_PNG)).jpeg().toBuffer(), needle: '기다려' },
      ];
      const attempts: { value?: any; transcription: boolean; image: boolean; error?: Error }[] = [];
      for (const page of pages) {
        const input = {
          images: [page.bytes, second],
          system: 'Inspect the supplied images in order. Return only the requested JSON. Do not use tools.',
          prompt: 'Transcribe the original lettering in image 1 as source. Compare the two images: return firstHasText and secondHasText as booleans, and identify the colored shape in image 2 as secondShape and secondColor (English lowercase).',
          schema: { type: 'object', additionalProperties: false, required: ['source', 'firstHasText', 'secondHasText', 'secondShape', 'secondColor'], properties: {
            source: { type: 'string' }, firstHasText: { type: 'boolean' }, secondHasText: { type: 'boolean' },
            secondShape: { type: 'string' }, secondColor: { type: 'string' },
          } },
        };
        try {
          const value = await executeModelTask(row, 'advisory', input, { diagnostic: true, abort, independentDiagnosticFields: true,
            invoke: deps.invoke ? () => deps.invoke!(row, 'advisory', input) : undefined });
          const transcription = String(value?.source || '').replace(/\s/g, '').includes(page.needle);
          const image = value?.firstHasText === true && value?.secondHasText === false && String(value?.secondShape).toLowerCase() === 'circle' && String(value?.secondColor).toLowerCase() === 'blue';
          attempts.push({ value, transcription, image });
          // Either language's lettering is enough; the shape check is not language-specific.
          if (transcription) break;
        } catch (error) {
          attempts.push({ transcription: false, image: false, error: error as Error });
          if (deps.abort?.aborted || (error as Error).name === 'AbortError') break;
        }
      }
      const transcribed = attempts.find((item) => item.transcription);
      const understood = attempts.find((item) => item.image);
      const pictured = transcribed?.value || understood?.value || attempts.at(-1)?.value;
      const failed = attempts.at(-1)?.error;
      const outcome = failed && attempts.every((item) => item.error)
        ? (deps.abort?.aborted || failed.name === 'AbortError' ? 'cancelled' : failed instanceof ModelTaskError ? failed.outcome : 'error')
        : 'failed_validation';
      return { sample: undefined, samples: ids.map(id => {
        const passed = id === 'transcription' ? !!transcribed : !!understood;
        const reason = passed ? undefined : outcome === 'failed_validation'
          ? `The ${id} result did not match the Japanese or Korean fixture`
          : failed?.message;
        return sample(id, passed, passed ? 'passed' : outcome, reason, pictured);
      }) };
    }
    const input = {
      images: [], system: 'Follow the latest request using the supplied conversation. Return only JSON with remembered, total, and corrected. Do not use tools.',
      prompt: 'Conversation so far:\nUser: Remember the codeword lantern and the count 7.\nAssistant: I will remember them.\nUser: Add 5 to that count.\nAssistant: The count is now 12.\n\nCurrent request: What codeword did I give you? Subtract 2 from the latest count. Correct the spelling in "Ths is a tset." Return remembered (the codeword), total (the final number), and corrected (the sentence).',
      schema: { type: 'object', additionalProperties: false, required: ['remembered', 'total', 'corrected'], properties: {
        remembered: { type: 'string' }, total: { type: 'number' }, corrected: { type: 'string' },
      } },
    };
    const value = await executeModelTask(row, 'advisory', input, { diagnostic: true, abort,
      invoke: deps.invoke ? () => deps.invoke!(row, 'advisory', input) : undefined });
    return { sample: undefined, samples: ids.map(id => {
      const passed = value.remembered === 'lantern' && value.total === 10 && /^this is a test[.!]?$/i.test(String(value.corrected).trim());
      return sample(id, passed, passed ? 'passed' : 'failed_validation', passed ? undefined : `The ${id} result did not match the fixture`, value);
    }) };
  } catch (error) {
    const outcome = deps.abort?.aborted || (error as Error).name === 'AbortError' ? 'cancelled' : error instanceof ModelTaskError ? error.outcome : 'error';
    return { sample: undefined, samples: ids.map(id => sample(id, false, outcome, (error as Error).message)) };
  }
}

const qualifying = new Map<string, Promise<ModelRow>>();

function passedCheck(row: ModelRow, id: QualificationId): boolean {
  if (isCapability(id)) return capabilityPassed(row, id);
  const probe = row.probes?.[id];
  return probe?.ok === true && !!probe.fingerprint && probe.fingerprint === row.taskFingerprints?.[id];
}

function checksFor(row: ModelRow, task: ModelTaskId): QualificationId[] {
  if (task === 'sourceReview') return row.qualificationAdapter && row.qualificationAdapter !== 'direct' ? ['transcription'] : ['vision'];
  const required = row.qualificationAdapter && row.qualificationAdapter !== 'direct' ? CAPABILITY_REQUIREMENTS[task] : undefined;
  return required?.length ? [...required] : [task];
}

/** A completed mismatch stays recorded. A connection or cancellation error is tried again. */
function settledFailure(row: ModelRow, id: QualificationId): boolean {
  const sample = qualificationSample(row, id);
  return !!sample && !sample.ok && qualificationCurrent(row, id) && sample.outcome !== 'error' && sample.outcome !== 'cancelled';
}

/** Checks that still need a run. A current validation failure is reported, not repeated. */
function pendingChecks(row: ModelRow, task: ModelTaskId): QualificationId[] {
  const missing = checksFor(row, task).filter(id => !passedCheck(row, id));
  const collapsed = row.qualificationAdapter === 'general' && missing.includes('transcription') && missing.includes('imageUnderstanding')
    ? missing.filter(id => id !== 'imageUnderstanding') : missing;
  return collapsed.filter(id => !settledFailure(row, id));
}

function recordedFailure(row: ModelRow, id: QualificationId): string | undefined {
  if (!settledFailure(row, id)) return undefined;
  const sample = qualificationSample(row, id);
  return `${qualificationLabel(id)}: ${sample?.reason || 'the test did not pass'}`;
}

/**
 * The model an action is about to run has no current pass. Run the missing
 * checks, store them, and return the updated row. A failed test throws that
 * test's own reason.
 */
export async function ensureDefaultQualification(row: ModelRow, task: ModelTaskId, deps: ProbeDeps = {}): Promise<ModelRow> {
  const key = `${row.id}\0${task}`;
  const running = qualifying.get(key);
  if (running) return running;
  const attempt = qualifyDefault(row, task, deps).finally(() => qualifying.delete(key));
  qualifying.set(key, attempt);
  return attempt;
}

async function qualifyDefault(row: ModelRow, task: ModelTaskId, deps: ProbeDeps): Promise<ModelRow> {
  let current = findRegistryRow(row.id) ?? row;
  if (current.disabled) throw new ModelTaskError('error', `${current.name} is disabled`);
  if (rowHasOperation(current, task)) return current;
  if (current.implementedTasks && !current.implementedTasks.includes(task))
    throw new ModelTaskError('unsupported', `${current.name} does not implement ${taskLabel(task)}.`);
  const failures = checksFor(current, task).map(id => recordedFailure(current, id)).filter((reason): reason is string => !!reason);
  let outcome: 'failed_validation' | 'error' | 'cancelled' = 'failed_validation';
  const note = (next?: string) => {
    if (next === 'error') outcome = 'error';
    else if (next === 'cancelled' && outcome !== 'error') outcome = 'cancelled';
  };
  for (const check of pendingChecks(current, task)) {
    deps.abort?.throwIfAborted();
    if (!qualificationChecks(current).includes(check)) {
      failures.push(`${qualificationLabel(check)}: ${qualificationReason(current, task)}`);
      continue;
    }
    const result = await runQualification(current, check, deps);
    deps.abort?.throwIfAborted();
    const samples = result.sample ? [result.sample] : result.samples;
    current = result.sample ? saveProbeResult(current.id, result.sample) : saveCapabilityResults(current.id, result.samples);
    for (const sample of samples) {
      if (sample.ok) continue;
      note(sample.outcome);
      const id = ('capability' in sample ? sample.capability : sample.operation) as QualificationId;
      failures.push(`${qualificationLabel(id)}: ${sample.reason || 'the test did not pass'}`);
    }
  }
  if (rowHasOperation(current, task)) return current;
  const detail = [...new Set(failures)].join(' · ') || qualificationReason(current, task);
  throw new ModelTaskError(outcome, `${current.name} failed the ${taskLabel(task)} test. ${detail}`);
}
