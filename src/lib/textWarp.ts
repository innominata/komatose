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
  style: Pick<TextStyle, "warpStyle" | "warpBend" | "warpHorizontal" | "warpVertical">,
): boolean {
  return (
    !!style.warpStyle &&
    style.warpStyle !== "none" &&
    (Math.abs(style.warpBend ?? 0) > 0.01 ||
      Math.abs(style.warpHorizontal ?? 0) > 0.01 ||
      Math.abs(style.warpVertical ?? 0) > 0.01)
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
 * (ag-psd `warp.value`), the distortions are `warpPerspective` / `warpPerspectiveOther`.
 * Type on a Path (`textPath`) is read-only in ag-psd, so path text exports as pixels.
 */
export function psdTextWarp(style: TextStyle):
  | {
      style: TextWarpStyle;
      value: number;
      perspective: number;
      perspectiveOther: number;
      rotate: "horizontal" | "vertical";
    }
  | undefined {
  if (!hasTextWarp(style) || !isTextWarpStyle(style.warpStyle)) return;
  return {
    style: style.warpStyle,
    value: style.warpBend,
    perspective: style.warpHorizontal ?? 0,
    perspectiveOther: style.warpVertical ?? 0,
    rotate: style.warpOrientation === "vertical" ? "vertical" : "horizontal",
  };
}

type WarpFields = Pick<TextStyle, "warpStyle" | "warpBend" | "warpHorizontal" | "warpVertical" | "warpOrientation">;

/** Extra raster margin so a strong bend is not clipped in the composite/PNG. */
export function warpPad(style: WarpFields, regionW: number, regionH: number): number {
  if (!hasTextWarp(style)) return 0;
  const amount = Math.min(
    2,
    Math.abs(style.warpBend) / 100 +
      Math.abs(style.warpHorizontal ?? 0) / 200 +
      Math.abs(style.warpVertical ?? 0) / 200,
  );
  return Math.ceil(Math.max(regionW, regionH) * 0.5 * amount);
}

// ── Warp styles ──────────────────────────────────────────────────────────
// Each of Photoshop's fifteen presets is one bicubic Bezier patch over the text box. The
// control grids are ported from PhotoCraft (github.com/storytold/photocraft,
// crates/geom/src/warp.rs, MIT/Apache-2.0), which fitted them to Photoshop's own renders, so
// the preview here matches what Photoshop draws for the exported Warp Text.

type Grid = [number, number][][];

function restGrid(): Grid {
  return Array.from({ length: 4 }, (_, j) => Array.from({ length: 4 }, (_, i) => [i / 3, j / 3] as [number, number]));
}

/** A horizontal edge at height `y` bent into a circular arc of |b|·π keeping its chord; `h` is height / width. */
function edgeArc(y: number, b: number, up: boolean, h: number): [number, number][] {
  if (Math.abs(b) < 1e-9) return [0, 1, 2, 3].map((i) => [i / 3, y]);
  const th = Math.abs(b) * Math.PI;
  const k = ((4 / 3) * Math.tan(th / 4) * 0.5) / Math.sin(th / 2);
  const s = b > 0 === up ? -1 : 1;
  const c = Math.cos(th / 2);
  const n = Math.sin(th / 2);
  const dy = (s * k * n) / h;
  return [[0, y], [k * c, y + dy], [1 - k * c, y + dy], [1, y]];
}

/** Arc: every row is a circular arc around one centre; the inner edge keeps its chord. */
function arcGrid(b: number, h: number): Grid {
  if (Math.abs(b) < 1e-9) return restGrid();
  const up = b > 0;
  const th = Math.abs(b) * Math.PI;
  const r = 0.5 / Math.sin(th / 2);
  const k = (4 / 3) * Math.tan(th / 4);
  const s = up ? -1 : 1;
  const cy = up ? h + r * Math.cos(th / 2) : -r * Math.cos(th / 2);
  return Array.from({ length: 4 }, (_, j) => {
    const v = j / 3;
    const big = r + h * (up ? 1 - v : v);
    const at = (a: number): [number, number] => [0.5 + big * Math.sin(a), cy + s * big * Math.cos(a)];
    const tangent = (a: number): [number, number] => [Math.cos(a), -s * Math.sin(a)];
    const p0 = at(-th / 2), p3 = at(th / 2), t0 = tangent(-th / 2), t1 = tangent(th / 2);
    const l = k * big;
    const pts: [number, number][] = [p0, [p0[0] + l * t0[0], p0[1] + l * t0[1]], [p3[0] - l * t1[0], p3[1] - l * t1[1]], p3];
    return pts.map(([x, y]) => [x, y / h] as [number, number]);
  });
}

function blendRows(top: [number, number][], bottom: [number, number][]): Grid {
  return Array.from({ length: 4 }, (_, j) => {
    const t = j / 3;
    return top.map((p, i) => [p[0] + (bottom[i][0] - p[0]) * t, p[1] + (bottom[i][1] - p[1]) * t] as [number, number]);
  });
}

/** `b`, `hd`, `vd` are −1…1; `aspect` is the box height over its width. */
function presetGrid(style: TextWarpStyle, b: number, hd: number, vd: number, vertical: boolean, aspect: number): Grid {
  const h = vertical ? 1 / aspect : aspect;
  if (vertical) [hd, vd] = [vd, hd];
  let g = restGrid();
  const inner: [number, number, number, number][] = [[1, 1, -1, -1], [1, 2, 1, -1], [2, 1, -1, 1], [2, 2, 1, 1]];
  switch (style) {
    case "arc": g = arcGrid(b, h); break;
    case "arch": g = [0, 1, 2, 3].map((j) => edgeArc(j / 3, b, true, h)); break;
    case "bulge": g = blendRows(edgeArc(0, b, true, h), edgeArc(1, b, false, h)); break;
    case "arcLower": g = blendRows(g[0], edgeArc(1, b, false, h)); break;
    case "arcUpper": g = blendRows(edgeArc(0, b, true, h), g[3]); break;
    case "shellLower": {
      const a = arcGrid(-b, h);
      g[3] = a[3]; g[2][0] = a[2][0]; g[2][3] = a[2][3];
      break;
    }
    case "shellUpper": {
      const a = arcGrid(b, h);
      g[0] = a[0]; g[1][0] = a[1][0]; g[1][3] = a[1][3];
      break;
    }
    case "flag": for (const row of g) { row[1][1] -= 2 * b; row[2][1] += 2 * b; } break;
    case "wave": for (const row of g.slice(1, 3)) { row[1][1] += (4 / 3) * b; row[2][1] -= (4 / 3) * b; } break;
    case "fish": [-2, -2 / 3, 2 / 3, 2].forEach((f, j) => { g[j][1][1] += f * b; g[j][2][1] -= f * b; }); break;
    case "rise": for (const row of g) { row[0][1] += 2 * b; row[1][1] += 2 * b; } break;
    case "fisheye":
      for (const [j, i, dx, dy] of inner) { g[j][i][0] += (dx * 2 / 3) * b; g[j][i][1] += (dy * 2 / 3) * b; }
      break;
    case "inflate":
    case "squeeze": {
      const s = style === "inflate" ? 1 : -1;
      for (const p of g[0].slice(1, 3)) p[1] -= b / 3;
      for (const p of g[3].slice(1, 3)) p[1] += b / 3;
      for (const row of g.slice(1, 3)) { row[0][0] -= (s * b) / 3; row[3][0] += (s * b) / 3; }
      for (const [j, i, dx, dy] of inner) { g[j][i][0] += (s * dx * b) / 9; g[j][i][1] += (dy * b) / 9; }
      break;
    }
    case "twist": {
      const a = Math.abs(b);
      if (b >= 0) { g[1][1][0] += a; g[1][2][1] += a; g[2][1][1] -= a; g[2][2][0] -= a; }
      else { g[1][1][1] += a; g[1][2][0] -= a; g[2][1][0] += a; g[2][2][1] -= a; }
      break;
    }
    default: break;
  }
  if (vd) {
    const moved = (row: [number, number][], s: number) => {
      const m = [(row[0][0] + row[3][0]) / 2, (row[0][1] + row[3][1]) / 2];
      return row.map((p) => [m[0] + (p[0] - m[0]) * s - p[0], m[1] + (p[1] - m[1]) * s - p[1]]);
    };
    const d0 = moved(g[0], 1 - vd), d3 = moved(g[3], 1 + vd);
    g.forEach((row, j) => {
      const t = j / 3;
      row.forEach((p, i) => { p[0] += d0[i][0] + (d3[i][0] - d0[i][0]) * t; p[1] += d0[i][1] + (d3[i][1] - d0[i][1]) * t; });
    });
  }
  if (hd) {
    for (let i = 0; i < 4; i++) {
      const s = 1 + hd * ((2 * i) / 3 - 1);
      const m = [(g[0][i][0] + g[3][i][0]) / 2, (g[0][i][1] + g[3][i][1]) / 2];
      for (const row of g) row[i] = [m[0] + (row[i][0] - m[0]) * s, m[1] + (row[i][1] - m[1]) * s];
    }
  }
  if (vertical) g = Array.from({ length: 4 }, (_, j) => Array.from({ length: 4 }, (_, i) => [g[i][j][1], g[i][j][0]] as [number, number]));
  return g;
}

const bernstein = (t: number) => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

export type PointMap = (x: number, y: number) => { x: number; y: number };

/** The Warp Text map of `box` for `style`, or undefined when the style leaves text unchanged. */
export function textWarpMap(box: WarpBox, style: WarpFields): PointMap | undefined {
  if (!hasTextWarp(style) || !isTextWarpStyle(style.warpStyle)) return;
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  if (!(w > 1e-6 && h > 1e-6)) return;
  const pct = (v: number | undefined) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, (v as number) / 100)) : 0);
  const grid = presetGrid(style.warpStyle, pct(style.warpBend), pct(style.warpHorizontal), pct(style.warpVertical), style.warpOrientation === "vertical", h / w);
  return (x, y) => {
    const bu = bernstein((x - box.left) / w);
    const bv = bernstein((y - box.top) / h);
    let px = 0, py = 0;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const k = bu[i] * bv[j];
        px += k * grid[j][i][0];
        py += k * grid[j][i][1];
      }
    return { x: box.left + px * w, y: box.top + py * h };
  };
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

/** Photoshop Type → Warp Text position of one point in the unrotated text box. */
export function warpPoint(x: number, y: number, box: WarpBox, style: WarpFields): { x: number; y: number } {
  return textWarpMap(box, style)?.(x, y) ?? { x, y };
}

/** Font units → page pixels for one glyph: origin, scale, horizontal/vertical scale and italic slant. */
export function glyphToPage(
  originX: number,
  originY: number,
  scale: number,
  italic: boolean,
  horizontalScale = 1,
  verticalScale = 1,
): PointMap {
  return (fx, fy) => ({
    x: originX + (fx * horizontalScale + (italic ? fy * verticalScale * ITALIC_SKEW : 0)) * scale,
    y: originY - fy * verticalScale * scale,
  });
}

/**
 * Map a fontkit glyph outline through `toPage` and then `warp`. Curves are sampled so the
 * warped result is a polyline that follows the mesh.
 */
export function warpFontPath(
  commands: readonly FontPathCommand[],
  toPage: PointMap,
  warp: PointMap,
): string {
  const map = (fx: number, fy: number) => {
    const page = toPage(fx, fy);
    return warp(page.x, page.y);
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
