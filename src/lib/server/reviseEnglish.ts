import { proofreaderOnlyMessage } from '../proofreaders';
import { holdManagedModel } from './managedModels';
import { listRegistryRows } from './modelRegistryStore';
import { glossaryForSource } from "../glossary";
import type { TaskEngine } from "../aiTasks";
import type { AiActionCard } from "../regionAi";
import {
  FAST_REVISE_SAMPLES,
  isProofreaderTranslator,
  isOnDemandReviewer,
  reviseSampleCount,
} from "../regionAi";
import { translationModel, type TranslationModel } from "../translationModels";
import { normalizeTranslation } from "../translationText";
import type { Episode, LineRow, Series } from "../types";
import { liveAssistantName, resolveLiveAssistant } from "./assistantRoute";
import { assertEngineReady } from "./engineReadiness";
import type { DetectedBox } from "./llm";
import { translateScript } from "./llm";
import { translateScriptWithCli } from "./cliTranslate";
import { loadChapterPack, sceneNotesForPage } from "./proofread";
import { listImages } from "./queries";
import { preferences } from "./workflowService";
import { suggest, WorkflowError } from "./workflowStore";
import { runTranslationTask } from "./translationTask";
import { characterContext, resolveCharacter } from '../characters';
import { loadSpeakerAssignments } from './characters';

export { FAST_REVISE_SAMPLES };
export const FAST_REVISE_TEMPERATURES = [0.15, 0.4, 0.65];

const translationHandlers = {
  cli: translateScriptWithCli,
  local: translateScript,
};

export function reviseTemperatures(_model: TaskEngine, samples = 1): Array<number | undefined> {
  const n = Math.min(FAST_REVISE_SAMPLES, Math.max(1, samples));
  return n === 1 ? [undefined] : FAST_REVISE_TEMPERATURES.slice(0, n);
}

export function uniqueRevisions(
  hits: { text: string; reason: string }[],
  current: string,
): { text: string; reason: string }[] {
  const seen = new Set([normalizeTranslation(current).trim().toLowerCase()].filter(Boolean));
  const out: { text: string; reason: string }[] = [];
  for (const hit of hits) {
    const text = normalizeTranslation(hit.text).trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push({ text, reason: hit.reason });
  }
  return out;
}

export async function reviseEnglish(opts: {
  series: Series;
  episode: Episode;
  line: LineRow;
  model: TaskEngine;
  samples?: number;
  selected?: boolean;
  abort?: AbortSignal;
}): Promise<{ label: string; cards: AiActionCard[]; error?: string }> {
  const label = liveAssistantName(opts.model.engine, opts.model.model);
  let release = () => {};
  try {
    const resolved = resolveLiveAssistant(opts.model.engine, opts.model.model);
    release = await holdManagedModel(resolved.row.id, Boolean(resolved.row.managedLaunch), opts.abort);
    if (isOnDemandReviewer(opts.model, listRegistryRows()) && !opts.selected)
      throw new WorkflowError(`Select ${label} using its Run button, or enable Autorun in Admin → Models. Send runs local models and models with Autorun enabled.`);
    await assertEngineReady(opts.model.engine, opts.model.model);
    const source = opts.line.source?.trim() || "";
    if (!source) throw new WorkflowError("Add source text before revising English");
    const pack = await loadChapterPack({
      seriesId: opts.series.id,
      episodeId: opts.episode.id,
      lang: preferences(opts.episode.id, opts.series.id).lang,
    });
    const glossary = glossaryForSource(opts.series.glossary ?? [], source);
    const imgs = await listImages(opts.episode.id);
    const prefs = preferences(opts.episode.id, opts.series.id);
    const index = pack.targets.findIndex((l) => l.id === opts.line.id);
    const nearby = pack.items
      .filter((_, i) => index < 0 || (i !== index && Math.abs(i - index) <= 8))
      .map((l) => `${l.page} (${l.lineType}) Speaker: ${l.speaker || 'unknown'} · ${l.source} → ${l.current}`)
      .join("\n");
    const current = opts.line.body.trim();
    const pageCaption = [
      sceneNotesForPage(imgs, opts.line.imageId, prefs.chapterSummary),
      `Human-assigned speaker (not the person addressed): ${characterContext(resolveCharacter(loadSpeakerAssignments(opts.episode.id).get(opts.line.id), pack.series.glossary))}`,
      current && `Current English draft (may be wrong):\n${current}`,
      nearby && `Nearby lines:\n${nearby}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const pageLabel =
      index >= 0 ? pack.items[index]?.page || "selection" : "selection";
    const boxes: DetectedBox[] = [
      {
        x: opts.line.x ?? 0,
        y: opts.line.y ?? 0,
        w: opts.line.w ?? 0.2,
        h: opts.line.h ?? 0.1,
        lineType: opts.line.lineType,
        source,
        speaker: index >= 0 ? pack.items[index]?.speaker : undefined,
        literal: "",
        translation: "",
        reasoning: "",
      },
    ];
    const temps = reviseTemperatures(opts.model, opts.samples);
    const hits: { text: string; reason: string }[] = [];
    let lastError = "";
    for (const temperature of temps) {
      try {
        opts.abort?.throwIfAborted();
        const translated = await runTranslationTask(
          {
            engine: opts.model.engine,
            boxes,
            seriesNotes: pack.seriesNotes,
            prior: pack.prior,
            pageLabel,
            pageCaption,
            seriesGlossary: [glossary, pack.seriesGlossary].filter(Boolean).join('\n'),
            abort: opts.abort,
            lang: prefs.lang,
            model: opts.model.model,
            ...(temperature != null ? { temperature } : {}),
          },
          translationHandlers,
        );
        const text = translated[0]?.translation.trim() || "";
        if (text)
          hits.push({
            text,
            reason: translated[0]?.reasoning || `${label} revision`,
          });
      } catch (error) {
        if (opts.abort?.aborted) throw error;
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    const unique = uniqueRevisions(hits, current);
    const cards: AiActionCard[] = unique.map((hit) => {
      const id = suggest(
        opts.episode.id,
        opts.line.id,
        opts.line.revision ?? 0,
        hit.text,
        `Review Translation · ${label}: ${hit.reason}`,
        "revise",
      );
      return { id, target: "body", body: hit.text, reason: hit.reason };
    });
    return { label, cards, error: cards.length || hits.length ? undefined : lastError || undefined };
  } catch (error) {
    if (opts.abort?.aborted) throw error;
    return {
      label,
      cards: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally { release(); }
}
