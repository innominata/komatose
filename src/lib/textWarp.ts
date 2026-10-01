import {
  TEXT_WARP_STYLES,
  type FittedRow,
  type TextStyle,
  type TextWarpStyle,
} from "./workflow";

export type WarpBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type FontPathCommand = { command: string; args: number[] };

/** Maximum sampled deviation in page pixels; small details need no extra segments. */
const WARP_TOLERANCE = 0.1;
const MAX_WARP_DEPTH = 10;
const ITALIC_SKEW = Math.tan((12 * Math.PI) / 180);

export function isTextWarpStyle(value: unknown): value is TextWarpStyle {
  return (
    typeof value === "string" &&
    (TEXT_WARP_STYLES as readonly string[]).includes(value)
  );
}

export function hasTextWarp(
  style: Pick<TextStyle, "warpStyle" | "warpBend">,
): boolean {
  return (
    !!style.warpStyle &&
    style.warpStyle !== "none" &&
    Math.abs(style.warpBend ?? 0) > 0.01
  );
}

/** Layout box used by PSD box text and the in-app Arc envelope. */
export function layoutWarpBox(
  rows: FittedRow[],
  sizePx: number,
): WarpBox | undefined {
  if (!rows.length) return;
  return {
    left: Math.min(...rows.map((row) => row.x)),
    right: Math.max(...rows.map((row) => row.x + row.width)),
    top: rows[0].baseline - sizePx,
    bottom: rows.at(-1)!.baseline + sizePx * 0.3,
  };
}

/**
 * Photoshop Type → Warp Text payload. Bend is the dialog’s −100…100 value
 * (ag-psd `warp.value`; Type on a Path / `textPath` is read-only and omitted).
 */
export function psdTextWarp(style: TextStyle):
  | {
      style: TextWarpStyle;
      value: number;
      perspective: number;
      perspectiveOther: number;
      rotate: "horizontal";
    }
  | undefined {
  if (!hasTextWarp(style) || !isTextWarpStyle(style.warpStyle)) return;
  return {
    style: style.warpStyle,
    value: style.warpBend,
    perspective: 0,
    perspectiveOther: 0,
    rotate: "horizontal",
  };
}

/** Extra raster margin so a strong bend is not clipped in the composite/PNG. */
export function warpPad(
  style: Pick<TextStyle, "warpStyle" | "warpBend">,
  regionW: number,
  regionH: number,
): number {
  if (!hasTextWarp(style)) return 0;
  return Math.ceil(
    Math.max(regionW, regionH) * 0.5 * (Math.abs(style.warpBend) / 100),
  );
}

function lerpPoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number,
) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function quadraticPoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  t: number,
) {
  const mt = 1 - t;
  return {
    x: mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
    y: mt * mt * y0 + 2 * mt * t * y1 + t * t * y2,
  };
}

function cubicPoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  t: number,
) {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * x0 +
      3 * mt * mt * t * x1 +
      3 * mt * t * t * x2 +
      t * t * t * x3,
    y:
      mt * mt * mt * y0 +
      3 * mt * mt * t * y1 +
      3 * mt * t * t * y2 +
      t * t * t * y3,
  };
}

function fmt(n: number) {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
}

/**
 * Photoshop Type → Warp Text envelope of a point in the unrotated box.
 * Positive Bend is a rainbow (middle sits above the sides). Arc is concentric
 * so stems rotate with the curve; Arch keeps stems upright; Arc Upper / Lower
 * fade the envelope toward the opposite edge.
 */
export function warpPoint(
  x: number,
  y: number,
  box: WarpBox,
  style: Pick<TextStyle, "warpStyle" | "warpBend">,
): { x: number; y: number } {
  const kind = style.warpStyle;
  const bend = (style.warpBend ?? 0) / 100;
  if (!kind || kind === "none" || Math.abs(bend) < 1e-6) return { x, y };
  const w = box.right - box.left;
  const h = Math.max(box.bottom - box.top, 1e-6);
  if (w < 1e-6) return { x, y };
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const nx = (2 * (x - cx)) / w;
  const ny = (2 * (y - cy)) / h;
  const v = (y - box.top) / h;
  if (kind === "bulge") {
    return {
      x: cx + (x - cx) * (1 + bend * (1 - ny * ny) * 0.35),
      y: cy + (y - cy) * (1 - bend * (1 - nx * nx) * 0.35),
    };
  }
  const half = (Math.abs(bend) * Math.PI) / 2;
  if (half < 1e-6) return { x, y };
  const dir = Math.sign(bend) || 1;
  const R = w / 2 / Math.sin(half);
  const a = nx * half;
  let warped: { x: number; y: number };
  if (kind === "arch") {
    warped = {
      x,
      y: y + dir * R * (1 - Math.cos(a)),
    };
  } else {
    const r = Math.max(w * 0.05, R - dir * (y - cy));
    warped = {
      x: cx + r * Math.sin(a),
      y: cy + dir * (R - r * Math.cos(a)),
    };
  }
  if (kind === "arcUpper")
    return lerpPoint({ x, y }, warped, Math.max(0, 1 - v));
  if (kind === "arcLower") return lerpPoint({ x, y }, warped, Math.max(0, v));
  return warped;
}

function fontToPage(
  fx: number,
  fy: number,
  originX: number,
  originY: number,
  scale: number,
  italic: boolean,
) {
  const x = italic ? fx + fy * ITALIC_SKEW : fx;
  return { x: originX + x * scale, y: originY - fy * scale };
}

/**
 * Map a fontkit glyph outline through page space and the Warp Text envelope.
 * Curves are sampled so the warped result is a polyline that follows the mesh.
 */
export function warpFontPath(
  commands: readonly FontPathCommand[],
  originX: number,
  originY: number,
  scale: number,
  italic: boolean,
  box: WarpBox,
  style: Pick<TextStyle, "warpStyle" | "warpBend">,
): string {
  const map = (fx: number, fy: number) => {
    const page = fontToPage(fx, fy, originX, originY, scale, italic);
    return warpPoint(page.x, page.y, box, style);
  };
  const out: string[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  const emit = (p: { x: number; y: number }) => {
    out.push(`L${fmt(p.x)} ${fmt(p.y)}`);
  };
  const trace = (point: (t: number) => { x: number; y: number }) => {
    const sample = (t: number) => {
      const p = point(t);
      return map(p.x, p.y);
    };
    const visit = (
      t0: number,
      a: { x: number; y: number },
      t1: number,
      b: { x: number; y: number },
      depth: number,
    ) => {
      const tm = (t0 + t1) / 2;
      const mid = sample(tm);
      // Quarter samples catch inflections whose midpoint lies on the chord.
      const q1 = sample(t0 + (t1 - t0) / 4);
      const q3 = sample(t0 + ((t1 - t0) * 3) / 4);
      const error = (p: { x: number; y: number }, t: number) =>
        Math.hypot(
          p.x - (a.x + (b.x - a.x) * t),
          p.y - (a.y + (b.y - a.y) * t),
        );
      if (
        depth < MAX_WARP_DEPTH &&
        Math.max(error(q1, 0.25), error(mid, 0.5), error(q3, 0.75)) >
          WARP_TOLERANCE
      ) {
        visit(t0, a, tm, mid, depth + 1);
        visit(tm, mid, t1, b, depth + 1);
      } else emit(b);
    };
    visit(0, sample(0), 1, sample(1), 0);
  };
  for (const c of commands) {
    const a = c.args;
    switch (c.command) {
      case "moveTo": {
        cx = a[0];
        cy = a[1];
        startX = cx;
        startY = cy;
        const p = map(cx, cy);
        out.push(`M${fmt(p.x)} ${fmt(p.y)}`);
        break;
      }
      case "lineTo": {
        const x = a[0];
        const y = a[1];
        trace((t) => ({ x: cx + (x - cx) * t, y: cy + (y - cy) * t }));
        cx = x;
        cy = y;
        break;
      }
      case "quadraticCurveTo": {
        const [x1, y1, x, y] = a;
        trace((t) => quadraticPoint(cx, cy, x1, y1, x, y, t));
        cx = x;
        cy = y;
        break;
      }
      case "bezierCurveTo": {
        const [x1, y1, x2, y2, x, y] = a;
        trace((t) => cubicPoint(cx, cy, x1, y1, x2, y2, x, y, t));
        cx = x;
        cy = y;
        break;
      }
      case "closePath":
        if (cx !== startX || cy !== startY)
          trace((t) => ({
            x: cx + (startX - cx) * t,
            y: cy + (startY - cy) * t,
          }));
        out.push("Z");
        cx = startX;
        cy = startY;
        break;
      default:
        break;
    }
  }
  return out.join("");
}
