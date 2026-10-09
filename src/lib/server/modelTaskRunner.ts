import sharp from 'sharp';
import { validateTranscriptionChoice } from '../decider';
import { acquireModelUse } from './modelUsage';
import { rowHasOperation, type ModelRow } from '../modelRegistry';
import { ModelTaskError, taskLabel, validateTaskOutput, type ModelTaskId } from '../modelTasks';
import { modelPackage, modelPackageError, fingerprint, type DiscoveredPackage } from './modelPackages';
import { invokePackage, superviseModel } from './modelSupervisor';
import { invokeBuiltinAdapter, type TaskInput } from './modelAdapters';
import { isDiagnosticRun } from './assistantRoute';

/** Transport-only defaults for operator-created HTTP and CLI instances. */
export function packageForRow(row: ModelRow): DiscoveredPackage {
  const error = modelPackageError(row.id);
  if (error) throw new ModelTaskError('error', `Invalid model package: ${error}`);
  return modelPackage(row.id) || {
    directory: process.env.SCAN_ROOT || process.cwd(), fingerprint: fingerprint({ access: row.access, cli: row.cliAdapter }),
    manifest: { version: 1, id: row.id, name: row.name, revision: row.modelRevision || '1', access: row.access,
      model: row.slug, adapter: { id: row.access === 'cli' ? 'cli' : row.access === 'proofreader' ? 'browser-proofreader' : 'openai' },
      config: { provider: row.cliAdapter },
    },
  };
}

export async function executeModelTask(row: ModelRow, task: ModelTaskId, input: TaskInput,
  opts: { abort?: AbortSignal; diagnostic?: boolean; invoke?: () => Promise<any>; independentDiagnosticFields?: boolean } = {}): Promise<any> {
  opts.abort?.throwIfAborted();
  // A request may name the model the endpoint should run. Eligibility stays on
  // the resolved row's current probe, which is the package that was tested.
  let evidence = row;
  if (input.model && input.model !== row.slug) row = { ...row, slug: input.model };
  if (!(opts.diagnostic || isDiagnosticRun())) {
    if (evidence.disabled) throw new ModelTaskError('error', `${evidence.name} is disabled`);
    if (!rowHasOperation(evidence, task)) {
      const { ensureDefaultQualification } = await import('./modelQualification');
      const qualified = await ensureDefaultQualification(evidence, task, { abort: opts.abort });
      evidence = qualified;
      row = input.model && input.model !== qualified.slug ? { ...qualified, slug: input.model } : qualified;
    }
  }
  if (task === 'sourceReview') {
    const reading = await executeModelTask(evidence, 'vision', input, opts);
    return { status: reading.source.trim() ? 'unassessed' : 'unreadable', source: reading.source,
      translation: '', answer: reading.source.trim() ? 'Independent transcription.' : 'No text returned.' };
  }
  const pkg = packageForRow(row);
  return superviseModel(pkg, async () => {
    let output;
    const releases: Array<() => void> = [];
    try {
    if (!(opts.diagnostic || isDiagnosticRun())) {
      const current = (await import('./modelRegistryStore')).findRegistryRow(evidence.id);
      if (!current || current.disabled || !rowHasOperation(current, task) || current.taskFingerprints?.[task] !== evidence.taskFingerprints?.[task])
        throw new ModelTaskError('error', `${evidence.name} changed while this request was queued; recheck ${taskLabel(task)}.`);
    }
    if (opts.invoke) { releases.push(acquireModelUse(row.id)); output = await opts.invoke(); }
    else if (pkg.manifest.adapter.command) output = await invokePackage(pkg, 'execute', input, { task, signal: opts.abort, slug: input.model || row.slug });
    else output = await invokeBuiltinAdapter(pkg, row, task, input, opts.abort, release => releases.push(release));
  opts.abort?.throwIfAborted();
  validateTaskOutput(task, output, opts.diagnostic && opts.independentDiagnosticFields ? { required: [] } : input.schema);
  if (task === 'sourceDecide') {
    try { validateTranscriptionChoice(output, input.candidates); }
    catch (e) { throw new ModelTaskError('failed_validation', (e as Error).message); }
  }
  if (task === 'translate' && Array.isArray(input.boxes)) {
    if (output.length !== input.boxes.length) throw new ModelTaskError('failed_validation', 'Translation results do not match the submitted items');
    output = output.map((item: any, index: number) => ({ ...input.boxes[index], ...item }));
  }
  if (task === 'proofreadEnglish' && !(output instanceof Map)) {
    output = new Map(Object.entries(output).map(([index, value]) => [Number(index), value]));
    if ([...output.keys()].some(index => !Number.isInteger(index))) throw new ModelTaskError('failed_validation', 'Proofreading results need integer item IDs');
  }
  if (['textMask', 'segmentBubble', 'inpaint', 'cleaning'].includes(task)) {
    const data = task === 'textMask' || task === 'segmentBubble' ? output.mask || output.image : output.image || output.mask;
    output = { ...output, [task === 'textMask' || task === 'segmentBubble' ? 'mask' : 'image']: data };
    if (!/^data:image\/(?:png|jpeg);base64,/.test(data)) throw new ModelTaskError('failed_validation', 'Expected an image result');
    const bytes = Buffer.from(data.split(',')[1], 'base64');
    let actual;
    try { actual = await sharp(bytes).metadata(); }
    catch { throw new ModelTaskError('failed_validation', 'The adapter returned an unreadable image'); }
    const original = input.jpeg || input.image;
    if (original) {
      const expected = await sharp(original).metadata();
      if (actual.width !== expected.width || actual.height !== expected.height) throw new ModelTaskError('failed_validation', 'Output image dimensions differ from the input');
    }
  }
  return output;
    } finally { for (const release of releases.reverse()) release(); }
  }, opts.abort);
}
