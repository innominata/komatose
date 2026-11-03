/** Lossless page boundaries. Rasters and edit histories are projected separately. */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { sqlite } from "./db";
import type { ImageRow, LineRow } from "../types";
import type { PageData, RegionData } from "../workflow";
import type { CleanFinish } from "../postprocess";
import { cleaningFinishes } from "../postprocess";
import {
  getDoc,
  hash,
  readAsset,
  storeAsset,
  WorkflowError,
} from "./workflowStore";
import { listImages, listLines } from "./queries";
import {
  transformRaster,
  transformRegion,
  type PixelTransform,
} from "./pageGeometry";
import { layoutKey } from "./typesetting";
import {
  readWorkingOrOrig,
  saveImageFile,
  origImagePath,
  removeImageFile,
} from "./storage";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { imagePath } from "./storage";
import { maskRegion } from "../maskRegions";
import { storePageThumbnail } from "./pageThumbnail";
import { pushUndo, popUndo } from "./pageUndo";
import { broadcast } from "./realtime";
import { isCreditsPage } from "../credits";
import {
  protectedResliceRanges,
  currentReslicePolygon,
  sourceHasStalePolygonFrame,
  type ResliceWork,
} from "./resliceWork";
import type { PageEditCtx } from "./reslice";
import { pageEditLocks as locks } from "./pageEditLock";

export type Rect = { x: number; y: number; width: number; height: number };
export type Placement = { imageId: string; rect: Rect; x: number; y: number };
export type ReframeOutput = {
  id: string;
  width: number;
  height: number;
  placements: Placement[];
  originalName?: string;
};
export type SavedDoc = {
  id: string;
  revision: number;
  data: any;
  undo: any[];
  redo: any[];
};
type Source = {
  image: ImageRow;
  doc: SavedDoc;
  raw: Buffer;
  frameId: string;
  regions: { line: LineRow; doc: SavedDoc }[];
};
export type ReframeCapture = {
  sources: Source[];
  order: ImageRow[];
  token: string;
};
export type ReframeUndo = {
  type: "reframe";
  description: string;
  previous: ImageRow[];
  created: ImageRow[];
  docs: SavedDoc[];
  lines: LineRow[];
  order: { id: string; sortOrder: number }[];
  expectedDocs: Record<string, string>;
  expectedLines: Record<string, string>;
  reviews: { id: string; before: unknown; after: unknown }[];
  frameIds?: string[];
  originalFiles?: string[];
};
export const isReframeRunning = (episodeId: string): boolean =>
  locks.has(episodeId);
export const savedCleaningFinishes = cleaningFinishes;
export function storedDoc(id: string): SavedDoc {
  const row = sqlite
    .prepare("SELECT id,revision,data,undo,redo FROM workflow_docs WHERE id=?")
    .get(id) as any;
  return row
    ? {
        id,
        revision: row.revision,
        data: JSON.parse(row.data),
        undo: JSON.parse(row.undo),
        redo: JSON.parse(row.redo),
      }
    : { id, revision: 0, data: {}, undo: [], redo: [] };
}
const docSignature = (d: SavedDoc) =>
  hash(JSON.stringify([d.data, d.undo, d.redo]));
const lineSignature = (line: LineRow) =>
  hash(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(line).filter(
          ([k]) => !["revision", "updatedAt"].includes(k),
        ),
      ),
    ),
  );
function writeDoc(episodeId: string, doc: SavedDoc) {
  const revision = getDoc(doc.id, {}).revision + 1;
  sqlite
    .prepare(
      `INSERT INTO workflow_docs(id,episode_id,revision,data,undo,redo,updated_at) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data,undo=excluded.undo,redo=excluded.redo,updated_at=excluded.updated_at`,
    )
    .run(
      doc.id,
      episodeId,
      revision,
      JSON.stringify(doc.data),
      JSON.stringify(doc.undo),
      JSON.stringify(doc.redo),
      Date.now(),
    );
  sqlite
    .prepare(
      "INSERT INTO workflow_revisions(episode_id,entity_id,revision,data,created_at) VALUES(?,?,?,?,?)",
    )
    .run(episodeId, doc.id, revision, JSON.stringify(doc.data), Date.now());
}
export async function captureReframe(
  ctx: PageEditCtx,
  ids: string[],
): Promise<ReframeCapture> {
  const order = await listImages(ctx.episode.id),
    lines = await listLines(ctx.episode.id);
  const selected = order.filter((i) => ids.includes(i.id));
  if (
    selected.length !== ids.length ||
    !selected.length ||
    selected.some(isCreditsPage)
  )
    throw new WorkflowError("Choose existing story pages");
  const sources: Source[] = [];
  for (const image of selected) {
    const doc = storedDoc(`page:${image.id}`);
    const raw = doc.data.prepared
      ? await readAsset(doc.data.prepared)
      : await readWorkingOrOrig(
          ctx.series.slug,
          ctx.episode.slug,
          image.filename,
        );
    if (!raw)
      throw new WorkflowError(`Missing source artwork: ${image.originalName}`);
    const meta = await sharp(raw).metadata();
    if (meta.width !== image.width || meta.height !== image.height)
      throw new WorkflowError(
        "Source dimensions changed; repair the page before changing its boundaries",
      );
    sources.push({
      image,
      doc,
      raw,
      frameId:
        doc.data.geometryFrameId ?? `legacy:${image.id}:${image.updatedAt}`,
      regions: lines
        .filter((l) => l.imageId === image.id)
        .map((line) => ({ line, doc: storedDoc(`region:${line.id}`) })),
    });
  }
  const token = hash(
    JSON.stringify({
      order: order.map((i) => [i.id, i.sortOrder]),
      sources: sources.map((s) => [s.image, s.doc, s.regions]),
    }),
  );
  return { sources, order, token };
}
function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : undefined;
}
function transform(p: Placement, out: ReframeOutput): PixelTransform {
  return {
    sx: 1,
    sy: 1,
    dx: p.x - p.rect.x,
    dy: p.y - p.rect.y,
    width: out.width,
    height: out.height,
    crop: { x: p.rect.x, y: p.rect.y, w: p.rect.width, h: p.rect.height },
  };
}
function protectedRects(source: Source) {
  const work = {
    sources: [
      {
        image: source.image,
        top: 0,
        raw: source.raw,
        snapshot: {
          page: source.doc.data,
          lines: source.regions.map((r) => ({ ...r.line, region: r.doc.data })),
        },
      },
    ],
    lines: source.regions.map((r) => r.line),
  } as unknown as ResliceWork;
  const vertical = protectedResliceRanges(work);
  return source.regions.flatMap(({ line, doc }) => {
    if (line.x == null || line.y == null || line.w == null || line.h == null)
      return [];
    const range = vertical.find((r) => r.id === line.id)!;
    const xs = [
      line.x,
      line.x + line.w,
      ...(doc.data.resliceStalePolygon
        ? []
        : (doc.data.polygon ?? []).map((p: any) => p.x)),
    ];
    const bubble = doc.data.bubbleBounds;
    if (bubble) xs.push(bubble.x, bubble.x + bubble.w);
    const layout = doc.data.layout;
    const margin = layout
      ? Math.ceil(
          ((layout.size * 2 + (layout.style.outlineWidth ?? 0)) * layout.dpi) /
            72,
        )
      : 0;
    const rowXs =
      layout?.rows.flatMap((r: any) => [
        r.x - margin,
        r.x + r.width + margin,
      ]) ?? [];
    const left = Math.min(...xs.map((x) => x * source.image.width), ...rowXs),
      right = Math.max(...xs.map((x) => x * source.image.width), ...rowXs);
    const top = Math.min(
        range.top,
        bubble ? bubble.y * source.image.height : range.top,
      ),
      bottom = Math.max(
        range.bottom,
        bubble ? (bubble.y + bubble.h) * source.image.height : range.bottom,
      );
    return [
      {
        id: line.id,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      },
    ];
  });
}
export function validateReframe(
  capture: ReframeCapture,
  outputs: ReframeOutput[],
) {
  if (
    !outputs.length ||
    new Set(outputs.map((o) => o.id)).size !== outputs.length
  )
    throw new WorkflowError("Invalid output pages");
  for (const out of outputs) {
    if (
      !Number.isInteger(out.width) ||
      !Number.isInteger(out.height) ||
      out.width < 1 ||
      out.height < 1 ||
      out.width * out.height > 200_000_000
    )
      throw new WorkflowError(
        "Resulting page is too large or empty; no pages were changed",
      );
    for (const p of out.placements) {
      const s = capture.sources.find((s) => s.image.id === p.imageId);
      if (
        !s ||
        Object.values(p.rect).some((n) => !Number.isInteger(n)) ||
        ![p.x, p.y].every(Number.isInteger) ||
        p.rect.width < 1 ||
        p.rect.height < 1 ||
        p.rect.x < 0 ||
        p.rect.y < 0 ||
        p.rect.x + p.rect.width > s.image.width ||
        p.rect.y + p.rect.height > s.image.height ||
        p.x < 0 ||
        p.y < 0 ||
        p.x + p.rect.width > out.width ||
        p.y + p.rect.height > out.height
      )
        throw new WorkflowError("Invalid source placement");
    }
    if (
      out.placements.some((p, i) =>
        out.placements
          .slice(i + 1)
          .some((q) =>
            intersection(
              { x: p.x, y: p.y, width: p.rect.width, height: p.rect.height },
              { x: q.x, y: q.y, width: q.rect.width, height: q.rect.height },
            ),
          ),
      )
    )
      throw new WorkflowError(
        "Source fragments cannot overlap; no pixels may be overwritten",
      );
  }
  for (const s of capture.sources) {
    const placements = outputs.flatMap((out) =>
      out.placements.filter((p) => p.imageId === s.image.id),
    );
    if (
      placements.reduce((n, p) => n + p.rect.width * p.rect.height, 0) !==
        s.image.width * s.image.height ||
      placements.some((p, i) =>
        placements.slice(i + 1).some((q) => intersection(p.rect, q.rect)),
      )
    )
      throw new WorkflowError(
        "Changing page boundaries must preserve every source pixel exactly once",
      );
    for (const r of protectedRects(s)) {
      // Existing edge overflows are retained; only newly introduced internal boundaries are protected.
      const visible = intersection(r, {
        x: 0,
        y: 0,
        width: s.image.width,
        height: s.image.height,
      });
      if (
        visible &&
        !placements.some(
          (p) =>
            visible.x >= p.rect.x &&
            visible.y >= p.rect.y &&
            visible.x + visible.width <= p.rect.x + p.rect.width &&
            visible.y + visible.height <= p.rect.y + p.rect.height,
        )
      )
        throw new WorkflowError(
          `This cut crosses an existing region or its lettering (${r.id}). Move the boundary outside the region to keep it whole.`,
          400,
          { lineId: r.id },
        );
    }
  }
}
type StateMap = Map<string, PageData>;
const layers = [
  "original",
  "prepared",
  "cleaned",
  "cleanBase",
  "previousArtwork",
  "mask",
] as const;
function layerHash(page: PageData, key: (typeof layers)[number]) {
  if (key === "cleaned") return page.cleaned ?? page.cleanBase ?? page.prepared;
  if (key === "cleanBase" || key === "previousArtwork")
    return page[key] ?? page.prepared;
  if (key === "original") return page.original ?? page.prepared;
  return page[key];
}
async function renderPage(
  capture: ReframeCapture,
  out: ReframeOutput,
  states: StateMap,
  cache: Map<string, Promise<string>>,
  frameId: string,
  abort?: AbortSignal,
): Promise<PageData> {
  abort?.throwIfAborted();
  const contributors = out.placements.map((p) => ({
    p,
    s: capture.sources.find((s) => s.image.id === p.imageId)!,
    page: states.get(p.imageId)!,
  }));
  const raster = async (
    key: string,
    resolve: (p: PageData) => string | undefined,
    black = false,
    resize = false,
  ) => {
    const signature = hash(
      JSON.stringify([
        out.width,
        out.height,
        black,
        resize,
        contributors.map(({ p, s, page }) => [p, resolve(page) ?? hash(s.raw)]),
      ]),
    );
    if (!cache.has(signature))
      cache.set(
        signature,
        (async () => {
          const canvas = Buffer.alloc(
            out.width * out.height * 4,
            black ? 0 : 255,
          );
          if (black) for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;
          for (const { p, s, page } of contributors) {
            abort?.throwIfAborted();
            const asset = resolve(page);
            if (black && !asset) continue;
            let bytes = asset ? await readAsset(asset) : s.raw;
            const meta = await sharp(bytes).metadata();
            if (
              meta.width !== s.image.width ||
              meta.height !== s.image.height
            ) {
              if (!resize)
                throw new WorkflowError(
                  `Saved ${key} or its history has different dimensions from ${s.image.originalName}. Stopped to preserve the work.`,
                );
              bytes = await sharp(bytes)
                .resize(s.image.width, s.image.height, { fit: "fill" })
                .png()
                .toBuffer();
            }
            const crop = await sharp(bytes)
              .extract({
                left: p.rect.x,
                top: p.rect.y,
                width: p.rect.width,
                height: p.rect.height,
              })
              .toColourspace("srgb")
              .ensureAlpha()
              .raw()
              .toBuffer();
            for (let y = 0; y < p.rect.height; y++)
              crop.copy(
                canvas,
                ((p.y + y) * out.width + p.x) * 4,
                y * p.rect.width * 4,
                (y + 1) * p.rect.width * 4,
              );
          }
          return storeAsset(
            await sharp(canvas, {
              raw: { width: out.width, height: out.height, channels: 4 },
            })
              .png()
              .toBuffer(),
          );
        })(),
      );
    return cache.get(signature)!;
  };
  const first = contributors[0].page;
  const page: PageData = {
    ...first,
    geometryFrameId: frameId,
    sourcePageIds: [
      ...new Set(
        contributors.flatMap(({ s, page }) => [
          s.image.id,
          ...(page.sourcePageIds ?? []),
        ]),
      ),
    ],
    completed: undefined,
    maskDiagnostics: undefined,
    directorCleaning: undefined,
    strokes: undefined,
    cleanFinish: undefined,
    cleanFinishes: undefined,
    reframeHistory: undefined,
  };
  for (const key of layers)
    page[key] =
      ["original", "prepared"].includes(key) ||
      contributors.some((c) => !!c.page[key])
        ? await raster(key, (p) => layerHash(p, key), key === "mask")
        : undefined;
  page.contentApprovals = contributors.flatMap(({ p, s, page }) =>
    (
      page.contentApprovals ?? [
        {
          frameId: s.frameId,
          x: 0,
          y: 0,
          width: s.image.width,
          height: s.image.height,
          maskApproved: !!page.maskApproved,
          cleanApproved: !!page.cleanApproved,
        },
      ]
    ).flatMap((a) => {
      const clip = intersection(a, p.rect);
      return clip
        ? [
            {
              ...a,
              x: clip.x + p.x - p.rect.x,
              y: clip.y + p.y - p.rect.y,
              width: clip.width,
              height: clip.height,
            },
          ]
        : [];
    }),
  );
  page.maskApproved = page.contentApprovals.every((a) => a.maskApproved);
  page.cleanApproved = page.contentApprovals.every((a) => a.cleanApproved);
  page.strokes = contributors.flatMap(({ p, s, page }) =>
    (page.strokes ?? [])
      .filter((stroke) => {
        if (!stroke.points.length) return false;
        const xs = stroke.points.map((pt) => pt.x * s.image.width),
          ys = stroke.points.map((pt) => pt.y * s.image.height);
        return (
          Math.max(...xs) + stroke.radius >= p.rect.x &&
          Math.min(...xs) - stroke.radius <= p.rect.x + p.rect.width &&
          Math.max(...ys) + stroke.radius >= p.rect.y &&
          Math.min(...ys) - stroke.radius <= p.rect.y + p.rect.height
        );
      })
      .map((stroke) => ({
        ...stroke,
        points: stroke.points.map((pt) => ({
          x: (pt.x * s.image.width + p.x - p.rect.x) / out.width,
          y: (pt.y * s.image.height + p.y - p.rect.y) / out.height,
        })),
      })),
  );
  page.pendingCleanRegions = [
    ...new Set(
      contributors.flatMap(({ p, s, page }) =>
        (page.pendingCleanRegions ?? []).filter((id) => {
          const l = s.regions.find((r) => r.line.id === id)?.line;
          if (!l) return false;
          const x = Math.max(
              0,
              Math.min(
                s.image.width - 0.001,
                ((l.x ?? 0) + (l.w ?? 0) / 2) * s.image.width,
              ),
            ),
            y = Math.max(
              0,
              Math.min(
                s.image.height - 0.001,
                ((l.y ?? 0) + (l.h ?? 0) / 2) * s.image.height,
              ),
            );
          return (
            x >= p.rect.x &&
            x < p.rect.x + p.rect.width &&
            y >= p.rect.y &&
            y < p.rect.y + p.rect.height
          );
        }),
      ),
    ),
  ];
  if (!page.pendingCleanRegions.length) delete page.pendingCleanRegions;
  const finishes: CleanFinish[] = [];
  for (const c of contributors)
    for (const finish of savedCleaningFinishes(c.page)) {
      // A finish is cropped independently. Its black mask confines subsequent reprocessing to this fragment.
      const renderFinish = async (
        key: keyof Pick<CleanFinish, "base" | "answer" | "mask" | "result">,
      ) => {
        const bytes = await readAsset(finish[key]);
        const resized = await sharp(bytes)
          .resize(c.s.image.width, c.s.image.height, { fit: "fill" })
          .png()
          .toBuffer();
        const crop = await sharp(resized)
          .extract({
            left: c.p.rect.x,
            top: c.p.rect.y,
            width: c.p.rect.width,
            height: c.p.rect.height,
          })
          .png()
          .toBuffer();
        return storeAsset(
          await sharp({
            create: {
              width: out.width,
              height: out.height,
              channels: 4,
              background: key === "mask" ? "#000000" : "#ffffff",
            },
          })
            .composite([{ input: crop, left: c.p.x, top: c.p.y }])
            .png()
            .toBuffer(),
        );
      };
      const mask = await renderFinish("mask");
      if (
        (
          await sharp(await readAsset(mask))
            .greyscale()
            .stats()
        ).channels[0].max === 0
      )
        continue;
      finishes.push({
        ...finish,
        mask,
        base: await renderFinish("base"),
        answer: await renderFinish("answer"),
        result: await renderFinish("result"),
      });
    }
  if (finishes.length) {
    page.cleanFinishes = finishes;
    if (finishes.length === 1)
      page.cleanFinish = {
        ...finishes[0],
        result: page.cleaned ?? page.cleanBase ?? page.prepared!,
      };
  }
  page.thumbnail = await storePageThumbnail(
    await readAsset(page.cleaned ?? page.cleanBase ?? page.prepared!),
  );
  return page;
}

async function projectRegion(
  source: Source,
  line: LineRow,
  region: RegionData,
  p: Placement,
  out: ReframeOutput,
  frameId: string,
  dpi: number,
  history = false,
) {
  let historicalBounds = region.historyBounds;
  if (history && !historicalBounds && !region.geometryFrameId) {
    // Legacy document snapshots predate explicit bounds. The next line revision
    // records the bounds that were current when this region snapshot was saved.
    const saved = sqlite
      .prepare(
        "SELECT id FROM workflow_revisions WHERE entity_id=? AND data=? ORDER BY id DESC LIMIT 1",
      )
      .get(`region:${line.id}`, JSON.stringify(region)) as
      { id: number } | undefined;
    if (saved) {
      const next = sqlite
        .prepare(
          "SELECT data FROM workflow_revisions WHERE entity_id=? AND id>? ORDER BY id LIMIT 1",
        )
        .get(line.id, saved.id) as { data: string } | undefined;
      if (next) {
        const bounds = JSON.parse(next.data);
        if (["x", "y", "w", "h"].every((k) => typeof bounds[k] === "number"))
          historicalBounds = {
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
          };
      }
    }
  }
  const t = transform(p, out),
    oldLine = { ...line, ...(history ? historicalBounds : {}) };
  const next = transformRegion(oldLine, region, source.image, t);
  next.region.geometryFrameId = frameId;
  if (line.x != null && line.y != null) next.region.historyBounds = next.bounds;
  else delete next.region.historyBounds;
  if (region.polygon?.length) {
    const frame = {
      image: source.image,
      top: 0,
      raw: source.raw,
      snapshot: {
        page: source.doc.data,
        lines: source.regions.map((r) => ({ ...r.line, region: r.doc.data })),
      },
    };
    if (
      !currentReslicePolygon(
        oldLine,
        region,
        source.image,
        sourceHasStalePolygonFrame(frame),
      ).length &&
      next.region.polygon
    )
      next.region.resliceStalePolygon = hash(
        JSON.stringify(next.region.polygon),
      );
    else delete next.region.resliceStalePolygon;
  }
  if (region.textMask)
    next.region.textMask = await storeAsset(
      await transformRaster(await readAsset(region.textMask), t, "#ffffff"),
    );
  if (region.layout && next.region.layout) {
    const old = region.layout,
      fresh =
        old.key ===
        layoutKey(oldLine, region, source.image, old.style, old.dpi);
    if (old.dpi !== dpi) {
      const ratio = old.dpi / dpi,
        style = { ...old.style, ...region.style };
      next.region.style = {
        ...region.style,
        size: style.size * ratio,
        minSize: style.minSize * ratio,
        padding: style.padding * ratio,
        outlineWidth: style.outlineWidth * ratio,
      };
      next.region.layout = {
        ...next.region.layout,
        dpi,
        size: old.size * ratio,
        style: {
          ...old.style,
          size: old.style.size * ratio,
          minSize: old.style.minSize * ratio,
          padding: old.style.padding * ratio,
          outlineWidth: old.style.outlineWidth * ratio,
        },
      };
    }
    next.region.layout.key = fresh
      ? layoutKey(
          { ...line, ...next.bounds },
          next.region,
          { ...source.image, width: out.width, height: out.height },
          next.region.layout.style,
          dpi,
        )
      : old.key;
  }
  return next;
}
function choosePlacement(
  source: Source,
  line: LineRow,
  outputs: ReframeOutput[],
) {
  const x = Math.max(
    0,
    Math.min(
      source.image.width - 0.001,
      ((line.x ?? 0) + (line.w ?? 0) / 2) * source.image.width,
    ),
  );
  const y = Math.max(
    0,
    Math.min(
      source.image.height - 0.001,
      ((line.y ?? 0) + (line.h ?? 0) / 2) * source.image.height,
    ),
  );
  for (const out of outputs)
    for (const p of out.placements)
      if (
        p.imageId === source.image.id &&
        x >= p.rect.x &&
        x < p.rect.x + p.rect.width &&
        y >= p.rect.y &&
        y < p.rect.y + p.rect.height
      )
        return { out, p };
  throw new WorkflowError("A region has no destination page");
}

/** Rebuild undo and redo as linked, projected snapshots; independent source edits commute. */
async function projectHistory(
  capture: ReframeCapture,
  outputs: ReframeOutput[],
  frames: Map<string, string>,
  cache: Map<string, Promise<string>>,
  which: "undo" | "redo",
  abort?: AbortSignal,
) {
  const states = new Map(
    capture.sources.map((s) => [s.image.id, s.doc.data as PageData]),
  );
  const stacks = new Map(
    capture.sources.map((s) => [
      s.image.id,
      s.doc[which].map((data, i) => ({
        data,
        id:
          (data as PageData).reframeHistory?.eventId ??
          `${s.frameId}:${which}:${i}`,
      })),
    ]),
  );
  const projected = new Map(outputs.map((o) => [o.id, [] as PageData[]]));
  while ([...stacks.values()].some((s) => s.length)) {
    abort?.throwIfAborted();
    const tops = [...stacks.values()]
      .filter((s) => s.length)
      .map((s) => s.at(-1)!.id);
    const id = tops.find((id) =>
      [...stacks.values()].every(
        (s) => !s.some((e) => e.id === id) || s.at(-1)?.id === id,
      ),
    );
    if (!id)
      throw new WorkflowError(
        "Edit histories have conflicting order; page boundaries were not changed",
      );
    const related = new Set<string>();
    for (const [source, stack] of stacks)
      if (stack.at(-1)?.id === id) {
        const entry = stack.pop()!.data;
        for (const pageId of entry.reframeHistory?.pageIds ?? [])
          if (!capture.sources.some((s) => s.image.id === pageId))
            related.add(pageId);
        states.set(source, entry);
      }
    for (const out of outputs) {
      const page = await renderPage(
        capture,
        out,
        states,
        cache,
        frames.get(out.id)!,
        abort,
      );
      page.reframeHistory = {
        eventId: id,
        pageIds: [...new Set([...outputs.map((o) => o.id), ...related])],
      };
      projected.get(out.id)!.push(page);
    }
  }
  for (const history of projected.values()) history.reverse();
  return projected;
}
function imageDb(image: ImageRow) {
  return {
    id: image.id,
    episode_id: image.episodeId,
    filename: image.filename,
    original_name: image.originalName,
    sort_order: image.sortOrder,
    width: image.width,
    height: image.height,
    dpi: image.dpi ?? 72,
    caption: image.caption,
    role: image.role ?? "page",
    page_number: image.pageNumber ?? null,
    created_at: image.createdAt,
    updated_at: image.updatedAt,
  };
}
function insertImage(image: ImageRow) {
  const r = imageDb(image),
    keys = Object.keys(r);
  sqlite
    .prepare(
      `INSERT INTO images(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${keys
        .filter((k) => k !== "id")
        .map((k) => `${k}=excluded.${k}`)
        .join(",")}`,
    )
    .run(...Object.values(r));
}
function setLine(episodeId: string, line: LineRow) {
  const old = sqlite
    .prepare("SELECT revision FROM lines WHERE id=? AND episode_id=?")
    .get(line.id, episodeId) as any;
  if (!old)
    throw new WorkflowError("A region disappeared while changing pages", 409);
  sqlite
    .prepare(
      "UPDATE lines SET image_id=?,x=?,y=?,w=?,h=?,revision=revision+1,updated_at=? WHERE id=? AND episode_id=?",
    )
    .run(
      line.imageId,
      line.x ?? null,
      line.y ?? null,
      line.w ?? null,
      line.h ?? null,
      Date.now(),
      line.id,
      episodeId,
    );
  sqlite
    .prepare(
      "UPDATE suggestions SET base_revision=? WHERE line_id=? AND episode_id=? AND base_revision=? AND state='pending'",
    )
    .run(old.revision + 1, line.id, episodeId, old.revision);
}
export async function executeReframe(
  ctx: PageEditCtx,
  ids: string[],
  outputs: ReframeOutput[],
  description: string,
  expectedToken?: string,
  abort?: AbortSignal,
  allowedJobId?: string,
) {
  if (
    sqlite
      .prepare(
        "SELECT 1 FROM workflow_jobs WHERE episode_id=? AND state IN ('running','queued','cancelling') AND id<>? LIMIT 1",
      )
      .get(ctx.episode.id, allowedJobId ?? "")
  )
    throw new WorkflowError(
      "Wait for active chapter jobs to finish before changing page boundaries",
      409,
    );
  if (locks.has(ctx.episode.id))
    throw new WorkflowError("Another page boundary edit is running", 409);
  locks.add(ctx.episode.id);
  const savedFiles: string[] = [];
  let undoWritten = false;
  let committed = false;
  try {
    abort?.throwIfAborted();
    const capture = await captureReframe(ctx, ids);
    if (
      capture.sources.some(
        (s, i) =>
          i &&
          capture.order.indexOf(s.image) !==
            capture.order.indexOf(capture.sources[i - 1].image) + 1,
      )
    )
      throw new WorkflowError(
        "Choose consecutive story pages; page boundaries cannot jump over credits or other pages",
      );
    if (expectedToken && capture.token !== expectedToken)
      throw new WorkflowError(
        "Pages or saved work changed after the preview. Preview again.",
        409,
      );
    validateReframe(capture, outputs);
    if (
      outputs.length === capture.sources.length &&
      outputs.every((out, i) => {
        const source = capture.sources[i],
          p = out.placements[0];
        return (
          out.id === source.image.id &&
          out.width === source.image.width &&
          out.height === source.image.height &&
          out.placements.length === 1 &&
          p.imageId === out.id &&
          p.x === 0 &&
          p.y === 0 &&
          p.rect.x === 0 &&
          p.rect.y === 0 &&
          p.rect.width === out.width &&
          p.rect.height === out.height
        );
      })
    )
      return { images: capture.order, changedIds: [] };
    const cache = new Map<string, Promise<string>>(),
      frames = new Map(outputs.map((o) => [o.id, randomUUID()]));
    const state = new Map(
      capture.sources.map((s) => [s.image.id, s.doc.data as PageData]),
    );
    const selected = new Set(ids),
      insertAt = capture.order.findIndex((i) => selected.has(i.id));
    const kept = capture.order.filter((i) => !selected.has(i.id));
    const previous = capture.sources.map((s) => s.image),
      docs: SavedDoc[] = [],
      created: ImageRow[] = [];
    const undoHistory = await projectHistory(
      capture,
      outputs,
      frames,
      cache,
      "undo",
      abort,
    );
    const redoHistory = await projectHistory(
      capture,
      outputs,
      frames,
      cache,
      "redo",
      abort,
    );
    for (const [i, out] of outputs.entries()) {
      abort?.throwIfAborted();
      const source = capture.sources.find(
        (s) => s.image.id === out.placements[0].imageId,
      )!;
      const retained = capture.sources.find(
        (s) => s.image.id === out.id,
      )?.image;
      const image: ImageRow = {
        ...source.image,
        ...retained,
        id: out.id,
        filename: "",
        originalName:
          out.originalName ??
          retained?.originalName ??
          source.image.originalName,
        width: out.width,
        height: out.height,
        sortOrder: insertAt + i,
        updatedAt: Date.now(),
        createdAt: retained?.createdAt ?? Date.now(),
        pageNumber: retained?.pageNumber,
        caption: [
          ...new Set(
            out.placements
              .map(
                (p) =>
                  capture.sources.find((s) => s.image.id === p.imageId)!.image
                    .caption,
              )
              .filter(Boolean),
          ),
        ].join("\n\n"),
      };
      const page = await renderPage(
        capture,
        out,
        state,
        cache,
        frames.get(out.id)!,
        abort,
      );
      image.dpi = page.dpi ?? source.image.dpi ?? 72;
      page.preparedAt = image.updatedAt;
      page.thumbnailAt = image.updatedAt;
      for (const history of [
        ...undoHistory.get(out.id)!,
        ...redoHistory.get(out.id)!,
      ]) {
        history.preparedAt = image.updatedAt;
        history.thumbnailAt = image.updatedAt;
      }
      docs.push({
        id: `page:${out.id}`,
        revision: 0,
        data: page,
        undo: undoHistory.get(out.id)!,
        redo: redoHistory.get(out.id)!,
      });
      created.push(image);
    }
    const moved: LineRow[] = [];
    const externalDocs: SavedDoc[] = [];
    // A later split of just one participant must update the other participants' undo links too.
    for (const row of sqlite
      .prepare(
        "SELECT id FROM workflow_docs WHERE episode_id=? AND id LIKE 'page:%'",
      )
      .all(ctx.episode.id) as { id: string }[]) {
      if (selected.has(row.id.slice(5))) continue;
      const before = storedDoc(row.id),
        after = structuredClone(before);
      let changed = false;
      for (const state of [...after.undo, ...after.redo])
        if (
          state.reframeHistory?.pageIds?.some((id: string) => selected.has(id))
        ) {
          state.reframeHistory.pageIds = [
            ...new Set(
              state.reframeHistory.pageIds.flatMap((id: string) =>
                selected.has(id) ? outputs.map((o) => o.id) : [id],
              ),
            ),
          ];
          changed = true;
        }
      if (changed) {
        externalDocs.push(before);
        docs.push(after);
      }
    }
    for (const source of capture.sources)
      for (const saved of source.regions) {
        const { out, p } = choosePlacement(source, saved.line, outputs),
          image = created.find((i) => i.id === out.id)!;
        const next = await projectRegion(
          source,
          saved.line,
          saved.doc.data,
          p,
          out,
          frames.get(out.id)!,
          image.dpi ?? 72,
        );
        const line = {
          ...saved.line,
          imageId: out.id,
          x: saved.line.x == null ? saved.line.x : next.bounds.x,
          y: saved.line.y == null ? saved.line.y : next.bounds.y,
          w: saved.line.w == null ? saved.line.w : next.bounds.w,
          h: saved.line.h == null ? saved.line.h : next.bounds.h,
          updatedAt: Date.now(),
        };
        moved.push(line);
        const projected = async (list: RegionData[]) =>
          Promise.all(
            list.map(
              async (r) =>
                (
                  await projectRegion(
                    source,
                    saved.line,
                    r,
                    p,
                    out,
                    frames.get(out.id)!,
                    image.dpi ?? 72,
                    true,
                  )
                ).region,
            ),
          );
        docs.push({
          ...saved.doc,
          data: next.region,
          undo: await projected(saved.doc.undo),
          redo: await projected(saved.doc.redo),
        });
      }
    // Regional cleaning checkpoints can remain verified because their exact pixels moved together.
    for (const doc of docs.filter((d) =>
      created.some((i) => d.id === `page:${i.id}`),
    )) {
      const imageId = doc.id.slice(5),
        regions: Record<string, any> = {};
      for (const source of capture.sources)
        for (const r of source.regions) {
          const stamp = source.doc.data.directorCleaning?.regions?.[r.line.id];
          const line = moved.find(
            (l) => l.id === r.line.id && l.imageId === imageId,
          );
          const oldPage = source.doc.data as PageData;
          const valid =
            oldPage.directorCleaning?.raw === oldPage.prepared &&
            oldPage.directorCleaning?.artwork ===
              (oldPage.cleaned ?? oldPage.cleanBase ?? oldPage.prepared) &&
            stamp?.geometry ===
              hash(
                JSON.stringify({
                  box: [r.line.x, r.line.y, r.line.w, r.line.h],
                  polygon: maskRegion(r.line, r.doc.data),
                }),
              );
          if (stamp && line && valid) {
            const data = docs.find((d) => d.id === `region:${line.id}`)!.data;
            regions[line.id] = {
              ...stamp,
              geometry: hash(
                JSON.stringify({
                  box: [line.x, line.y, line.w, line.h],
                  polygon: maskRegion(line, data),
                }),
              ),
            };
          }
        }
      if (Object.keys(regions).length)
        doc.data.directorCleaning = {
          raw: doc.data.prepared,
          artwork: doc.data.cleaned ?? doc.data.cleanBase ?? doc.data.prepared,
          regions,
        };
      doc.data.pendingCleanRegions = capture.sources
        .flatMap((s) => s.doc.data.pendingCleanRegions ?? [])
        .filter((id) =>
          moved.some((l) => l.id === id && l.imageId === imageId),
        );
      if (!doc.data.pendingCleanRegions.length)
        delete doc.data.pendingCleanRegions;
    }
    const reviews: ReframeUndo["reviews"] = [];
    for (const job of sqlite
      .prepare(
        "SELECT id,payload,progress FROM workflow_jobs WHERE episode_id=? AND kind='page-proofread'",
      )
      .all(ctx.episode.id) as any[]) {
      const payload = JSON.parse(job.payload),
        progress = JSON.parse(job.progress);
      const related = new Set([
        payload.imageId,
        ...(progress.pageGeometry?.imageIds ?? []),
      ]);
      const affected = outputs
        .filter((o) => o.placements.some((p) => related.has(p.imageId)))
        .map((o) => o.id);
      if (affected.length)
        reviews.push({
          id: job.id,
          before: progress.pageGeometry,
          after: {
            imageIds: [
              ...new Set([
                ...(progress.pageGeometry?.imageIds ?? []).filter(
                  (id: string) => !selected.has(id),
                ),
                ...affected,
              ]),
            ],
            reason: "Page boundaries changed",
            stale: true,
          },
        });
    }
    for (const image of created) {
      abort?.throwIfAborted();
      const page = docs.find((d) => d.id === `page:${image.id}`)!
        .data as PageData;
      const saved = await saveImageFile({
        seriesSlug: ctx.series.slug,
        episodeSlug: ctx.episode.slug,
        sortOrder: image.sortOrder,
        originalName: image.originalName,
        bytes: await readAsset(page.prepared!),
        mime: "image/png",
      });
      image.filename = saved.filename;
      savedFiles.push(saved.filename);
      await writeFile(
        origImagePath(ctx.series.slug, ctx.episode.slug, saved.filename),
        await readAsset(page.original!),
      );
    }
    const oldDocs = [
      ...capture.sources.flatMap((s) => [
        s.doc,
        ...s.regions.map((r) => r.doc),
      ]),
      ...externalDocs,
    ];
    const ordered = [
      ...kept.slice(0, insertAt),
      ...created,
      ...kept.slice(insertAt),
    ];
    const op: ReframeUndo = {
      type: "reframe",
      description,
      previous,
      created,
      docs: oldDocs,
      lines: capture.sources.flatMap((s) => s.regions.map((r) => r.line)),
      order: capture.order.map((i) => ({ id: i.id, sortOrder: i.sortOrder })),
      expectedDocs: Object.fromEntries(
        docs.map((d) => [d.id, docSignature(d)]),
      ),
      expectedLines: Object.fromEntries(
        moved.map((l) => [l.id, lineSignature(l)]),
      ),
      reviews,
      frameIds: [...frames.values()],
      originalFiles: previous
        .filter((i) =>
          existsSync(
            origImagePath(ctx.series.slug, ctx.episode.slug, i.filename),
          ),
        )
        .map((i) => i.filename),
    };
    await pushUndo(ctx.series.slug, ctx.episode.slug, op);
    undoWritten = true;
    const current = await captureReframe(ctx, ids);
    if (current.token !== capture.token)
      throw new WorkflowError(
        "Pages or saved work changed while changing boundaries. No work was replaced.",
        409,
      );
    if (
      externalDocs.some(
        (d) => docSignature(storedDoc(d.id)) !== docSignature(d),
      )
    )
      throw new WorkflowError(
        "Related cleaning history changed. Retry without replacing any work.",
        409,
      );
    sqlite.transaction(() => {
      abort?.throwIfAborted();
      for (const image of created) insertImage(image);
      for (const line of moved) setLine(ctx.episode.id, line);
      for (const doc of docs) writeDoc(ctx.episode.id, doc);
      for (const image of previous)
        if (!created.some((i) => i.id === image.id))
          sqlite.prepare("DELETE FROM images WHERE id=?").run(image.id);
      for (const [i, image] of ordered.entries())
        sqlite
          .prepare("UPDATE images SET sort_order=? WHERE id=?")
          .run(i, image.id);
      for (const r of reviews) setReviewGeometry(r.id, r.after);
      for (const source of capture.sources)
        if (!getDoc(`frame:${source.frameId}`, {}).revision)
          writeDoc(ctx.episode.id, {
            id: `frame:${source.frameId}`,
            revision: 0,
            data: {
              id: source.frameId,
              width: source.image.width,
              height: source.image.height,
              imageId: source.image.id,
              page: source.doc.data,
            },
            undo: [],
            redo: [],
          });
      for (const out of outputs)
        writeDoc(ctx.episode.id, {
          id: `frame:${frames.get(out.id)}`,
          revision: 0,
          data: {
            id: frames.get(out.id),
            width: out.width,
            height: out.height,
            sources: out.placements.map((p) => ({
              ...p,
              frameId: capture.sources.find((s) => s.image.id === p.imageId)!
                .frameId,
            })),
          },
          undo: [],
          redo: [],
        });
      sqlite
        .prepare(
          "UPDATE director_pages SET state='stale',fingerprint=NULL,detail='Page boundaries changed' WHERE episode_id=? AND image_id IN (SELECT value FROM json_each(?))",
        )
        .run(
          ctx.episode.id,
          JSON.stringify([...ids, ...outputs.map((o) => o.id)]),
        );
    })();
    committed = true;
    await publish(ctx, previous, created);
    return {
      images: await listImages(ctx.episode.id),
      changedIds: created.map((i) => i.id),
    };
  } catch (error) {
    if (committed) throw error;
    if (undoWritten)
      await popUndo(ctx.series.slug, ctx.episode.slug, undefined, true);
    for (const file of savedFiles)
      await removeImageFile(ctx.series.slug, ctx.episode.slug, file).catch(
        () => {},
      );
    throw error;
  } finally {
    locks.delete(ctx.episode.id);
  }
}
function setReviewGeometry(id: string, value: unknown) {
  const row = sqlite
    .prepare("SELECT progress FROM workflow_jobs WHERE id=?")
    .get(id) as any;
  if (!row) return;
  const progress = JSON.parse(row.progress);
  if (value === undefined) delete progress.pageGeometry;
  else progress.pageGeometry = value;
  sqlite
    .prepare("UPDATE workflow_jobs SET progress=? WHERE id=?")
    .run(JSON.stringify(progress), id);
}
async function publish(
  ctx: PageEditCtx,
  previous: ImageRow[],
  created: ImageRow[],
) {
  for (const image of previous)
    if (!created.some((i) => i.id === image.id))
      broadcast(ctx.episode.id, { type: "image:delete", id: image.id });
  for (const image of created)
    broadcast(ctx.episode.id, { type: "image:upsert", image });
  for (const line of await listLines(ctx.episode.id))
    broadcast(ctx.episode.id, { type: "line:upsert", line });
  broadcast(ctx.episode.id, {
    type: "image:reorder",
    order: (await listImages(ctx.episode.id)).map((i) => ({
      id: i.id,
      sortOrder: i.sortOrder,
    })),
  });
  broadcast(ctx.episode.id, {
    type: "workflow:changed",
    id: "pages",
    revision: Date.now(),
  });
}
export async function undoReframe(ctx: PageEditCtx, op: ReframeUndo) {
  const current = await listImages(ctx.episode.id),
    lines = await listLines(ctx.episode.id);
  if (op.created.some((i) => !current.some((c) => c.id === i.id)))
    throw new WorkflowError(
      "These pages no longer exist. Undo the newer page edit first.",
      409,
    );
  if (
    lines.some(
      (l) =>
        op.created.some((i) => i.id === l.imageId) &&
        !Object.hasOwn(op.expectedLines, l.id),
    ) ||
    Object.entries(op.expectedDocs).some(
      ([id, signature]) => docSignature(storedDoc(id)) !== signature,
    ) ||
    Object.entries(op.expectedLines).some(([id, s]) => {
      const l = lines.find((l) => l.id === id);
      return !l || lineSignature(l) !== s;
    })
  )
    throw new WorkflowError(
      "These pages contain later work. Undo those edits before restoring the old boundary; your history is unchanged.",
      409,
    );
  for (const image of op.previous)
    if (
      !existsSync(imagePath(ctx.series.slug, ctx.episode.slug, image.filename))
    )
      throw new WorkflowError(
        "The original page backup is missing. Undo was stopped before changing any pages.",
        409,
      );
  for (const filename of op.originalFiles ?? [])
    if (!existsSync(origImagePath(ctx.series.slug, ctx.episode.slug, filename)))
      throw new WorkflowError(
        "The original upload backup is missing. Undo was stopped before changing any pages.",
        409,
      );
  sqlite.transaction(() => {
    const known = new Set(op.reviews.map((r) => r.id));
    for (const job of sqlite
      .prepare(
        "SELECT id,payload,progress FROM workflow_jobs WHERE episode_id=? AND kind='page-proofread'",
      )
      .all(ctx.episode.id) as any[]) {
      const payload = JSON.parse(job.payload),
        progress = JSON.parse(job.progress);
      if (
        !known.has(job.id) &&
        op.created.some(
          (i) =>
            i.id === payload.imageId ||
            (progress.pageGeometry?.imageIds ?? []).includes(i.id),
        )
      )
        setReviewGeometry(job.id, {
          imageIds: op.previous.map((i) => i.id),
          stale: true,
          reason: "Page boundaries changed",
        });
    }
    for (const image of op.previous) insertImage(image);
    for (const line of op.lines) setLine(ctx.episode.id, line);
    for (const doc of op.docs) writeDoc(ctx.episode.id, doc);
    for (const image of op.created)
      if (!op.previous.some((i) => i.id === image.id))
        sqlite.prepare("DELETE FROM images WHERE id=?").run(image.id);
    for (const item of op.order)
      sqlite
        .prepare("UPDATE images SET sort_order=? WHERE id=?")
        .run(item.sortOrder, item.id);
    for (const r of op.reviews) setReviewGeometry(r.id, r.before);
  })();
  for (const image of op.created)
    await removeImageFile(
      ctx.series.slug,
      ctx.episode.slug,
      image.filename,
    ).catch(() => {});
  await publish(ctx, op.created, op.previous);
  return { images: await listImages(ctx.episode.id) };
}
