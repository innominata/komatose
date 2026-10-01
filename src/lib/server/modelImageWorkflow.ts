import { readFile, writeFile } from 'node:fs/promises';
import { findRegistryRow, listRegistryRows } from './modelRegistryStore';
import { executeModelTask } from './modelTaskRunner';
import { rowHasOperation, resolveAssistant, type ModelRow } from '../modelRegistry';
import { discoverModelPackages } from './modelPackages';
import type { ModelTaskId } from '../modelTasks';

/** Legacy method names are aliases in package configuration, not capability rules. */
export function imageWorkflowModel(id: string): ModelRow | undefined {
  const direct = findRegistryRow(id);
  if (direct) return direct;
  const pkg = discoverModelPackages().packages.find(p => Array.isArray(p.manifest.config?.aliases) && p.manifest.config.aliases.includes(id));
  if (pkg) return findRegistryRow(pkg.manifest.id);
  try { return resolveAssistant(id, '', listRegistryRows(), false).row; } catch { return undefined; }
}
export async function runImageTaskFiles(row: ModelRow, task: ModelTaskId,
  opts: { path: string; out: string; mask?: string; prompt?: string }, abort?: AbortSignal) {
  const [image, mask] = await Promise.all([readFile(opts.path), opts.mask ? readFile(opts.mask) : undefined]);
  const result = await executeModelTask(row, task, { image, jpeg: image, mask, prompt: opts.prompt }, { abort });
  await writeFile(opts.out, Buffer.from((result.image || result.mask).split(',')[1], 'base64'));
  return { ...result, method: row.id, backend: 'Model adapter' };
}
export function imageWorkflowChoices() {
  return listRegistryRows().filter(row => !row.disabled).map(row => ({ id: row.id, label: row.name,
    tasks: (['detect', 'textMask', 'segmentBubble', 'inpaint', 'cleaning'] as ModelTaskId[]).filter(task => rowHasOperation(row, task)),
  })).filter(row => row.tasks.length);
}
