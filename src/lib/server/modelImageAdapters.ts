import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ModelRow } from '../modelRegistry';
import { ModelTaskError, type ModelTaskId } from '../modelTasks';
import type { DiscoveredPackage } from './modelPackages';
import type { TaskInput } from './modelAdapters';

export async function invokeImageAdapter(pkg: DiscoveredPackage, row: ModelRow, task: ModelTaskId, input: TaskInput, abort?: AbortSignal) {
  const adapter = pkg.manifest.adapter.id;
  const backend = String(pkg.manifest.config?.backend || row.id);
  // Adapter dispatch is the authoritative unsupported result; application probes never skip it.
  const supported = adapter === 'cli' ? task === 'cleaning' : adapter === 'native-detector' ? task === 'detect' || backend === 'ctd' && task === 'textMask'
    : adapter === 'image-editor' ? task === 'cleaning'
    : backend === 'sam' ? task === 'segmentBubble'
    : backend === 'koharu' ? task === 'detect' || task === 'textMask'
    : backend === 'coo' ? task === 'detect' : task === 'inpaint';
  if (!supported) throw new ModelTaskError('unsupported', `${adapter} (${backend}) does not implement ${task}`);
  const dir = await mkdtemp(join(tmpdir(), 'komatose-image-task-'));
  try {
    const path = join(dir, 'input.png'), out = join(dir, 'output.png'), mask = join(dir, 'mask.png');
    const image = input.jpeg || input.image;
    await writeFile(path, image);
    const meta = await sharp(image).metadata();
    if (input.mask) await writeFile(mask, input.mask);
    if (adapter === 'native-detector' && task === 'detect') {
      const { rawDetectRegionsPy } = await import('./ocr');
      const result = await rawDetectRegionsPy(path, { ...input, backend, abort });
      return { regions: result.regions.map(r => ({ x: r.box[0] / result.width, y: r.box[1] / result.height,
        w: (r.box[2] - r.box[0]) / result.width, h: (r.box[3] - r.box[1]) / result.height, score: r.score, cls: r.cls })) };
    }
    let metadata: Record<string, any> = {};
    if (adapter === 'cli') {
      const { cleanWithCodex } = await import('./codexClean');
      metadata = await cleanWithCodex({ path, out, mask, prompt: input.prompt, model: row.slug }, abort);
    } else if (adapter === 'image-editor') {
      const { cleanWithQwenImage } = await import('./qwenImageClean');
      await cleanWithQwenImage({ path, out, mask, prompt: input.prompt, model: backend as any }, abort);
    } else {
      const { rawLocalOperation } = await import('./localWorker');
      const cmd = task === 'detect' ? backend === 'coo' ? 'detect-sfx' : 'detect-text'
        : task === 'textMask' ? 'mask' : task === 'segmentBubble' ? 'geometry' : 'clean';
      const result = await rawLocalOperation({ ...input, cmd, path, out, mask: input.mask ? mask : undefined,
        regions: input.regions || [[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}]],
        method: backend === 'lama-manga' ? 'lama' : backend, maskEngine: backend, detect: task === 'textMask', box: input.box || [0, 0, 1, 1] }, abort);
      metadata = result;
      if (task === 'detect') {
        const { parseKoharuRegions, parseSfxRegions } = await import('./detect');
        const regions = backend === 'coo' ? parseSfxRegions(result.regions) : parseKoharuRegions(result.regions);
        const mapped = regions.map(r => ({ x: r.box[0] / meta.width!, y: r.box[1] / meta.height!,
          w: (r.box[2] - r.box[0]) / meta.width!, h: (r.box[3] - r.box[1]) / meta.height!, cls: r.cls, score: r.score,
          // Chapter transcription rejects a COO region without its contour, so it must survive the adapter.
          ...(r.polygon ? { polygon: r.polygon, backend: r.backend, crop: r.crop, truncated: r.truncated } : {}) }));
        // detect-text writes a lettering mask to `out`. Transcription reads it via
        // localOperation's payload.out, so the mask must survive this temp dir.
        if (backend === 'koharu') {
          return { ...metadata, regions: mapped, mask: `data:image/png;base64,${(await readFile(out)).toString('base64')}` };
        }
        return { regions: mapped };
      }
      if (task === 'segmentBubble') {
        if (!Array.isArray(result.polygon) || result.polygon.length < 3) throw new ModelTaskError('failed_validation', 'No bubble interior returned');
        const points = result.polygon.map((p: any) => `${p.x * meta.width!},${p.y * meta.height!}`).join(' ');
        await sharp(Buffer.from(`<svg width="${meta.width}" height="${meta.height}"><rect width="100%" height="100%" fill="black"/><polygon points="${points}" fill="white"/></svg>`)).png().toFile(out);
      }
    }
    return { ...metadata, [task === 'textMask' || task === 'segmentBubble' ? 'mask' : 'image']: `data:image/png;base64,${(await readFile(out)).toString('base64')}` };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
