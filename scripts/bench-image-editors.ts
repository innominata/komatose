/**
 * Runs both local editors over the same page and mask, so their results can be compared.
 *
 * Timing alone never decides which editor is better: the script records how far each one
 * moved pixels outside the approved mask (drift) and how much high-frequency ink is left
 * inside it (lettering that survived), then writes every artifact for a visual review.
 *
 *   node --import tsx scripts/bench-image-editors.ts --page data/images/.../01-01.jpg
 *
 * The mask comes from the same detector the workflow uses unless --mask names one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { IMAGE_EDIT_MODELS, type ImageEditModelId } from '../src/lib/imageEdit';
import { cleanWithQwenImage } from '../src/lib/server/qwenImageClean';
import { imageEditStatus, imageEditStatuses, stopAllImageEditServers } from '../src/lib/server/imageEdit';
import { listManagedStatuses, operateManagedModel, waitManagedOperation } from '../src/lib/server/managedModels';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const pageArg = flag('page');
if (!pageArg) {
  console.error('Usage: node --import tsx scripts/bench-image-editors.ts --page <page image> [--out <dir>]');
  process.exit(1);
}
const page = resolve(pageArg);
const outDir = resolve(flag('out') || '/tmp/scan-image-editor-benchmark');
const maskArg = flag('mask');
mkdirSync(outDir, { recursive: true });
const stem = basename(page).replace(/\.[a-z0-9]+$/i, '');

/** Only the requested editors run, so a single-model install still works. */
const requested = (flag('models') || IMAGE_EDIT_MODELS.map((model) => model.id).join(','))
  .split(',')
  .map((id) => id.trim()) as ImageEditModelId[];

/**
 * The app's own detector builds the removal mask, exactly as Prepare Chapter would.
 *
 * The detector only searches inside approved regions, so the benchmark hands it the whole
 * page unless --regions names a smaller search area.
 */
function detectMask(source: string, mask: string) {
  const script = resolve('ocr/workflow.py');
  // Same interpreter the local worker picks, so the mask matches a real run.
  const python =
    process.env.SCAN_WORKFLOW_PYTHON ||
    (existsSync('.venv-workflow/bin/python') ? '.venv-workflow/bin/python' : '.venv-ocr/bin/python');
  const regions = flag('regions')
    ? (JSON.parse(readFileSync(resolve(flag('regions')!), 'utf8')) as { x: number; y: number }[][])
    : [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]];
  const request = JSON.stringify({ cmd: 'mask', path: source, out: mask, detect: true, expansion: 1, regions });
  const stdout = execFileSync(python, [script], {
    input: `${request}\n`, encoding: 'utf8', env: { ...process.env, SAM2_BUILD_CUDA: '0' },
  });
  const line = stdout.trim().split('\n').pop() || '{}';
  const result = JSON.parse(line) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(`Mask detection failed: ${result.error}`);
}

/** Text leaves high-frequency ink behind; how much survives inside the mask is the score. */
async function inkInsideMask(image: string, mask: string) {
  const maskRaw = await sharp(mask).greyscale().raw().toBuffer({ resolveWithObject: true });
  const edges = await sharp(image)
    .greyscale()
    .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
    .raw()
    .toBuffer();
  let sum = 0;
  let marked = 0;
  for (let i = 0; i < edges.length; i++) {
    if (!maskRaw.data[i]) continue;
    marked++;
    sum += edges[i];
  }
  return marked ? sum / marked : 0;
}

/** Pixels the editor changed outside the approved mask: seams and drift show up here. */
async function driftOutsideMask(image: string, mask: string, original: string, width: number, height: number) {
  const [before, after] = await Promise.all(
    [original, image].map((path) =>
      sharp(path).resize(width, height, { fit: 'fill' }).toColourspace('srgb').removeAlpha().raw().toBuffer(),
    ),
  );
  const maskRaw = await sharp(mask).greyscale().raw().toBuffer();
  let changed = 0;
  let outside = 0;
  for (let pixel = 0; pixel < maskRaw.length; pixel++) {
    if (maskRaw[pixel]) continue;
    outside++;
    const at = pixel * 3;
    const delta = Math.abs(before[at] - after[at])
      + Math.abs(before[at + 1] - after[at + 1])
      + Math.abs(before[at + 2] - after[at + 2]);
    // A visible move, not the sub-pixel jitter of the round trip through PNG.
    if (delta > 24) changed++;
  }
  return outside ? changed / outside : 0;
}

const sourcePath = join(outDir, `${stem}-source.png`);
const maskPath = maskArg ? resolve(maskArg) : join(outDir, `${stem}-mask.png`);
await sharp(page).png().toFile(sourcePath);
if (!maskArg) detectMask(sourcePath, maskPath);
const meta = await sharp(sourcePath).metadata();
const width = meta.width!;
const height = meta.height!;
console.log(`page ${width}x${height} → ${sourcePath}`);

const rows: Record<string, unknown>[] = [];
for (const id of requested) {
  const model = IMAGE_EDIT_MODELS.find((entry) => entry.id === id);
  if (!model) throw new Error(`Unknown editor ${id}`);
  const out = join(outDir, `${id}-cleaned.png`);
  const started = Date.now();
  try {
    const result = await cleanWithQwenImage({ path: sourcePath, mask: maskPath, out, model: id });
    const seconds = (Date.now() - started) / 1000;
    const row = {
      model: id,
      label: model.label,
      seconds: Number(seconds.toFixed(1)),
      patches: result.patches,
      // Lower is better on both: ink means lettering survived, drift means the page moved.
      inkInsideMask: Number((await inkInsideMask(out, maskPath)).toFixed(2)),
      changedOutsideMask: Number((await driftOutsideMask(out, maskPath, sourcePath, width, height)).toFixed(4)),
      status: imageEditStatus(id),
      out,
    };
    rows.push(row);
    console.log(JSON.stringify({ ...row, status: undefined }));
  } catch (error) {
    rows.push({ model: id, label: model.label, error: error instanceof Error ? error.message : String(error) });
    console.log(JSON.stringify({ model: id, error: error instanceof Error ? error.message : String(error) }));
  }
}

const baseline = await inkInsideMask(sourcePath, maskPath);
writeFileSync(join(outDir, 'results.json'), `${JSON.stringify({
  page,
  width,
  height,
  baselineInkInsideMask: Number(baseline.toFixed(2)),
  rows,
}, null, 2)}\n`);
console.log(`baseline ink inside the mask (all lettering still present): ${baseline.toFixed(2)}`);
console.log(`results.json written to ${outDir}`);

// Hand the cards back to whatever the editors unloaded, so a benchmark does not leave
// the app's chat models down.
const evicted = [...new Set(imageEditStatuses().flatMap((status) => status.evicted))];
await stopAllImageEditServers().catch(() => {});
for (const managed of evicted) {
  if (!listManagedStatuses().some((row) => String(row.id) === managed)) continue;
  operateManagedModel(managed, 'start');
  await waitManagedOperation(managed);
  console.log(`handed the card back to ${managed}`);
}
