import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Layer, Psd } from "ag-psd";
import sharp from "sharp";
import type { LineRow } from "../types";
import type { FittedLayout, RegionData } from "../workflow";

/**
 * What a page PSD looked like when Komatose exported it, stored in the PSD so an import can
 * apply only what changed in Photoshop. It lives in the document's XMP (File Info, which
 * Photoshop keeps on save) and, in case XMP is stripped, in a hidden text layer.
 *
 * Text layers are matched by Photoshop's layer ID, which survives the renames Photoshop makes
 * when a type layer's text is edited; each region's exported state is what its layers are
 * compared against, so edits made in Komatose after the export are left alone.
 */

export const META_LAYER = "Komatose export data (keep hidden)";
const NS = "https://komatose.app/ns/psd-export/1.0/";
const PREFIX = "KOMATOSE1:";

export type RegionSnapshot = {
  line: Pick<LineRow, "id" | "body" | "x" | "y" | "w" | "h" | "lineType">;
  region: Pick<RegionData, "polygon" | "geometryRotation" | "renderEnabled" | "textPaths" | "textPath" | "charRuns" | "charRunsBody"> & {
    layout: Omit<FittedLayout, "svg">;
  };
};

export type ExportMeta = {
  v: 1;
  /** The page (image id) the PSD was exported from. */
  page: string;
  exportedAt: number;
  /** Raw RGB hash of the artwork as exported (cleaned layer over white). */
  artwork?: string;
  /** Region state at export, by region id. */
  regions: Record<string, RegionSnapshot>;
  /** Photoshop layer id → region id. */
  layers: Record<string, string>;
};

export function regionSnapshot(line: LineRow, data: RegionData): RegionSnapshot | undefined {
  if (!data.layout) return;
  const { svg: _svg, ...layout } = data.layout;
  return {
    line: { id: line.id, body: line.body, x: line.x, y: line.y, w: line.w, h: line.h, lineType: line.lineType },
    region: {
      polygon: data.polygon,
      geometryRotation: data.geometryRotation,
      renderEnabled: data.renderEnabled,
      textPaths: data.textPaths,
      textPath: data.textPath,
      charRuns: data.charRuns,
      charRunsBody: data.charRunsBody,
      layout,
    },
  };
}

/** The snapshot as region data and line row to compare a PSD layer with. */
export function snapshotAsRegion(s: RegionSnapshot, current: LineRow): { line: LineRow; region: RegionData } {
  return {
    line: { ...current, ...s.line },
    region: { ...s.region, layout: { ...s.region.layout, svg: "" } } as RegionData,
  };
}

/** Hash of an image's RGB on white, so re-encoding or an alpha channel doesn't count as change. */
export async function pixelHash(png: Buffer) {
  const raw = await sharp(png).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer();
  return createHash("sha256").update(raw).digest("hex");
}

const encode = (meta: ExportMeta) => gzipSync(Buffer.from(JSON.stringify(meta))).toString("base64");
function decode(text: string): ExportMeta | undefined {
  try {
    const meta = JSON.parse(gunzipSync(Buffer.from(text.replace(/\s+/g, ""), "base64")).toString()) as ExportMeta;
    return meta?.v === 1 && meta.regions && meta.layers ? meta : undefined;
  } catch {
    return undefined;
  }
}

function xmpPacket(data: string) {
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:komatose="${NS}"><komatose:Export>${data}</komatose:Export></rdf:Description>` +
    `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

/** The hidden layer copy: a tiny, hidden point-text layer holding the encoded record. */
export function metaLayer(meta: ExportMeta, id: number): Layer {
  return {
    name: META_LAYER,
    id,
    hidden: true,
    left: 0,
    top: 0,
    right: 1,
    bottom: 1,
    text: {
      text: PREFIX + encode(meta),
      transform: [1, 0, 0, 1, 0, 0],
      shapeType: "point",
      style: { font: { name: "ArialMT" }, fontSize: 1, fillColor: { r: 0, g: 0, b: 0 } },
    },
  };
}

export function writeMeta(psd: Psd, meta: ExportMeta) {
  psd.imageResources = { ...psd.imageResources, xmpMetadata: xmpPacket(encode(meta)) };
}

/** The export record from the PSD's XMP, else its hidden layer; undefined for other PSDs. */
export function readMeta(psd: Psd): ExportMeta | undefined {
  const xmp = psd.imageResources?.xmpMetadata;
  const fromXmp = xmp?.match(/<komatose:Export>([\s\S]*?)<\/komatose:Export>/)?.[1] ??
    xmp?.match(/komatose:Export="([^"]*)"/)?.[1];
  const meta = fromXmp ? decode(fromXmp) : undefined;
  if (meta) return meta;
  const layer = findMetaLayer(psd);
  const text = layer?.text?.text?.trim();
  return text?.startsWith(PREFIX) ? decode(text.slice(PREFIX.length)) : undefined;
}

export function findMetaLayer(psd: Psd): Layer | undefined {
  const visit = (layers: Layer[] | undefined): Layer | undefined => {
    for (const l of layers ?? []) {
      if (l.name === META_LAYER) return l;
      const inner = visit(l.children);
      if (inner) return inner;
    }
  };
  return visit(psd.children);
}

export const isMetaLayer = (layer: Layer) => layer.name === META_LAYER;
