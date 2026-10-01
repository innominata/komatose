import { eq } from "drizzle-orm";
import { acceptGlossaryTerm, parseGlossary, serializeGlossary } from "../glossary";
import type { GlossaryTerm } from "../types";
import { db } from "./db";
import { episodes, series } from "./db/schema";
import { now } from "./ids";
import { broadcast } from "./realtime";

export function persistSeriesGlossary(seriesId: string, terms: GlossaryTerm[]) {
  const glossary = serializeGlossary(terms);
  db.update(series)
    .set({ glossary, updatedAt: now() })
    .where(eq(series.id, seriesId))
    .run();
  const eps = db.select({ id: episodes.id }).from(episodes).where(eq(episodes.seriesId, seriesId)).all();
  for (const ep of eps) broadcast(ep.id, { type: "glossary:series", glossary: terms });
  return terms;
}

export function currentSeriesGlossary(seriesId: string): GlossaryTerm[] {
  const row = db.select({ glossary: series.glossary }).from(series).where(eq(series.id, seriesId)).get();
  return parseGlossary(row?.glossary);
}

export function addAcceptedSeriesTerms(
  seriesId: string,
  incoming: { source: string; translation: string }[],
): GlossaryTerm[] {
  let terms = currentSeriesGlossary(seriesId);
  let changed = false;
  for (const term of incoming) {
    const next = acceptGlossaryTerm(terms, term.source, term.translation);
    if (next.changed) {
      terms = next.terms;
      changed = true;
    }
  }
  return changed ? persistSeriesGlossary(seriesId, terms) : terms;
}
