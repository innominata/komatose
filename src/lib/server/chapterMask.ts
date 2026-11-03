import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { join } from "node:path";
import type { Episode, Series } from "../types";
import type { PageData, WorkflowDoc } from "../workflow";
import { storyPages } from "../credits";
import { listImages } from "./queries";
import {
  assetPath,
  getDoc,
  putDoc,
  storeAsset,
  WorkflowError,
} from "./workflowStore";
import { preparePage } from "./workflowService";
import { localOperation } from "./localWorker";
import { createJob, listJobs, pageResult, runWithJob, updateJob } from "./jobs";
import { imageWorkflowModel } from "./modelImageWorkflow";
import { rowHasOperation } from "../modelRegistry";
import { requireDefault } from "./modelDefaultStore";

const aborts = new Map<string, AbortController>();
export function cancelChapterMask(jobId: string) {
  aborts.get(jobId)?.abort();
}

type Options = {
  series: Series;
  episode: Episode;
  maskEngine?: string;
  expansion?: number;
  imageIds?: string[];
};

/** Only produces masks: no regions, OCR, translation or proofreading. */
export async function startChapterMask(
  options: Options,
  operation = localOperation,
) {
  const { series, episode } = options;
  if (
    listJobs(episode.id).some((j) =>
      ["running", "queued", "cancelling"].includes(j.state),
    )
  )
    throw new WorkflowError(
      "Wait for active chapter jobs to finish before masking the chapter",
      409,
    );
  const engine =
    !options.maskEngine || options.maskEngine === "auto"
      ? requireDefault("textMask")
      : options.maskEngine;
  const model = imageWorkflowModel(engine);
  if (
    !model ||
    model.disabled ||
    (!model.implementedTasks?.includes("textMask") &&
      !rowHasOperation(model, "textMask"))
  )
    throw new WorkflowError("Choose a lettering mask model");
  const expansion = options.expansion ?? 5;
  if (!Number.isFinite(expansion) || expansion < 0 || expansion > 20)
    throw new WorkflowError("Mask padding must be between 0 and 20 pixels");
  const pages = storyPages(await listImages(episode.id)).filter(
    (p) => !options.imageIds || options.imageIds.includes(p.id),
  );
  if (!pages.length)
    throw new WorkflowError("Add chapter pages before masking");
  if (
    listJobs(episode.id).some((j) =>
      ["running", "queued", "cancelling"].includes(j.state),
    )
  )
    throw new WorkflowError(
      "Wait for active chapter jobs to finish before masking the chapter",
      409,
    );
  const revisions = new Map(
    pages.map((p) => [p.id, getDoc(`page:${p.id}`, {}).revision]),
  );
  const jobId = createJob(episode.id, "mask-chapter", {
    engine,
    expansion,
    imageIds: pages.map((p) => p.id),
  });
  const abort = new AbortController();
  aborts.set(jobId, abort);
  let completed = 0;
  const errors: string[] = [];
  const progress = () => ({
    completed,
    total: pages.length,
    errors,
    engine,
    model: model.name,
    message: `Masking chapter · ${completed}/${pages.length} · ${model.name}`,
  });
  updateJob(jobId, "running", progress());
  void (async () => {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "komatose-chapter-mask-"));
      for (const page of pages) {
        abort.signal.throwIfAborted();
        pageResult(jobId, page.id, "running");
        try {
          const current = (await listImages(episode.id)).find(
            (p) => p.id === page.id,
          );
          if (
            !current ||
            current.updatedAt !== page.updatedAt ||
            getDoc(`page:${page.id}`, {}).revision !== revisions.get(page.id)
          )
            throw new WorkflowError(
              "Page changed after chapter masking started; its work was kept",
              409,
            );
          const doc: WorkflowDoc<PageData> = await preparePage(
            series,
            episode,
            current,
          );
          const source = doc.data.cleanBase || doc.data.prepared!;
          const output = join(directory, `${page.id}.png`);
          const result = await runWithJob(
            {
              jobId,
              imageId: page.id,
              step: "Detecting whole-page lettering",
              engine,
            },
            () =>
              operation(
                {
                  cmd: "mask",
                  path: assetPath(source),
                  out: output,
                  detect: true,
                  wholePage: true,
                  maskEngine: engine,
                  expansion,
                  strokes: [],
                },
                abort.signal,
              ),
          );
          abort.signal.throwIfAborted();
          const bytes = await readFile(output);
          const metadata = await sharp(bytes).metadata();
          if (
            metadata.width !== current.width ||
            metadata.height !== current.height
          )
            throw new WorkflowError(
              "Detected mask dimensions do not match the page; its mask was kept",
            );
          const mask = await storeAsset(bytes);
          const latest = (await listImages(episode.id)).find(
            (p) => p.id === page.id,
          );
          abort.signal.throwIfAborted();
          if (!latest || latest.updatedAt !== current.updatedAt)
            throw new WorkflowError(
              "Page artwork changed; its mask was kept",
              409,
            );
          const completedSteps = { ...doc.data.completed };
          delete completedSteps.clean;
          const data: PageData = {
            ...doc.data,
            mask,
            strokes: [],
            maskApproved: false,
            cleanApproved: false,
            completed: completedSteps,
            expansion,
            maskDiagnostics: {
              mask,
              source,
              regions: "",
              wholePage: true,
              version: String(result.maskVersion || "whole-page"),
              engine: String(result.maskEngine || engine),
              backend: String(result.backend || "Model adapter"),
              entries: result.maskDiagnostics || [],
            },
          };
          // Optimistic revision check also protects manual masks edited during inference.
          putDoc(episode.id, doc.id, data, doc.revision);
          completed++;
          pageResult(jobId, page.id, "completed");
        } catch (error) {
          if (abort.signal.aborted) {
            pageResult(jobId, page.id, "cancelled");
            throw error;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          errors.push(`${page.originalName}: ${message}`);
          pageResult(jobId, page.id, "failed", message);
        }
        updateJob(jobId, "running", progress());
      }
      updateJob(
        jobId,
        errors.length ? "failed" : "completed",
        {
          ...progress(),
          message: errors.length
            ? `Masked ${completed}/${pages.length} pages; ${errors.length} need attention`
            : `Chapter masks ready · ${completed} pages. Inspect before cleaning.`,
        },
        errors.length ? errors.join("\n") : undefined,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        {
          ...progress(),
          message: abort.signal.aborted
            ? `Cancelled · ${completed}/${pages.length} masks saved`
            : message,
        },
        abort.signal.aborted ? undefined : message,
      );
    } finally {
      aborts.delete(jobId);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  })();
  return { jobId };
}
