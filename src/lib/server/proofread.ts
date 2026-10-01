import { preferences } from "./workflowService";
import { suggest } from "./workflowStore";
import { eq } from "drizzle-orm";
import type {
  CommentRow,
  ImageRow,
  LineRow,
  OcrLang,
  TranslateEngine,
} from "../types";
import { glossaryPrompt } from "../glossary";
import { ensureAiUser } from "./aiUser";
import { proofreadScriptWithCli } from "./cliTranslate";
import { liveAssistantName } from "./assistantRoute";
import { db } from "./db";
import { comments, lines } from "./db/schema";
import { nid, now } from "./ids";
import { proofreadScript, type ProofreadItem } from "./llm";
import {
  runProofreadEnglish,
  type ProofreadEnglishHandlers,
} from "./proofreadEnglish";
import {
  getEpisode,
  getSeries,
  listComments,
  listImages,
  listLines,
  toLine,
} from "./queries";
import { broadcast } from "./realtime";

const CHUNK = 32;

/** The real proofread-English handlers — exported so model probes run the very same path. */
export const proofreadEnglishHandlers: ProofreadEnglishHandlers = {
  cli: proofreadScriptWithCli,
  local: proofreadScript,
};

export type ProofreadProgress = {
  message: string;
  imageIndex: number;
  imageCount: number;
};

function prefix(body: string, tag: string): string | null {
  return body.startsWith(tag) ? body.slice(tag.length).trim() : null;
}

function lineNotes(
  lineId: string,
  comms: CommentRow[],
): { source: string; literal: string; notes: string } {
  let source = "";
  let literal = "";
  const extra: string[] = [];
  for (const c of comms) {
    if (c.lineId !== lineId) continue;
    const src = prefix(c.body, "Source: ");
    if (src != null) {
      source = src;
      continue;
    }
    const lit = prefix(c.body, "Literal: ");
    if (lit != null) {
      literal = lit;
      continue;
    }
    if (prefix(c.body, "Proofread: ") != null) continue;
    const note = prefix(c.body, "Note: ");
    if (note) extra.push(note);
    else if (c.correction) extra.push(`PR: ${c.body.trim()}`);
    else if (c.body.trim()) extra.push(c.body.trim());
  }
  return { source, literal, notes: extra.join(" · ") };
}

function readingOrder(imgs: ImageRow[], all: LineRow[]): LineRow[] {
  const pageAt = new Map(imgs.map((img, i) => [img.id, i]));
  return [...all].sort((a, b) => {
    const pa = a.imageId ? (pageAt.get(a.imageId) ?? 9999) : 9999;
    const pb = b.imageId ? (pageAt.get(b.imageId) ?? 9999) : 9999;
    if (pa !== pb) return pa - pb;
    return a.sortOrder - b.sortOrder;
  });
}

function scenePages(imgs: ImageRow[], chapterSummary?: string): string {
  const parts: string[] = [];
  if (chapterSummary?.trim()) parts.push(`Chapter setting:\n${chapterSummary.trim()}`);
  for (const [i, img] of imgs.entries()) {
    const note = (img.caption || "").trim();
    if (note) parts.push(`Page ${i + 1}/${imgs.length}\n${note}`);
  }
  return parts.join("\n\n");
}

export function sceneNotesForPage(
  imgs: ImageRow[],
  imageId: string | null | undefined,
  chapterSummary?: string,
): string {
  const idx = imageId ? imgs.findIndex((img) => img.id === imageId) : -1;
  const parts: string[] = [];
  if (chapterSummary?.trim()) parts.push(`Chapter setting:\n${chapterSummary.trim()}`);
  if (idx > 0) {
    const prev = (imgs[idx - 1].caption || "").trim();
    if (prev) parts.push(`Previous page:\n${prev}`);
  }
  if (idx >= 0) {
    const cur = (imgs[idx].caption || "").trim();
    if (cur) parts.push(`This page:\n${cur}`);
  }
  return parts.join("\n\n");
}

async function runModel(
  engine: TranslateEngine,
  items: ProofreadItem[],
  opts: {
    seriesNotes: string;
    seriesGlossary: string;
    prior: string;
    pages: string;
    settled: string;
    abort?: AbortSignal;
    lang?: OcrLang;
    model?: string;
  },
) {
  return runProofreadEnglish(engine, items, opts);
}

export async function loadChapterPack(opts: {
  seriesId: string;
  episodeId: string;
  lang?: OcrLang;
}) {
  const s = await getSeries(opts.seriesId);
  const ep = await getEpisode(opts.episodeId);
  if (!s || !ep) throw new Error("Chapter not found");
  const imgs = await listImages(opts.episodeId);
  const allLines = await listLines(opts.episodeId);
  const comms = await listComments(opts.episodeId);
  const pageLabel = new Map(
    imgs.map((img, i) => [img.id, `page ${i + 1}/${imgs.length}`]),
  );
  const targets: LineRow[] = [];
  const items: ProofreadItem[] = [];
  for (const line of readingOrder(imgs, allLines)) {
    const notes = lineNotes(line.id, comms);
    if (
      line.sourceState === "ignored" ||
      (!line.source && !notes.source && !line.body.trim())
    )
      continue;
    targets.push(line);
    items.push({
      i: items.length,
      page: (line.imageId && pageLabel.get(line.imageId)) || "unplaced",
      lineType: line.lineType,
      source: line.source || notes.source,
      literal: notes.literal,
      current: line.body.trim(),
      notes: notes.notes,
    });
  }
  return {
    series: s,
    episode: ep,
    imgs,
    comms,
    targets,
    items,
    pages: scenePages(imgs, preferences(ep.id, s.id).chapterSummary),
    chapterSummary: preferences(ep.id, s.id).chapterSummary,
    seriesNotes: [
      s.notes,
      preferences(ep.id, s.id).aliases,
      preferences(ep.id, s.id).translationPreferences,
    ]
      .filter(Boolean)
      .join("\n"),
    seriesGlossary: glossaryPrompt(s.glossary || [], 80),
    prior: "",
  };
}

export function formatChapterScript(
  items: ProofreadItem[],
  maxChars?: number,
): string {
  const entries = items.map((l) => {
    const bits = [`[${l.i}] (${l.lineType}) ${l.page}`];
    if (l.source) bits.push(`source: ${l.source}`);
    if (l.literal) bits.push(`literal: ${l.literal}`);
    bits.push(`current: ${l.current || "(empty)"}`);
    if (l.notes) bits.push(`notes: ${l.notes}`);
    return bits.join("\n");
  });
  if (!maxChars || maxChars <= 0) return entries.join("\n\n");
  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const next = used ? used + 2 + entry.length : entry.length;
    if (kept.length && next > maxChars) {
      const omitted = entries.length - kept.length;
      kept.push(
        `[truncated] ${omitted} line${omitted === 1 ? "" : "s"} omitted. This is not the end of the chapter.`,
      );
      break;
    }
    kept.push(entry);
    used = next;
  }
  return kept.join("\n\n");
}

export async function proofreadChapter(opts: {
  seriesId: string;
  episodeId: string;
  engine: TranslateEngine;
  model?: string;
  lang?: OcrLang;
  abort?: AbortSignal;
  imageIds?: string[];
  onPage?: (id: string, state: string, error?: string) => void;
  onProgress?: (p: ProofreadProgress) => void;
}): Promise<{ changed: number; total: number }> {
  const pack = await loadChapterPack(opts);
  const { targets, items, comms, imgs } = pack;
  if (!items.length)
    throw new Error("No translations to proofread. Run AI translate first.");

  const groups = new Map<string, ProofreadItem[]>();
  for (const item of items) {
    const pageId = targets[item.i].imageId || "unplaced";
    if (opts.imageIds && !opts.imageIds.includes(pageId)) continue;
    groups.set(pageId, [...(groups.get(pageId) || []), item]);
  }
  let changed = 0;
  const total = [...groups.values()].reduce((count, group) => count + group.length, 0);
  let pageIndex = 0;
  const failures: string[] = [];
  for (const [pageId, pageItems] of groups) {
    if (opts.abort?.aborted) throw new Error("Cancelled");
    pageIndex += 1;
    const pageIdx = imgs.findIndex((img) => img.id === pageId);
    const prevId = pageIdx > 0 ? imgs[pageIdx - 1].id : "";
    const settled = items
      .filter((l) => (targets[l.i].imageId || "unplaced") === prevId)
      .map((l) => `[${l.i}] (${l.lineType}) ${l.current}`)
      .join("\n");
    const ctx = {
      seriesNotes: pack.seriesNotes,
      seriesGlossary: pack.seriesGlossary,
      prior: pack.prior,
      pages: sceneNotesForPage(imgs, pageId, pack.chapterSummary),
      abort: opts.abort,
      lang: opts.lang,
      model: opts.model,
    };
    try {
      for (let start = 0; start < pageItems.length; start += CHUNK) {
        const slice = pageItems.slice(start, start + CHUNK);
        opts.onProgress?.({
          message: `Proofreading page ${pageIndex}/${groups.size}, lines ${start + 1}–${start + slice.length}`,
          imageIndex: pageIndex,
          imageCount: groups.size,
        });
        const hits = await runModel(opts.engine, slice, { ...ctx, settled });
        for (const item of slice) {
          if (opts.abort?.aborted) throw new Error("Cancelled");
          const hit = hits.get(item.i);
          const next = (hit?.translation || "").trim();
          if (!next || next === item.current) continue;
          await applyLine(
            opts.episodeId,
            targets[item.i],
            next,
            `Proofreading model · ${liveAssistantName(opts.engine, opts.model)}: ${hit?.reasoning || ""}`,
            comms,
          );
          changed += 1;
        }
      }
      opts.onPage?.(pageId, "completed");
    } catch (e) {
      if (opts.abort?.aborted) throw e;
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${pageId}: ${message}`);
      opts.onPage?.(pageId, "failed", message);
    }
  }
  if (failures.length)
    throw new Error(
      `Proofreading failed on ${failures.length} page(s): ${failures.join("; ")}`,
    );
  return { changed, total };
}

async function applyLine(
  episodeId: string,
  line: LineRow,
  body: string,
  reasoning: string,
  comms: CommentRow[],
) {
  suggest(episodeId, line.id, line.revision ?? 0, body, reasoning, "proofread");
}
