import type { ImageRow, LineRow } from "./types";
import type { PageData, RegionData, WorkflowDoc } from "./workflow";

export const EXCEPTION_KINDS = ["ocr", "english", "mask", "overflow"] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];
export type ExceptionStep = "Review" | "Clean" | "Typeset";

export type ChapterException = {
  id: string;
  kind: ExceptionKind;
  label: string;
  step: ExceptionStep;
  imageId?: string;
  lineId?: string;
  pageIndex: number;
  regionIndex: number;
  phase: number;
  kindRank: number;
};

export type ExceptionCursor = Pick<
  ChapterException,
  "pageIndex" | "regionIndex" | "phase" | "kindRank"
> & { id?: string };

export type ExceptionSuggestion = {
  line_id: string;
  state: string;
  kind: string;
};

export type ExceptionSource = {
  images: ImageRow[];
  lines: LineRow[];
  pages: Record<string, Pick<WorkflowDoc<PageData>, "data"> | { data: PageData }>;
  regions: Record<string, Pick<WorkflowDoc<RegionData>, "data"> | { data: RegionData }>;
  suggestions: ExceptionSuggestion[];
};

const KIND_META: Record<
  ExceptionKind,
  { label: string; step: ExceptionStep; rank: number; phase: number }
> = {
  ocr: { label: "OCR disagreement", step: "Review", rank: 0, phase: 0 },
  english: { label: "Missing English", step: "Review", rank: 1, phase: 0 },
  mask: { label: "Unapproved mask", step: "Clean", rank: 2, phase: 1 },
  overflow: { label: "Overflow", step: "Typeset", rank: 3, phase: 2 },
};

function item(
  kind: ExceptionKind,
  opts: {
    imageId?: string;
    lineId?: string;
    pageIndex: number;
    regionIndex: number;
    label?: string;
  },
): ChapterException {
  const meta = KIND_META[kind];
  return {
    id: `${kind}:${opts.lineId ?? opts.imageId ?? ""}`,
    kind,
    label: opts.label ?? meta.label,
    step: meta.step,
    imageId: opts.imageId,
    lineId: opts.lineId,
    pageIndex: opts.pageIndex,
    regionIndex: opts.regionIndex,
    phase: meta.phase,
    kindRank: meta.rank,
  };
}

export function compareExceptions(a: ExceptionCursor, b: ExceptionCursor): number {
  return (
    a.phase - b.phase ||
    a.pageIndex - b.pageIndex ||
    a.regionIndex - b.regionIndex ||
    a.kindRank - b.kindRank ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

export function needsTranslationReview(
  line: Pick<LineRow, "sourceState" | "status" | "source" | "body">,
): boolean {
  return (
    line.sourceState !== "ignored" &&
    (line.status !== "approved" || !(line.source || "").trim() || !line.body.trim())
  );
}

export type MissingRegionCopy = "source" | "english" | "both";

export function missingRegionCopy(
  line: Pick<LineRow, "sourceState" | "source" | "body">,
): MissingRegionCopy | null {
  if (line.sourceState === "ignored") return null;
  const noSource = !(line.source || "").trim();
  const noEnglish = !(line.body || "").trim();
  if (noSource && noEnglish) return "both";
  if (noSource) return "source";
  if (noEnglish) return "english";
  return null;
}

export function missingRegionCopyLabel(kind: MissingRegionCopy): string {
  if (kind === "source") return "No source text";
  if (kind === "english") return "No English text";
  return "No source or English text";
}

export function nextTranslationReview<T extends LineRow>(
  lines: T[],
  fromId: string,
): T | undefined {
  const pending = lines.filter((line) => line.id !== fromId && needsTranslationReview(line));
  if (!pending.length) return;
  const idx = lines.findIndex((line) => line.id === fromId);
  return pending.find((line) => lines.findIndex((row) => row.id === line.id) > idx) ?? pending[0];
}

/** Every region on the page is approved or ignored, with source and English where it is read. */
export function pageTranslationsSettled(
  lines: readonly Pick<LineRow, "imageId" | "sourceState" | "status" | "source" | "body">[],
  imageId: string,
): boolean {
  const pageLines = lines.filter((line) => line.imageId === imageId);
  return pageLines.length > 0 && pageLines.every((line) => !needsTranslationReview(line));
}

/** OCR, blank English, and unapproved translations first; then masks; then overflow. */
export function chapterExceptions(src: ExceptionSource): ChapterException[] {
  const pendingSource = new Set(
    src.suggestions
      .filter(
        (suggestion) =>
          suggestion.state === "pending" &&
          (suggestion.kind === "source-review" || suggestion.kind === "source-enquiry"),
      )
      .map((suggestion) => suggestion.line_id),
  );
  const out: ChapterException[] = [];
  src.images.forEach((image, pageIndex) => {
    const pageLines = src.lines
      .filter((line) => line.imageId === image.id && line.sourceState !== "ignored")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const review: ChapterException[] = [];
    const overflow: ChapterException[] = [];
    pageLines.forEach((line) => {
      const regionIndex = line.sortOrder;
      const pending = pendingSource.has(line.id);
      const unreadable = !(line.source || "").trim() || line.sourceState === "unreadable";
      if (pending || unreadable) {
        review.push(
          item("ocr", {
            imageId: image.id,
            lineId: line.id,
            pageIndex,
            regionIndex,
            label: pending ? "OCR disagreement" : "Unreadable source",
          }),
        );
      }
      const hasSource = !!(line.source || "").trim();
      if (hasSource && !line.body.trim()) {
        review.push(item("english", { imageId: image.id, lineId: line.id, pageIndex, regionIndex }));
      } else if (hasSource && line.status !== "approved") {
        review.push(
          item("english", {
            imageId: image.id,
            lineId: line.id,
            pageIndex,
            regionIndex,
            label: "Needs review",
          }),
        );
      }
      if (src.regions[line.id]?.data.layout?.overflow) {
        overflow.push(item("overflow", { imageId: image.id, lineId: line.id, pageIndex, regionIndex }));
      }
    });
    out.push(...review);
    const page = src.pages[image.id]?.data;
    if (page?.mask && !page.maskApproved) {
      out.push(
        item("mask", {
          imageId: image.id,
          pageIndex,
          regionIndex: Number.MAX_SAFE_INTEGER,
        }),
      );
    }
    out.push(...overflow);
  });
  return out.sort(compareExceptions);
}

export function nextException(
  list: ChapterException[],
  from?: ExceptionCursor | null,
): ChapterException | undefined {
  if (!list.length) return;
  if (!from) return list[0];
  let after: ChapterException | undefined;
  for (const item of list) {
    if (compareExceptions(item, from) <= 0) continue;
    if (!after || compareExceptions(item, after) < 0) after = item;
  }
  if (after) return after;
  if (from.id && list[0].id === from.id) return;
  return list[0];
}

export function exceptionCursorFromView(opts: {
  images: ImageRow[];
  pageId?: string;
  selected?: Pick<LineRow, "id" | "sortOrder">;
  step: string;
}): ExceptionCursor {
  const pageIndex = opts.pageId ? opts.images.findIndex((image) => image.id === opts.pageId) : -1;
  const phase = opts.step === "Clean" ? 1 : opts.step === "Typeset" ? 2 : 0;
  return {
    pageIndex,
    regionIndex: opts.selected?.sortOrder ?? -1,
    phase,
    kindRank: -1,
    id: opts.selected ? `cursor:${opts.selected.id}` : undefined,
  };
}
