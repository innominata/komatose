import { maskInputs, currentMaskDiagnostics } from "../maskDiagnostics";
import { isSourceSuggestion } from "../regionAi";
import { automaticRegionPolygon, bubbleFitPoints } from "../regionGeometry";
import { contrastingText } from "./textContrast";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { db, sqlite } from "./db";
import { lines, images, episodes } from "./db/schema";
import { listImages, listLines, listComments, toLine, toImage, getEpisodePreviewToken } from "./queries";
import { ensureOriginal, readWorkingOrOrig } from "./storage";
import {
  assetPath,
  getDoc,
  putDoc,
  previousSavedArtwork,
  readAsset,
  rejectPendingSuggestions,
  storeAsset,
  WorkflowError,
} from "./workflowStore";
import {
  DEFAULT_PREFERENCES,
  isBlankRegion,
  isIgnoredLine,
  DEFAULT_STYLE,
  pickStyle,
  styleKeys,
  PAGE_STEPS,
  pageStepLabel,
  pageStepStamp,
  type PageData,
  type RegionData,
  type Preferences,
  type ReadinessIssue,
  type TextStyle,
} from "../workflow";
import { glossaryMismatches } from "../glossary";
import { activeRegionKinds, isBuiltinRegionKind, normalizeRegionKinds, type RegionKind } from "../regionCatalog";
import { LINE_TYPES } from "../types";
import { isCreditsPage } from "../credits";
import type { Episode, Series, ImageRow, LineRow } from "../types";
import { fitText, layoutKey, listFonts, validateStyle, regionPolygon } from "./typesetting";
import { cleaningDeviceLabel, localOperation } from "./localWorker";
import { detectorDefaults, resolveDetector } from "./detectorConfig";
import { gpuClientStatus } from "./gpuMode";
import { broadcast } from "./realtime";
import { storePageThumbnail } from "./pageThumbnail";

export function removePageRegions(episodeId: string, imageId: string): string[] {
  const ids = sqlite.transaction(() => {
    const rows = sqlite
      .prepare("SELECT id FROM lines WHERE episode_id=? AND image_id=?")
      .all(episodeId, imageId) as { id: string }[];
    if (rows.length)
      sqlite.prepare("DELETE FROM lines WHERE episode_id=? AND image_id=?").run(episodeId, imageId);
    return rows.map((row) => row.id);
  })();
  for (const id of ids) broadcast(episodeId, { type: "line:delete", id });
  return ids;
}

export function removeBlankRegions(episodeId: string): string[] {
  const ids = sqlite.transaction(() => {
    const candidates = db.select().from(lines).where(eq(lines.episodeId, episodeId)).all();
    const pendingSource = new Set((sqlite.prepare("SELECT DISTINCT line_id FROM suggestions WHERE episode_id=? AND state='pending' AND kind IN ('source-review','source-enquiry')")
      .all(episodeId) as { line_id: string }[]).map(s => s.line_id));
    const blank = candidates.filter(line => isBlankRegion(line) && !pendingSource.has(line.id));
    const remove = sqlite.prepare("DELETE FROM lines WHERE id=? AND episode_id=?");
    for (const line of blank) remove.run(line.id, episodeId);
    return blank.map((line) => line.id);
  })();
  for (const id of ids) broadcast(episodeId, { type: "line:delete", id });
  return ids;
}

export function approveAllGeometry(episodeId: string): number {
  return sqlite.transaction(() => {
    const candidates = db
      .select({ id: lines.id, sourceState: lines.sourceState, ignoreReason: lines.ignoreReason })
      .from(lines)
      .innerJoin(images, eq(lines.imageId, images.id))
      .where(and(eq(lines.episodeId, episodeId), eq(images.episodeId, episodeId)))
      .all();
    let approved = 0;
    for (const line of candidates) {
      if (isIgnoredLine(line)) continue;
      const doc = getDoc<RegionData>(`region:${line.id}`, {});
      if (doc.data.geometryApproved) continue;
      putDoc(episodeId, doc.id, { ...doc.data, geometryApproved: true }, doc.revision);
      approved += 1;
    }
    return approved;
  })();
}

export function approveAllTranslations(episodeId: string, userId: string): number {
  const ids = sqlite.transaction(() => {
    const candidates = db.select().from(lines).where(eq(lines.episodeId, episodeId)).all();
    const approved: string[] = [];
    const t = Date.now();
    for (const line of candidates) {
      if (isIgnoredLine(line)) continue;
      if (line.status === "approved") continue;
      if (!line.body.trim()) continue;
      sqlite
        .prepare(
          "UPDATE lines SET status='approved', updated_by=?, updated_at=? WHERE id=? AND episode_id=?",
        )
        .run(userId, t, line.id, episodeId);
      rejectPendingSuggestions(episodeId, line.id);
      approved.push(line.id);
    }
    return approved;
  })();
  for (const id of ids) {
    const updated = db.select().from(lines).where(eq(lines.id, id)).get();
    if (updated) broadcast(episodeId, { type: "line:upsert", line: toLine(updated) });
  }
  return ids.length;
}

export function keepCurrentLayouts(episodeId: string): number {
  return sqlite.transaction(() => {
    const episode = db.select().from(episodes).where(eq(episodes.id, episodeId)).get();
    if (!episode) return 0;
    const prefs = preferences(episodeId, episode.seriesId);
    const imgs = db
      .select()
      .from(images)
      .where(eq(images.episodeId, episodeId))
      .all()
      .map(toImage);
    let kept = 0;
    for (const img of imgs) {
      const page = getDoc<PageData>(`page:${img.id}`, {}).data;
      const pageLines = db
        .select()
        .from(lines)
        .where(and(eq(lines.episodeId, episodeId), eq(lines.imageId, img.id)))
        .all()
        .map(toLine);
      for (const line of pageLines) {
        if (isIgnoredLine(line)) continue;
        const doc = getDoc<RegionData>(`region:${line.id}`, {});
        const layout = doc.data.layout;
        if (!layout) continue;
        const style = resolveStyle(line, doc.data, episodeId, episode.seriesId);
        const key = layoutKey(
          line,
          doc.data,
          img,
          style,
          effectiveDpi(page, img, prefs),
        );
        if (layout.key === key) continue;
        putDoc(
          episodeId,
          doc.id,
          { ...doc.data, layout: { ...layout, key } },
          doc.revision,
        );
        kept += 1;
      }
    }
    return kept;
  })();
}

export function preferences(episodeId: string, seriesId: string): Preferences {
  const s = getDoc<Partial<Preferences>>(`series:${seriesId}`, {}).data;
  const c = getDoc<Partial<Preferences>>(`chapter:${episodeId}`, {}).data;
  return {
    ...DEFAULT_PREFERENCES,
    ...s,
    ...c,
    regionAi: s.regionAi ?? c.regionAi,
    regionKinds: s.regionKinds,
    style: { ...s.style },
    styles: Object.fromEntries(
      styleKeys({ regionKinds: s.regionKinds, styles: { ...s.styles, ...c.styles } }).map(
        (key) => [
          key,
          {
            ...s.style,
            ...s.styles?.[key],
            ...c.styles?.[key],
          },
        ],
      ),
    ),
  };
}
export function resolveStyle(
  line: LineRow,
  region: RegionData,
  episodeId: string,
  seriesId: string,
): TextStyle {
  const s = getDoc<Partial<Preferences>>(`series:${seriesId}`, {}).data;
  const c = getDoc<Partial<Preferences>>(`chapter:${episodeId}`, {}).data;
  return validateStyle({
    ...DEFAULT_STYLE,
    ...s.style,
    ...s.styles?.[line.lineType],
    ...c.styles?.[line.lineType],
    ...pickStyle(region.style),
  });
}

export function seriesRegionKindIds(seriesId: string): string[] {
  const stored = getDoc<Partial<Preferences>>(`series:${seriesId}`, {}).data.regionKinds;
  return activeRegionKinds(stored).map((kind) => kind.id);
}

/** Built-in types stay valid so existing pages and transcription keep working. Series-added types are valid too. */
export function acceptedRegionKind(seriesId: string, id: string): boolean {
  return isBuiltinRegionKind(id) || seriesRegionKindIds(seriesId).includes(id);
}

export function saveSeriesRegionKinds(
  seriesId: string,
  expectedRevision: number,
  kinds: RegionKind[] | null,
) {
  const current = getDoc<Partial<Preferences>>(`series:${seriesId}`, {});
  const data = { ...current.data };
  if (kinds == null) delete data.regionKinds;
  else data.regionKinds = normalizeRegionKinds(kinds);
  return putDoc(null, current.id, data, expectedRevision);
}

export function saveSeriesTypeSettings(
  seriesId: string,
  expectedRevision: number,
  input: {
    style?: Partial<TextStyle>;
    styles?: Partial<Record<string, Partial<TextStyle>>>;
  },
) {
  const current = getDoc<Partial<Preferences>>(`series:${seriesId}`, {});
  const fonts = new Set(listFonts(seriesId).map((font) => font.id));
  const style = validateStyle({ ...current.data.style, ...pickStyle(input.style) });
  if (style.fontId && !fonts.has(style.fontId))
    throw new WorkflowError("Choose a font available to this series");
  const styles: Preferences["styles"] = { ...current.data.styles };
  const incoming = input.styles ?? {};
  const saved = styles ?? {};
  // Series-added region types are valid keys too; a type that was removed keeps
  // its saved style so existing regions still load it.
  for (const [type, raw] of Object.entries(incoming)) {
    if (!acceptedRegionKind(seriesId, type) && !(type in saved))
      throw new WorkflowError("Invalid text category");
    const merged = validateStyle({
      ...style,
      ...(styles[type] ?? {}),
      ...pickStyle(raw),
    });
    if (merged.fontId && !fonts.has(merged.fontId))
      throw new WorkflowError("Choose a font available to this series");
    styles[type] = merged;
  }
  // Keep every built-in type materialized, as before.
  for (const type of LINE_TYPES) {
    if (type in incoming || styles[type]) continue;
    const merged = validateStyle({
      ...style,
      ...(styles[type] ?? {}),
    });
    if (merged.fontId && !fonts.has(merged.fontId))
      throw new WorkflowError("Choose a font available to this series");
    styles[type] = merged;
  }
  return putDoc(
    null,
    current.id,
    { ...current.data, style, styles },
    expectedRevision,
  );
}

export function saveSeriesRegionAi(
  seriesId: string,
  expectedRevision: number,
  regionAi: NonNullable<Preferences["regionAi"]>,
) {
  const current = getDoc<Partial<Preferences>>(`series:${seriesId}`, {});
  return putDoc(null, current.id, { ...current.data, regionAi }, expectedRevision);
}

export function resetRegionStyles(
  episodeId: string,
  opts: { imageId?: string; clearChapter?: boolean } = {},
) {
  const rows = sqlite
    .prepare(
      "SELECT id,image_id FROM lines WHERE episode_id=? AND source_state!='ignored'",
    )
    .all(episodeId) as { id: string; image_id: string | null }[];
  let cleared = 0;
  let locked = 0;
  for (const row of rows) {
    if (opts.imageId && row.image_id !== opts.imageId) continue;
    const doc = getDoc<RegionData>(`region:${row.id}`, {});
    if (doc.data.locked) {
      locked += 1;
      continue;
    }
    if (!doc.data.style || !Object.keys(doc.data.style).length) continue;
    putDoc(episodeId, doc.id, { ...doc.data, style: undefined }, doc.revision);
    cleared += 1;
  }
  let chapterCleared = false;
  if (opts.clearChapter) {
    const chapter = getDoc<Partial<Preferences>>(`chapter:${episodeId}`, {});
    if (chapter.data.styles && Object.keys(chapter.data.styles).length) {
      putDoc(
        episodeId,
        chapter.id,
        { ...chapter.data, styles: {} },
        chapter.revision,
      );
      chapterCleared = true;
    }
  }
  return { cleared, locked, chapterCleared };
}
export function applyCleaning(
  episodeId: string,
  imageId: string,
  expectedRevision: number,
) {
  const doc = getDoc<PageData>(`page:${imageId}`, {});
  if (!doc.data.cleaned)
    throw new WorkflowError("Run cleaning before applying a pass");
  return putDoc(
    episodeId,
    doc.id,
    {
      ...doc.data,
      cleanBase: doc.data.cleaned,
      cleaned: undefined,
      mask: undefined,
      strokes: undefined,
      expansion: undefined,
      maskApproved: false,
      cleanApproved: false,
      cleanMethod: undefined,
      backend: undefined,
    },
    expectedRevision,
  );
}

export async function ensurePageThumbnail(
  series: Series,
  episode: Episode,
  img: ImageRow,
) {
  const doc = getDoc<PageData>(`page:${img.id}`, {});
  if (doc.data.thumbnail && doc.data.thumbnailAt === img.updatedAt) return doc;
  const working = await readWorkingOrOrig(
    series.slug,
    episode.slug,
    img.filename,
  );
  if (!working) return doc;
  const thumbnail = await storePageThumbnail(working);
  return putDoc(
    episode.id,
    doc.id,
    { ...doc.data, thumbnail, thumbnailAt: img.updatedAt },
    doc.revision,
  );
}

export async function preparePage(
  series: Series,
  episode: Episode,
  img: ImageRow,
) {
  const doc = getDoc<PageData>(`page:${img.id}`, {});
  if (doc.data.prepared && doc.data.preparedAt === img.updatedAt) {
    if (doc.data.thumbnail && doc.data.thumbnailAt === img.updatedAt) return doc;
    const thumbnail = await storePageThumbnail(
      await readAsset(doc.data.prepared),
    );
    return putDoc(
      episode.id,
      doc.id,
      { ...doc.data, thumbnail, thumbnailAt: img.updatedAt },
      doc.revision,
    );
  }
  const original = await ensureOriginal(
    series.slug,
    episode.slug,
    img.filename,
  );
  const working = await readWorkingOrOrig(
    series.slug,
    episode.slug,
    img.filename,
  );
  if (!working)
    throw new WorkflowError(`Missing source: ${img.originalName}`, 404);
  const meta = await sharp(working).metadata();
  const preparedPng = await sharp(working).png().toBuffer();
  const [prepared, orig, thumbnail] = await Promise.all([
    storeAsset(preparedPng),
    storeAsset(
      await sharp(await readFile(original))
        .png()
        .toBuffer(),
    ),
    storePageThumbnail(preparedPng),
  ]);
  const current = await db
    .select()
    .from(images)
    .where(eq(images.id, img.id))
    .get();
  if (!current || current.updatedAt !== img.updatedAt)
    throw new WorkflowError("Page changed during preparation. Retry.", 409);
  return putDoc(
    episode.id,
    doc.id,
    {
      prepared,
      original: orig,
      thumbnail,
      thumbnailAt: img.updatedAt,
      preparedAt: img.updatedAt,
      dpi:
        doc.data.dpi ??
        (meta.density && meta.density >= 10 && meta.density <= 2400
          ? meta.density
          : (img.dpi ?? 72)),
      cleanApproved: false,
      maskApproved: false,
    },
    doc.revision,
  );
}
export function effectiveDpi(
  page: PageData,
  img: ImageRow,
  prefs: Preferences,
) {
  return prefs.dpi ?? page.dpi ?? img.dpi ?? 72;
}
export function readiness(
  series: Series,
  episode: Episode,
  imgs: ImageRow[],
  lns: LineRow[],
): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  const pageLabel = (img: ImageRow) =>
    img.pageNumber != null ? `Page ${img.pageNumber}` : `Page ${imgs.findIndex((row) => row.id === img.id) + 1}`;
  const regionLabel = (img: ImageRow, line: LineRow, pageLines: LineRow[]) => {
    const index = pageLines.findIndex((row) => row.id === line.id);
    return `${pageLabel(img)} · region ${index >= 0 ? index + 1 : line.sortOrder + 1}`;
  };
  const current = sqlite
    .prepare("SELECT numbering_stale FROM episodes WHERE id=?")
    .get(episode.id) as { numbering_stale: number };
  if (!imgs.length)
    issues.push({ code: "empty", message: "Upload pages first" });
  if (current.numbering_stale || imgs.some((p, i) => p.pageNumber !== i + 1))
    issues.push({
      code: "numbering",
      message: "Renumber pages in chapter order",
    });
  if (series.credits?.pre && !imgs.some((img) => img.role === "pre-credits"))
    issues.push({
      code: "credits",
      severity: "warning",
      message: "Chapter is missing the series pre-credits page",
    });
  if (series.credits?.post && !imgs.some((img) => img.role === "post-credits"))
    issues.push({
      code: "credits",
      severity: "warning",
      message: "Chapter is missing the series post-credits page",
    });
  const prefs = preferences(episode.id, series.id);
  const comments = sqlite
    .prepare(
      `SELECT comments.id, comments.line_id AS lineId, comments.body, comments.correction
       FROM comments JOIN lines ON lines.id=comments.line_id WHERE lines.episode_id=?`,
    )
    .all(episode.id) as { id: string; lineId: string; body: string; correction: number }[];
  const fonts = new Set(
    listFonts(series.id)
      .filter((f) => existsSync(assetPath(f.hash)))
      .map((f) => f.id),
  );
  for (const img of imgs) {
    const p = getDoc<PageData>(`page:${img.id}`, {}).data;
    const pageLines = lns.filter((l) => l.imageId === img.id);
    const live = pageLines.filter((l) => !isIgnoredLine(l));
    if (!pageLines.length && !isCreditsPage(img))
      issues.push({
        code: "regions",
        imageId: img.id,
        pageLabel: pageLabel(img),
        message:
          "No reviewed regions; add an ignore region for a page without text",
      });
    if (live.length && (!p.prepared || p.preparedAt !== img.updatedAt))
      issues.push({
        code: "prepared",
        imageId: img.id,
        pageLabel: pageLabel(img),
        message: "Prepared source changed; prepare this page again",
      });
    if (live.length && !p.cleanApproved)
      issues.push({
        code: "cleaning",
        imageId: img.id,
        pageLabel: pageLabel(img),
        message:
          "Review and approve cleaning (or explicitly approve source without cleaning)",
      });
    for (const line of live) {
      const add = (code: string, message: string) =>
        issues.push({
          code,
          message,
          imageId: img.id,
          lineId: line.id,
          pageLabel: pageLabel(img),
          regionLabel: regionLabel(img, line, live),
        });
      if (!line.source?.trim() || line.sourceState !== "read")
        add("source", "Review unreadable source");
      if (!line.body.trim())
        add("translation", "English translation is missing");
      if (line.status !== "approved")
        add("review", "Approve the English translation");
      const region = getDoc<RegionData>(`region:${line.id}`, {}).data;
      if (!region.geometryApproved)
        add("geometry", "Approve the bubble interior or text box");
      const style = resolveStyle(line, region, episode.id, series.id);
      if (!fonts.has(style.fontId)) {
        add("font", "Select an uploaded font");
        continue;
      }
      const layout = region.layout;
      if (!layout) add("layout", "Fit this text");
      else {
        if (
          layout.key !==
          layoutKey(line, region, img, style, effectiveDpi(p, img, prefs))
        )
          add(
            "stale",
            region.locked
              ? "Locked layout is stale; unlock and refit"
              : "Text layout is stale; refit",
          );
        if (layout.overflow)
          add("overflow", "Text does not fit at minimum size");
        if (layout.missingGlyphs.length)
          add("glyphs", `Font lacks: ${layout.missingGlyphs.join(" ")}`);
      }
    }
    const regions = pageLines.map((line) => ({
      id: line.id,
      data: getDoc<RegionData>(`region:${line.id}`, {}).data,
    }));
    const pageComments = comments.filter((comment) => pageLines.some((line) => line.id === comment.lineId));
    for (const step of PAGE_STEPS) {
      const stamp = pageStepStamp(
        step,
        p,
        pageLines,
        pageComments.map((comment) => ({ ...comment, correction: !!comment.correction })),
        regions,
      );
      if (p.completed?.[step] !== stamp)
        issues.push({
          code: "step-complete",
          imageId: img.id,
          pageLabel: pageLabel(img),
          message: `Mark this page complete in ${pageStepLabel(step)}`,
        });
    }
  }
  for (const line of lns.filter((l) => !l.imageId && !isIgnoredLine(l)))
    issues.push({
      code: "unplaced",
      lineId: line.id,
      message: "Assign this region to a page",
    });
  for (const line of lns.filter((l) => !isIgnoredLine(l))) {
    for (const term of glossaryMismatches(line.source || "", line.body, series.glossary || [])) {
      const img = imgs.find((row) => row.id === line.imageId);
      const pageLines = img ? lns.filter((row) => row.imageId === img.id && !isIgnoredLine(row)) : [];
      issues.push({
        code: "glossary",
        lineId: line.id,
        imageId: line.imageId ?? undefined,
        pageLabel: img ? pageLabel(img) : undefined,
        regionLabel: img ? regionLabel(img, line, pageLines) : undefined,
        severity: "warning",
        message: `Series term “${term.source}” should stay “${term.translation}”`,
      });
    }
  }
  return issues;
}
export async function workflowState(series: Series, episode: Episode) {
  const imgs = await listImages(episode.id);
  const lns = await listLines(episode.id);
  return {
    images: imgs,
    comments: await listComments(episode.id),
    lines: lns,
    chapter: getDoc<Partial<Preferences>>(`chapter:${episode.id}`, {}),
    seriesDefaults: getDoc<Partial<Preferences>>(`series:${series.id}`, {}),
    preferences: preferences(episode.id, series.id),
    pages: Object.fromEntries(
      imgs.map((i) => {
        const doc = getDoc<PageData>(`page:${i.id}`, {});
        return [i.id, { ...doc, data: { ...doc.data,
          maskDiagnostics: currentMaskDiagnostics(doc.data, JSON.stringify(maskInputs(
            lns.filter(l => l.imageId === i.id), id => getDoc<RegionData>(`region:${id}`, {}),
          ))), previousArtwork: previousSavedArtwork(doc.id, doc.data) } }];
      }),
    ),
    regions: Object.fromEntries(
      lns.map((l) => [l.id, getDoc<RegionData>(`region:${l.id}`, {})]),
    ),
    fonts: listFonts(series.id),
    suggestions: sqlite
      .prepare(
        "SELECT * FROM suggestions WHERE episode_id=? ORDER BY created_at DESC",
      )
      .all(episode.id),
    issues: await readiness(series, episode, imgs, lns),
    previewToken: await getEpisodePreviewToken(episode.id),
    gpu: gpuClientStatus(cleaningDeviceLabel()),
    credits: series.credits ?? {},
    /** What "use the default" means in Chapter Settings, and which setups can run here. */
    detectorDefaults: detectorDefaults(),
    /** What Transcribe chapter would run now, after missing add-ons are dropped. */
    detection: resolveDetector(episode.id),
  };
}
export async function fitRegion(
  series: Series,
  episode: Episode,
  id: string,
  expected: number,
  opts: { resetStyle?: boolean; style?: Partial<TextStyle> } = {},
) {
  const line = (await listLines(episode.id)).find((l) => l.id === id);
  if (!line) throw new WorkflowError("Region not found", 404);
  const img = (await listImages(episode.id)).find((i) => i.id === line.imageId);
  if (!img) throw new WorkflowError("Assign a page before fitting");
  const doc = getDoc<RegionData>(`region:${id}`, {});
  if (doc.revision !== expected)
    throw new WorkflowError("Geometry changed; refresh before fitting", 409);
  if (doc.data.locked)
    throw new WorkflowError("Unlock this layout before fitting");
  const p = getDoc<PageData>(`page:${img.id}`, {}).data;
  let data = { ...doc.data };
  if (opts.resetStyle) delete data.style;
  if (opts.style !== undefined) data.style = pickStyle(opts.style);
  const style = resolveStyle(line, data, episode.id, series.id);
  if (style.autoContrast !== false) {
    const background = p.cleaned || p.cleanBase || p.prepared;
    const bytes = background ? await readAsset(background) : await readWorkingOrOrig(series.slug, episode.slug, img.filename);
    if (!bytes) throw new WorkflowError("Page image is missing");
    const polygon = regionPolygon(line, data, img).map(p => ({ x: p.x / img.width, y: p.y / img.height }));
    style.fill = await contrastingText(bytes, polygon);
    style.outline = style.fill === "#000000" ? "#ffffff" : "#000000";
    data = { ...data, style: { ...data.style, fill: style.fill, outline: style.outline } };
  }
  if (!listFonts(series.id).some((f) => f.id === style.fontId))
    throw new WorkflowError("Font does not belong to this series");
  const layout = await fitText(
    line,
    data,
    img,
    style,
    effectiveDpi(p, img, preferences(episode.id, series.id)),
  );
  const latest = (await listLines(episode.id)).find((l) => l.id === id);
  if (latest?.revision !== line.revision)
    throw new WorkflowError("Text changed during fitting; retry", 409);
  return putDoc(episode.id, doc.id, { ...data, layout }, doc.revision);
}
export function renumberPages(episodeId: string) {
  sqlite.transaction(() => {
    const pages = sqlite
      .prepare(
        "SELECT id FROM images WHERE episode_id=? ORDER BY sort_order,created_at,id",
      )
      .all(episodeId) as { id: string }[];
    pages.forEach((p, i) =>
      sqlite
        .prepare("UPDATE images SET page_number=? WHERE id=?")
        .run(i + 1, p.id),
    );
    sqlite
      .prepare(
        "UPDATE episodes SET numbering_stale=0,revision=revision+1 WHERE id=?",
      )
      .run(episodeId);
  })();
  broadcast(episodeId, {
    type: "workflow:changed",
    id: `chapter:${episodeId}`,
    revision: 0,
  });
}
export function acceptSuggestion(
  episodeId: string,
  id: string,
  userId: string,
  decision: string,
  _force = false,
) {
  return sqlite.transaction(() => {
    const suggestion = sqlite
      .prepare("SELECT * FROM suggestions WHERE id=? AND episode_id=?")
      .get(id, episodeId) as
      | { line_id: string; state: string; base_revision: number; body: string; kind: string; translation: string }
      | undefined;
    if (!suggestion) throw new WorkflowError("Suggestion not found", 404);
    if (suggestion.state !== "pending") return;
    const source = isSourceSuggestion(suggestion.kind);
    const paired = suggestion.kind === "source-review" && !!suggestion.translation;
    const previous = db.select().from(lines).where(and(eq(lines.id, suggestion.line_id), eq(lines.episodeId, episodeId))).get();
    if (!previous) throw new WorkflowError("Region not found", 404);
    const sourceChanged = source && previous.source !== suggestion.body;
    const applyPairedEnglish = paired;
    const assignment = source
      ? `source=?,source_state='read',ocr_confidence=NULL${applyPairedEnglish ? ",body=?" : ""}`
      : "body=?";
    const textValues = applyPairedEnglish ? [suggestion.body, suggestion.translation] : [suggestion.body];
    if (decision === "accept") {
      sqlite
        .prepare(
          `UPDATE lines SET ${assignment},status='needs_work',updated_by=?,updated_at=? WHERE id=? AND episode_id=?`,
        )
        .run(
          ...textValues,
          userId,
          Date.now(),
          suggestion.line_id,
          episodeId,
        );
    }
    sqlite
      .prepare("UPDATE suggestions SET state=? WHERE id=?")
      .run(decision === "accept" ? "accepted" : "rejected", id);
    if (decision === "accept")
      sqlite.prepare(`UPDATE suggestions SET state='rejected' WHERE episode_id=? AND line_id=? AND state='pending' AND kind ${source ? "IN" : "NOT IN"} ('source-review','source-enquiry')`)
        .run(episodeId, suggestion.line_id);
    broadcast(episodeId, {
      type: "suggestion:changed",
      lineId: suggestion.line_id,
    });
    if (decision === "accept") {
      const updated = db.select().from(lines).where(eq(lines.id, suggestion.line_id)).get()!;
      broadcast(episodeId, { type: "line:upsert", line: toLine(updated) });
      if (source && sourceChanged && !paired) return { lineId: updated.id, expectedRevision: updated.revision };
    }
  })();
}

export async function typesetRegions(
  series: Series,
  episode: Episode,
  pages: ImageRow[],
  targets: LineRow[],
  signal: AbortSignal,
  progress: (result: {
    completed: number;
    skipped: number;
    total: number;
    errors: string[];
  }) => void,
  operation = localOperation,
) {
  const geometryLines = await listLines(episode.id);
  const errors: string[] = [];
  let completed = 0,
    skipped = 0;
  for (const line of targets) {
    if (signal.aborted) throw new Error("Cancelled");
    await (async () => {
      try {
        let region = getDoc<RegionData>(`region:${line.id}`, {});
        if (region.data.locked) {
          skipped++;
          return;
        }
        const img = pages.find((p) => p.id === line.imageId)!;
        const page = getDoc<PageData>(`page:${img.id}`, {});
        if (!page.data.prepared || page.data.preparedAt !== img.updatedAt)
          throw new Error("Prepare this page first");
        // Check saved interiors too: earlier detections may span connected bubbles.
        {
          const existing = !!region.data.polygon?.length;
          const result = await operation(
            {
              cmd: "geometry",
              path: assetPath(page.data.prepared),
              method: existing ? "split" : "opencv",
              kind: region.data.detectionKind,
              polygon: region.data.polygon,
              box: [line.x, line.y, line.w, line.h],
              points: existing ? undefined : bubbleFitPoints(line),
              neighbors: geometryLines.filter((other) => other.imageId === line.imageId && other.id !== line.id).flatMap((other) => other.x != null && other.y != null && other.w != null && other.h != null ? [[other.x, other.y, other.w, other.h]] : []),
            },
            signal,
          );
          if (signal.aborted) throw new Error("Cancelled");
          const current = (await listImages(episode.id)).find(
            (p) => p.id === img.id,
          );
          const currentLine = (await listLines(episode.id)).find(
            (l) => l.id === line.id,
          );
          if (
            current?.updatedAt !== img.updatedAt ||
            currentLine?.revision !== line.revision
          )
            throw new Error("Page or text changed; retry");
          const found = Array.isArray(result.polygon) && result.polygon.length >= 3;
          const polygon = existing && !result.split ? region.data.polygon :
            automaticRegionPolygon(line, result.polygon);
          if (!existing || result.split) region = putDoc(
            episode.id,
            region.id,
            {
              ...region.data,
              polygon,
              geometryConfidence: found && polygon === result.polygon ? result.confidence : 0,
              geometryApproved: false,
            },
            region.revision,
          );
        }
        await fitRegion(series, episode, line.id, region.revision);
        completed++;
      } catch (e) {
        errors.push(
          `${line.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })();
    progress({
      completed,
      skipped,
      total: targets.length,
      errors: [...errors],
    });
  }
  return { completed, skipped, total: targets.length, errors };
}


export function acceptTranslationSuggestions(episodeId: string, userId: string, imageId?: string, force = false) {
  if (imageId !== undefined && !sqlite.prepare("SELECT id FROM images WHERE id=? AND episode_id=?").get(imageId, episodeId))
    throw new WorkflowError("Page not found", 404);
  return sqlite.transaction(() => {
    const pending = sqlite.prepare(
      "SELECT id,line_id,base_revision FROM suggestions WHERE episode_id=? AND kind='translation' AND state='pending' AND (? IS NULL OR line_id IN (SELECT id FROM lines WHERE image_id=? AND episode_id=?)) ORDER BY created_at DESC,id DESC"
    ).all(episodeId, imageId ?? null, imageId ?? null, episodeId) as { id: string; line_id: string; base_revision: number }[];
    const chosen = new Map<string, { id: string; base_revision: number; revision: number }>();
    for (const suggestion of pending) {
      const current = sqlite.prepare("SELECT revision FROM lines WHERE id=? AND episode_id=?")
        .get(suggestion.line_id, episodeId) as { revision: number } | undefined;
      if (!current) continue;
      const existing = chosen.get(suggestion.line_id);
      if (!existing) {
        chosen.set(suggestion.line_id, { id: suggestion.id, base_revision: suggestion.base_revision, revision: current.revision });
        continue;
      }
      const existingMatch = existing.base_revision === existing.revision;
      const nextMatch = suggestion.base_revision === current.revision;
      if (!existingMatch && nextMatch)
        chosen.set(suggestion.line_id, { id: suggestion.id, base_revision: suggestion.base_revision, revision: current.revision });
    }
    let accepted = 0;
    for (const suggestion of chosen.values()) {
      acceptSuggestion(episodeId, suggestion.id, userId, "accept", force);
      accepted++;
    }
    return { accepted, skipped: pending.length - accepted };
  })();
}
