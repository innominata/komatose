import type { OcrConsensus } from "../ocrConsensus";
import { normalizeTranslation } from "../translationText";
import type { LineRow } from "../types";
import { db, sqlite } from "./db";
import { lines } from "./db/schema";
import { eq } from "drizzle-orm";
import { toLine } from "./queries";
import { broadcast } from "./realtime";
import { applyLonePendingSource, ocrReadingsToSuggest, ocrSuggestionReason } from "./ocrConsensus";
import { ocrTranslatorLabel } from "./ocrReview";
import { suggest } from "./workflowStore";

export type FillMissingSuggestion = { id: string; body: string; lineId: string };

export function regionHasBounds(line: LineRow) {
  return Boolean(
    line.placed &&
      line.imageId &&
      [line.x, line.y, line.w, line.h].every((v) => typeof v === "number" && Number.isFinite(v)) &&
      (line.w ?? 0) > 0 &&
      (line.h ?? 0) > 0,
  );
}

export function needsFillSource(line: LineRow) {
  return line.sourceState !== "ignored" && !(line.source || "").trim() && regionHasBounds(line);
}

export function needsFillEnglish(line: LineRow) {
  return line.sourceState !== "ignored" && !!(line.source || "").trim() && !(line.body || "").trim();
}

export function collectFillMissingWork(episodeId: string, imageId?: string) {
  const rows = db.select().from(lines).where(eq(lines.episodeId, episodeId)).all();
  const scoped = rows.map(toLine).filter((line) => imageId === undefined || line.imageId === imageId);
  const suggestions = sqlite
    .prepare(
      `SELECT s.id, s.body, s.line_id AS lineId FROM suggestions s
       JOIN lines l ON l.id = s.line_id
       WHERE s.episode_id=? AND s.state='pending'
         AND s.kind IN ('source-review','source-enquiry')
         AND TRIM(s.body)!=''
         AND TRIM(COALESCE(s.translation,''))=''
         AND (? IS NULL OR l.image_id=?)`,
    )
    .all(episodeId, imageId ?? null, imageId ?? null) as FillMissingSuggestion[];
  return {
    sourceLines: scoped.filter(needsFillSource),
    englishLines: scoped.filter(needsFillEnglish),
    suggestions,
  };
}

/** Write source only when it is still empty. Never changes English. */
export function saveFillMissingSource(
  episodeId: string,
  line: LineRow,
  result: OcrConsensus,
  translatorLabel = ocrTranslatorLabel(),
) {
  return sqlite.transaction(() => {
    const row = db.select().from(lines).where(eq(lines.id, line.id)).get();
    if (!row || row.episodeId !== episodeId || row.sourceState === "ignored") return;
    if ((row.source || "").trim()) return toLine(row);
    if (result.agreed && result.source.trim()) {
      sqlite
        .prepare(
          `UPDATE lines SET source=?,source_state='read',ocr_confidence=NULL,updated_at=?
           WHERE id=? AND episode_id=? AND source_state!='ignored'
             AND (source IS NULL OR TRIM(source)='')`,
        )
        .run(result.source, Date.now(), row.id, episodeId);
    }
    let saved = toLine(db.select().from(lines).where(eq(lines.id, line.id)).get()!);
    const applied = result.agreed && !!(saved.source || "").trim();
    const readings = ocrReadingsToSuggest(result, applied);
    for (const reading of readings) {
      suggest(
        episodeId,
        saved.id,
        saved.revision ?? 0,
        reading.source,
        ocrSuggestionReason(reading, translatorLabel),
        "source-review",
        reading.translation ?? "",
      );
    }
    if (applyLonePendingSource(episodeId, saved.id))
      saved = toLine(db.select().from(lines).where(eq(lines.id, line.id)).get()!);
    broadcast(episodeId, { type: "line:upsert", line: saved });
    if (readings.length) broadcast(episodeId, { type: "suggestion:changed", lineId: saved.id });
    return saved;
  })();
}

/** Write English only when the region body is still empty. Never changes source. */
export function writeFillMissingEnglish(
  episodeId: string,
  lineId: string,
  body: string,
  updatedBy?: string,
) {
  const translation = normalizeTranslation(body.trim());
  if (!translation) return false;
  const result = sqlite
    .prepare(
      `UPDATE lines SET body=?,status='needs_work',updated_by=?,updated_at=?
       WHERE id=? AND episode_id=? AND source_state!='ignored' AND TRIM(body)=''`,
    )
    .run(translation, updatedBy ?? null, Date.now(), lineId, episodeId);
  if (!result.changes) return false;
  const saved = toLine(db.select().from(lines).where(eq(lines.id, lineId)).get()!);
  broadcast(episodeId, { type: "line:upsert", line: saved });
  return true;
}

/** Write suggestion English only when that field is still empty. */
export function writeFillMissingSuggestionTranslation(
  episodeId: string,
  suggestionId: string,
  translation: string,
) {
  const english = normalizeTranslation(translation.trim());
  if (!english) return false;
  const result = sqlite
    .prepare(
      `UPDATE suggestions SET translation=?
       WHERE id=? AND episode_id=? AND state='pending'
         AND TRIM(COALESCE(translation,''))=''`,
    )
    .run(english, suggestionId, episodeId);
  if (!result.changes) return false;
  const row = sqlite
    .prepare("SELECT line_id FROM suggestions WHERE id=?")
    .get(suggestionId) as { line_id: string } | undefined;
  if (row) broadcast(episodeId, { type: "suggestion:changed", lineId: row.line_id });
  return true;
}
