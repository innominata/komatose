import { advisoryModel, validateModel } from "./regionAi";
import { regionAiSettings } from "../regionAi";
import { preferences } from "./workflowService";
import { createJob, listJobs, runWithJob, updateJob } from "./jobs";
import { WorkflowError } from "./workflowStore";
import { listImages, listLines } from "./queries";
import { addAcceptedSeriesTerms, currentSeriesGlossary } from "./seriesGlossary";
import { glossaryPrompt } from "../glossary";
import type { Episode, ImageRow, LineRow, PublicUser, Series } from "../types";
import type { TaskEngine } from "../aiTasks";
import { logActivity } from "./activity";

export const GLOSSARY_MINE_KINDS = ["name", "place", "catchphrase", "title", "other"] as const;
export type GlossaryMineKind = (typeof GLOSSARY_MINE_KINDS)[number];
export type GlossaryMineTerm = {
  source: string;
  translation: string;
  kind: GlossaryMineKind;
  reason: string;
  state: "pending" | "accepted" | "rejected";
};

export const GLOSSARY_MINE_SYSTEM =
  "You extract series-specific recurring terms from a reviewed bilingual scanlation script. Pick names, places, catchphrases, titles, and honorifics that later chapters should keep consistent. Do not include common words, one-off lines, or terms already listed in the glossary. Return JSON with a terms array.";

export const GLOSSARY_MINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["terms"],
  properties: {
    terms: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "translation", "kind", "reason"],
        properties: {
          source: { type: "string" },
          translation: { type: "string" },
          kind: { type: "string", enum: [...GLOSSARY_MINE_KINDS] },
          reason: { type: "string" },
        },
      },
    },
  },
};

const runtime = globalThis as typeof globalThis & { __scanGlossaryMines?: Map<string, AbortController> };
const active = (runtime.__scanGlossaryMines ??= new Map());

export function isReviewedLine(line: LineRow) {
  return (
    line.sourceState !== "ignored" &&
    line.status === "approved" &&
    !!(line.source || "").trim() &&
    !!line.body.trim()
  );
}

export function glossaryMineBlockers(lines: LineRow[]) {
  return lines.filter(
    (line) =>
      line.sourceState !== "ignored" &&
      (line.status !== "approved" || !(line.source || "").trim() || !line.body.trim()),
  );
}

export function reviewedBilingualScript(lines: LineRow[], images: ImageRow[]): string {
  const pageOf = new Map(images.map((img) => [img.id, img.pageNumber ?? img.sortOrder + 1]));
  return lines
    .filter(isReviewedLine)
    .sort((a, b) => {
      const pa = pageOf.get(a.imageId ?? "") ?? 0;
      const pb = pageOf.get(b.imageId ?? "") ?? 0;
      return pa - pb || a.sortOrder - b.sortOrder;
    })
    .map((line) => `Page ${pageOf.get(line.imageId ?? "") ?? "?"} · ${line.sortOrder + 1}\n${line.source}\n${line.body}`)
    .join("\n\n");
}

export function parseGlossaryMine(value: unknown): GlossaryMineTerm[] {
  const rec = value && typeof value === "object" ? (value as { terms?: unknown }) : {};
  if (!Array.isArray(rec.terms)) throw new WorkflowError("The model returned no glossary terms.");
  const seen = new Set<string>();
  const terms: GlossaryMineTerm[] = [];
  for (const item of rec.terms) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const source = String(row.source || "").trim();
    const translation = String(row.translation || "").trim();
    const kind = GLOSSARY_MINE_KINDS.includes(row.kind as GlossaryMineKind)
      ? (row.kind as GlossaryMineKind)
      : "other";
    const reason = String(row.reason || "").trim().slice(0, 400);
    if (!source || !translation || seen.has(source)) continue;
    seen.add(source);
    terms.push({ source, translation, kind, reason, state: "pending" });
  }
  return terms;
}

export function cancelGlossaryMine(jobId: string) {
  active.get(jobId)?.abort();
}

export async function startGlossaryMine(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  engine?: TaskEngine["engine"];
  model?: string;
}) {
  const [lines, images] = await Promise.all([listLines(opts.episode.id), listImages(opts.episode.id)]);
  const pending = glossaryMineBlockers(lines);
  if (pending.length)
    throw new WorkflowError(
      `Finish review first. ${pending.length} region${pending.length === 1 ? "" : "s"} still need source, English, or approval.`,
      409,
    );
  const script = reviewedBilingualScript(lines, images);
  if (!script) throw new WorkflowError("This chapter has no approved source and English to mine.");
  if (listJobs(opts.episode.id).some((job) => job.kind === "glossary-mine" && ["running", "queued", "cancelling"].includes(job.state)))
    throw new WorkflowError("Series terms are already being extracted.", 409);
  const model = validateModel(
    opts.engine
      ? { engine: opts.engine, model: opts.model || "" }
      : regionAiSettings(preferences(opts.episode.id, opts.series.id).regionAi).enquire,
  );
  const existing = currentSeriesGlossary(opts.series.id);
  const jobId = createJob(opts.episode.id, "glossary-mine", { ...model });
  const abort = new AbortController();
  active.set(jobId, abort);
  updateJob(jobId, "running", { message: "Reading the reviewed script…", terms: [] });
  void runWithJob({ jobId, step: "glossary-mine", ...model }, async () => {
    try {
      abort.signal.throwIfAborted();
      const result = await advisoryModel(
        model,
        GLOSSARY_MINE_SYSTEM,
        [
          existing.length ? `Existing series glossary (do not repeat these sources):\n${glossaryPrompt(existing, 80)}` : "No series glossary yet.",
          `Reviewed bilingual script for ${opts.episode.title}:\n${script}`,
        ].join("\n\n"),
        [],
        abort.signal,
        GLOSSARY_MINE_SCHEMA,
      );
      abort.signal.throwIfAborted();
      const known = new Set(existing.map((t) => t.source.trim()));
      const terms = parseGlossaryMine(result).filter((t) => !known.has(t.source));
      updateJob(jobId, "completed", {
        terms,
        message: terms.length
          ? `${terms.length} series term${terms.length === 1 ? "" : "s"} ready to accept`
          : "No new series terms found",
      });
    } catch (error) {
      updateJob(
        jobId,
        abort.signal.aborted ? "cancelled" : "failed",
        { message: abort.signal.aborted ? "Cancelled" : "Glossary extraction failed" },
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      active.delete(jobId);
    }
  });
  return { jobId };
}

export async function decideGlossaryMineTerms(opts: {
  series: Series;
  episode: Episode;
  user: PublicUser;
  jobId: string;
  decisions: { source: string; decision: "accept" | "reject" }[];
}) {
  const job = listJobs(opts.episode.id).find((j) => j.id === opts.jobId && j.kind === "glossary-mine");
  if (!job) throw new WorkflowError("Glossary job not found", 404);
  const terms = ((job.progress?.terms as GlossaryMineTerm[] | undefined) ?? []).map((term) => ({ ...term }));
  if (!terms.length) throw new WorkflowError("This job has no terms to review");
  const accepted: { source: string; translation: string }[] = [];
  for (const choice of opts.decisions) {
    const term = terms.find((t) => t.source === choice.source.trim());
    if (!term || term.state !== "pending") continue;
    term.state = choice.decision === "accept" ? "accepted" : "rejected";
    if (choice.decision === "accept") accepted.push({ source: term.source, translation: term.translation });
  }
  if (accepted.length) addAcceptedSeriesTerms(opts.series.id, accepted);
  const waiting = terms.filter((t) => t.state === "pending").length;
  updateJob(job.id, job.state, {
    ...job.progress,
    terms,
    message: waiting
      ? `${waiting} series term${waiting === 1 ? "" : "s"} still waiting`
      : "Series terms reviewed",
  });
  if (accepted.length)
    await logActivity({
      seriesId: opts.series.id,
      episodeId: opts.episode.id,
      userId: opts.user.id,
      action: "accepted_series_glossary",
      payload: { count: accepted.length, sources: accepted.map((t) => t.source) },
    });
  return { terms, glossary: currentSeriesGlossary(opts.series.id) };
}
