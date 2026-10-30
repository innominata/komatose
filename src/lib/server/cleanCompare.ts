import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Episode, ImageRow, LineRow } from "../types";
import { pageArtwork, type PageData, type RegionData } from "../workflow";
import { rowHasOperation } from "../modelRegistry";
import { createJob, updateJob } from "./jobs";
import { localOperation } from "./localWorker";
import { imageWorkflowModel, runImageTaskFiles } from "./modelImageWorkflow";
import { DATA_DIR } from "./paths";
import { getDoc, putDoc, readAsset, storeAsset, withPreviousArtwork, WorkflowError } from "./workflowStore";

/**
 * Compare cleaning methods on one region: each chosen method runs on the same crop of the
 * page artwork and mask, and the results are kept apart from the page. Applying one pastes
 * that crop back through the mask as an ordinary artwork edit (undoable like any clean).
 */

export type CompareBox = { left: number; top: number; width: number; height: number };
export type CompareResult = { method: string; label: string; asset?: string; error?: string; ms?: number };

/** Built-in methods that need no model; clone stamping needs a source, so it is left out. */
const TOOL_LABELS: Record<string, string> = { flat: "Flat fill", telea: "Telea inpaint", auto: "Auto" };

export function comparisonBox(line: LineRow, region: RegionData, page: ImageRow): CompareBox {
  const pts = region.polygon?.length
    ? region.polygon
    : [{ x: line.x ?? 0, y: line.y ?? 0 }, { x: (line.x ?? 0) + (line.w ?? 0.1), y: (line.y ?? 0) + (line.h ?? 0.1) }];
  const xs = pts.map((p) => p.x * page.width), ys = pts.map((p) => p.y * page.height);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // Context around the region helps every inpainter; a quarter of its size, at least 32 px.
  const margin = Math.max(32, Math.round(Math.max(x1 - x0, y1 - y0) * 0.25));
  const left = Math.max(0, Math.floor(x0 - margin)), top = Math.max(0, Math.floor(y0 - margin));
  const right = Math.min(page.width, Math.ceil(x1 + margin)), bottom = Math.min(page.height, Math.ceil(y1 + margin));
  if (right - left < 8 || bottom - top < 8) throw new WorkflowError("This region is too small to compare");
  return { left, top, width: right - left, height: bottom - top };
}

const crop = (bytes: Buffer, box: CompareBox) => sharp(bytes).extract(box).png().toBuffer();

/** Starts a comparison job; results arrive in the job's progress as each method finishes. */
export async function startCleanComparison(opts: {
  episode: Episode;
  page: ImageRow;
  line: LineRow;
  methods: string[];
  labels: Record<string, string>;
  prompt?: string;
}) {
  const doc = getDoc<PageData>(`page:${opts.page.id}`, {});
  if (!doc.data.mask) throw new WorkflowError("Paint or detect a mask before comparing cleaning methods");
  const artwork = pageArtwork(doc.data);
  if (!artwork) throw new WorkflowError("Prepare this page first");
  const methods = [...new Set(opts.methods)].filter((m) => TOOL_LABELS[m] || imageWorkflowModel(m));
  if (!methods.length) throw new WorkflowError("Choose at least one cleaning method");
  const region = getDoc<RegionData>(`region:${opts.line.id}`, {}).data;
  const box = comparisonBox(opts.line, region, opts.page);
  const [source, mask] = await Promise.all([crop(await readAsset(artwork), box), crop(await readAsset(doc.data.mask), box)]);
  const maskMax = (await sharp(mask).greyscale().stats()).channels[0].max;
  if (!maskMax) throw new WorkflowError("The mask has nothing in this region. Paint or detect it first.");
  const [sourceAsset, maskAsset] = await Promise.all([storeAsset(source), storeAsset(mask)]);
  const label = (m: string) => opts.labels[m] || TOOL_LABELS[m] || imageWorkflowModel(m)?.name || m;
  const results: CompareResult[] = methods.map((method) => ({ method, label: label(method) }));
  const jobId = createJob(opts.episode.id, "clean-compare", {
    imageId: opts.page.id,
    lineId: opts.line.id,
    methods,
    artwork,
    box,
  });
  const base = { imageId: opts.page.id, lineId: opts.line.id, box, artwork, source: sourceAsset, mask: maskAsset, results };
  updateJob(jobId, "running", { ...base, message: `Comparing ${methods.length} cleaning methods`, step: "compare" });

  void (async () => {
    const dir = join(DATA_DIR, "workflow", `compare-${randomUUID()}`);
    await mkdir(dir, { recursive: true });
    const sourcePath = join(dir, "source.png"), maskPath = join(dir, "mask.png");
    await Promise.all([writeFile(sourcePath, source), writeFile(maskPath, mask)]);
    try {
      for (const [i, method] of methods.entries()) {
        updateJob(jobId, "running", { ...base, results, message: `Cleaning with ${results[i].label} (${i + 1} of ${methods.length})` });
        const out = join(dir, `${i}.png`);
        const started = Date.now();
        try {
          const model = imageWorkflowModel(method);
          if (model) {
            const task = rowHasOperation(model, "inpaint") ? "inpaint" : "cleaning";
            await runImageTaskFiles(model, task, { path: sourcePath, mask: maskPath, out, ...(opts.prompt ? { prompt: opts.prompt } : {}) });
          } else {
            await localOperation({ cmd: "clean", path: sourcePath, mask: maskPath, out, method, strokes: [], offset: [0, 0] });
          }
          // Editors may return another size; the comparison is always the crop's size.
          const png = await sharp(await readFile(out)).resize(box.width, box.height, { fit: "fill" }).png().toBuffer();
          results[i] = { ...results[i], asset: await storeAsset(png), ms: Date.now() - started };
        } catch (e) {
          results[i] = { ...results[i], error: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
        }
      }
      const ok = results.filter((r) => r.asset).length;
      updateJob(jobId, "completed", { ...base, results, message: `${ok} of ${methods.length} methods finished` });
    } catch (e) {
      updateJob(jobId, "failed", { ...base, results }, e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();
  return jobId;
}

/**
 * Pastes a comparison result into the page artwork through the region's mask (grown a little
 * so edges blend), as a clean result to review like any other.
 */
export async function applyCleanComparison(opts: {
  episodeId: string;
  page: ImageRow;
  /** The artwork the comparison ran on; applying is refused if the page has new artwork since. */
  artwork: string;
  result: string;
  mask: string;
  box: CompareBox;
  method: string;
}) {
  const doc = getDoc<PageData>(`page:${opts.page.id}`, {});
  const artwork = pageArtwork(doc.data);
  if (!artwork) throw new WorkflowError("Prepare this page first");
  if (artwork !== opts.artwork)
    throw new WorkflowError("The page artwork changed since the comparison ran; compare again", 409);
  const { box } = opts;
  const alpha = await sharp(await readAsset(opts.mask)).greyscale().blur(1.2).linear(3, 0).toColourspace("b-w").raw().toBuffer();
  const patch = await sharp(await readAsset(opts.result))
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .joinChannel(alpha, { raw: { width: box.width, height: box.height, channels: 1 } })
    .png()
    .toBuffer();
  const next = await sharp(await readAsset(artwork)).composite([{ input: patch, left: box.left, top: box.top }]).png().toBuffer();
  const artifact = await storeAsset(next);
  return putDoc(
    opts.episodeId,
    doc.id,
    withPreviousArtwork(doc.id, doc.data, { ...doc.data, cleaned: artifact, cleanMethod: opts.method, cleanApproved: false }, "replace"),
    doc.revision,
  );
}
