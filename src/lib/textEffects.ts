/**
 * Layer styles for text regions, as Photoshop's Layer Style dialog has them: drop and inner
 * shadow, outer and inner glow, satin, colour and gradient overlay, and bevel & emboss (the
 * region's outline is the Stroke). The model and the rendering follow PhotoCraft
 * (github.com/storytold/photocraft, crates/doc/src/effects.rs and crates/compose/src/effects,
 * MIT/Apache-2.0), whose constants were measured against Photoshop:
 *
 * - an effect lit from `angle` falls `distance` away from the light: dx = −cos·d, dy = sin·d
 *   (y down), rounded to whole pixels;
 * - spread / choke grows the shape by `size × spread` and blurs the rest, `size × (1 − spread)`;
 * - the blur of an effect of `size` px is two box passes of that width, a Gaussian of
 *   σ ≈ size / √6;
 * - a glow's coverage goes through its Range: min(v / range, 1), 50 % by default;
 * - stacking: drop shadow, outer glow, then the text with colour/gradient overlay, satin,
 *   inner glow, inner shadow, and bevel highlights and shadows on top.
 *
 * Rendering is SVG filters in page space, so the preview (the browser) and the exports
 * (librsvg) draw the same thing. Effects composite normally inside the lettering layer; PSD
 * export writes them as real Photoshop layer effects with their blend modes.
 * Sizes and distances are in points, like the outline, so they scale with the page DPI.
 */

export type EffectBlend = "normal" | "multiply" | "screen" | "overlay" | "soft light" | "color dodge" | "color burn" | "linear dodge" | "darken" | "lighten";
export const EFFECT_BLENDS: EffectBlend[] = ["normal", "multiply", "screen", "overlay", "soft light", "color dodge", "color burn", "linear dodge", "darken", "lighten"];

type Common = { enabled: boolean; color: string; opacity: number; blend: EffectBlend };
export type ShadowEffect = Common & { angle: number; distance: number; spread: number; size: number };
export type GlowEffect = Common & { spread: number; size: number; range: number };
export type InnerGlowEffect = GlowEffect & { source: "edge" | "center" };
export type SatinEffect = Common & { angle: number; distance: number; size: number; invert: boolean };
export type OverlayEffect = Common;
export type GradientStop = { color: string; location: number };
export type GradientEffect = Omit<Common, "color"> & {
  stops: GradientStop[];
  angle: number;
  style: "linear" | "radial" | "reflected";
  reverse: boolean;
  scale: number;
};
export type BevelEffect = {
  enabled: boolean;
  style: "inner bevel" | "outer bevel" | "emboss" | "pillow emboss";
  depth: number;
  direction: "up" | "down";
  size: number;
  soften: number;
  angle: number;
  altitude: number;
  highlightColor: string;
  highlightOpacity: number;
  highlightBlend: EffectBlend;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlend: EffectBlend;
};

export type TextEffects = {
  dropShadow?: ShadowEffect;
  innerShadow?: ShadowEffect;
  outerGlow?: GlowEffect;
  innerGlow?: InnerGlowEffect;
  satin?: SatinEffect;
  colorOverlay?: OverlayEffect;
  gradientOverlay?: GradientEffect;
  bevel?: BevelEffect;
};
export type EffectKind = keyof TextEffects;

/** Photoshop's defaults for each effect, as its Layer Style dialog opens them. */
export const EFFECT_DEFAULTS: { [K in EffectKind]-?: NonNullable<TextEffects[K]> } = {
  dropShadow: { enabled: true, color: "#000000", opacity: 75, blend: "multiply", angle: 120, distance: 4, spread: 0, size: 4 },
  innerShadow: { enabled: true, color: "#000000", opacity: 75, blend: "multiply", angle: 120, distance: 3, spread: 0, size: 4 },
  outerGlow: { enabled: true, color: "#ffffbe", opacity: 75, blend: "screen", spread: 0, size: 5, range: 50 },
  innerGlow: { enabled: true, color: "#ffffbe", opacity: 75, blend: "screen", spread: 0, size: 5, range: 50, source: "edge" },
  satin: { enabled: true, color: "#000000", opacity: 50, blend: "multiply", angle: 19, distance: 7, size: 9, invert: true },
  colorOverlay: { enabled: true, color: "#ff0000", opacity: 100, blend: "normal" },
  gradientOverlay: {
    enabled: true, opacity: 100, blend: "normal", angle: 90, style: "linear", reverse: false, scale: 100,
    stops: [{ color: "#000000", location: 0 }, { color: "#ffffff", location: 100 }],
  },
  bevel: {
    enabled: true, style: "inner bevel", depth: 100, direction: "up", size: 3, soften: 0, angle: 120, altitude: 30,
    highlightColor: "#ffffff", highlightOpacity: 75, highlightBlend: "screen",
    shadowColor: "#000000", shadowOpacity: 75, shadowBlend: "multiply",
  },
};

export const EFFECT_LABELS: Record<EffectKind, string> = {
  bevel: "Bevel & Emboss",
  innerShadow: "Inner Shadow",
  innerGlow: "Inner Glow",
  satin: "Satin",
  colorOverlay: "Color Overlay",
  gradientOverlay: "Gradient Overlay",
  outerGlow: "Outer Glow",
  dropShadow: "Drop Shadow",
};
/** Photoshop's Layer Style list order. */
export const EFFECT_ORDER: EffectKind[] = ["bevel", "innerShadow", "innerGlow", "satin", "colorOverlay", "gradientOverlay", "outerGlow", "dropShadow"];

const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[a-f\d]{6}$/i.test(v) ? v.toLowerCase() : fallback);
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);

/** Valid effects only: unknown kinds dropped, every value clamped to the dialog's range. */
export function normalizeEffects(input: unknown): TextEffects | undefined {
  if (!input || typeof input !== "object") return;
  const rec = input as Record<string, Record<string, unknown> | undefined>;
  const out: TextEffects = {};
  const common = (e: Record<string, unknown>, d: Common): Common => ({
    enabled: e.enabled !== false,
    color: color(e.color, d.color),
    opacity: clamp(e.opacity, 0, 100, d.opacity),
    blend: pick(e.blend, EFFECT_BLENDS, d.blend),
  });
  for (const kind of ["dropShadow", "innerShadow"] as const) {
    const e = rec[kind];
    if (!e || typeof e !== "object") continue;
    const d = EFFECT_DEFAULTS[kind];
    out[kind] = {
      ...common(e, d),
      angle: clamp(e.angle, -360, 360, d.angle),
      distance: clamp(e.distance, 0, 300, d.distance),
      spread: clamp(e.spread, 0, 100, d.spread),
      size: clamp(e.size, 0, 250, d.size),
    };
  }
  for (const kind of ["outerGlow", "innerGlow"] as const) {
    const e = rec[kind];
    if (!e || typeof e !== "object") continue;
    const d = EFFECT_DEFAULTS[kind];
    const glow: GlowEffect = { ...common(e, d), spread: clamp(e.spread, 0, 100, d.spread), size: clamp(e.size, 0, 250, d.size), range: clamp(e.range, 1, 100, d.range) };
    if (kind === "innerGlow") out.innerGlow = { ...glow, source: pick(e.source, ["edge", "center"] as const, "edge") };
    else out.outerGlow = glow;
  }
  if (rec.satin && typeof rec.satin === "object") {
    const e = rec.satin, d = EFFECT_DEFAULTS.satin;
    out.satin = { ...common(e, d), angle: clamp(e.angle, -360, 360, d.angle), distance: clamp(e.distance, 1, 250, d.distance), size: clamp(e.size, 0, 250, d.size), invert: e.invert !== false };
  }
  if (rec.colorOverlay && typeof rec.colorOverlay === "object") out.colorOverlay = common(rec.colorOverlay, EFFECT_DEFAULTS.colorOverlay);
  if (rec.gradientOverlay && typeof rec.gradientOverlay === "object") {
    const e = rec.gradientOverlay, d = EFFECT_DEFAULTS.gradientOverlay;
    const stops = Array.isArray(e.stops)
      ? (e.stops as Record<string, unknown>[])
          .filter((s) => s && typeof s === "object")
          .slice(0, 16)
          .map((s) => ({ color: color(s.color, "#000000"), location: clamp(s.location, 0, 100, 0) }))
          .sort((a, b) => a.location - b.location)
      : [];
    out.gradientOverlay = {
      enabled: e.enabled !== false,
      opacity: clamp(e.opacity, 0, 100, d.opacity),
      blend: pick(e.blend, EFFECT_BLENDS, d.blend),
      stops: stops.length >= 2 ? stops : d.stops,
      angle: clamp(e.angle, -360, 360, d.angle),
      style: pick(e.style, ["linear", "radial", "reflected"] as const, d.style),
      reverse: e.reverse === true,
      scale: clamp(e.scale, 10, 150, d.scale),
    };
  }
  if (rec.bevel && typeof rec.bevel === "object") {
    const e = rec.bevel, d = EFFECT_DEFAULTS.bevel;
    out.bevel = {
      enabled: e.enabled !== false,
      style: pick(e.style, ["inner bevel", "outer bevel", "emboss", "pillow emboss"] as const, d.style),
      depth: clamp(e.depth, 1, 1000, d.depth),
      direction: pick(e.direction, ["up", "down"] as const, d.direction),
      size: clamp(e.size, 0, 250, d.size),
      soften: clamp(e.soften, 0, 16, d.soften),
      angle: clamp(e.angle, -360, 360, d.angle),
      altitude: clamp(e.altitude, 0, 90, d.altitude),
      highlightColor: color(e.highlightColor, d.highlightColor),
      highlightOpacity: clamp(e.highlightOpacity, 0, 100, d.highlightOpacity),
      highlightBlend: pick(e.highlightBlend, EFFECT_BLENDS, d.highlightBlend),
      shadowColor: color(e.shadowColor, d.shadowColor),
      shadowOpacity: clamp(e.shadowOpacity, 0, 100, d.shadowOpacity),
      shadowBlend: pick(e.shadowBlend, EFFECT_BLENDS, d.shadowBlend),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

export function activeEffects(effects: TextEffects | undefined): TextEffects {
  const out: TextEffects = {};
  for (const kind of EFFECT_ORDER) if (effects?.[kind]?.enabled) (out as Record<string, unknown>)[kind] = effects[kind];
  return out;
}

/** How far outside the glyphs the effects reach, in points (for raster margins). */
export function effectsReach(effects: TextEffects | undefined): number {
  const e = activeEffects(effects);
  return Math.max(
    0,
    e.dropShadow ? e.dropShadow.distance + e.dropShadow.size * 1.5 : 0,
    e.outerGlow ? e.outerGlow.size * 1.5 : 0,
    e.bevel && e.bevel.style !== "inner bevel" ? e.bevel.size * 1.5 : 0,
  );
}

/** Light offset: an effect lit from `angle` falls `distance` away from it (whole pixels). */
const offset = (angle: number, distance: number) => {
  const a = (angle * Math.PI) / 180;
  return { dx: Math.round(-Math.cos(a) * distance), dy: Math.round(Math.sin(a) * distance) };
};
const sigma = (size: number) => Math.max(0, size) / Math.sqrt(6);
const f = (n: number) => String(Math.round(n * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export type FxRect = { x: number; y: number; width: number; height: number };

/**
 * SVG filters for `effects` at `px` pixels per point, over `rect` (page space): `exterior`
 * draws only what lies behind the text (shadow, glow, outer bevel); `interior` takes the text
 * and returns it with its interior effects; `overlay` (a gradient overlay) is drawn over the
 * text inside the interior group, before the filter.
 */
export function effectFilters(effects: TextEffects | undefined, px: number, rect: FxRect, bounds: FxRect, fillRef = "#tx-f") {
  const e = activeEffects(effects);
  const region = `filterUnits="userSpaceOnUse" x="${f(rect.x)}" y="${f(rect.y)}" width="${f(rect.width)}" height="${f(rect.height)}" color-interpolation-filters="sRGB"`;
  const ext: string[] = [];
  const extOut: string[] = [];
  const int: string[] = [];
  let cur = "SourceGraphic";
  let n = 0;
  const id = (p: string) => `${p}${n++}`;
  /** `alpha` grown by `r` px, then blurred to `size` px. */
  const soft = (alpha: string, r: number, size: number, out: string[]) => {
    let at = alpha;
    if (r >= 0.5) {
      const d = id("d");
      out.push(`<feMorphology in="${at}" operator="dilate" radius="${f(r)}" result="${d}"/>`);
      at = d;
    }
    if (size > 0.01) {
      const b = id("b");
      out.push(`<feGaussianBlur in="${at}" stdDeviation="${f(sigma(size))}" result="${b}"/>`);
      at = b;
    }
    return at;
  };
  const paint = (mask: string, hex: string, opacity: number, out: string[]) => {
    const fl = id("f"), p = id("p");
    out.push(`<feFlood flood-color="${hex}" flood-opacity="${f(opacity / 100)}" result="${fl}"/>`);
    out.push(`<feComposite in="${fl}" in2="${mask}" operator="in" result="${p}"/>`);
    return p;
  };
  const over = (top: string) => {
    const m = id("m");
    int.push(`<feComposite in="${top}" in2="${cur}" operator="over" result="${m}"/>`);
    cur = m;
  };
  const inside = (mask: string) => {
    const k = id("k");
    int.push(`<feComposite in="${mask}" in2="SourceAlpha" operator="in" result="${k}"/>`);
    return k;
  };
  const invertAlpha = (out: string[]) => {
    const i = id("i");
    out.push(`<feComponentTransfer in="SourceAlpha" result="${i}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
    return i;
  };
  const ranged = (at: string, range: number, out: string[]) => {
    const r = id("r");
    out.push(`<feComponentTransfer in="${at}" result="${r}"><feFuncA type="linear" slope="${f(100 / range)}" intercept="0"/></feComponentTransfer>`);
    return r;
  };

  // Behind the text: drop shadow, then outer glow above it.
  if (e.dropShadow) {
    const s = e.dropShadow, size = s.size * px, { dx, dy } = offset(s.angle, s.distance * px);
    const o = id("o");
    ext.push(`<feOffset in="SourceAlpha" dx="${dx}" dy="${dy}" result="${o}"/>`);
    extOut.push(paint(soft(o, size * (s.spread / 100), size * (1 - s.spread / 100), ext), s.color, s.opacity, ext));
  }
  if (e.outerGlow) {
    const g = e.outerGlow, size = g.size * px;
    extOut.push(paint(ranged(soft("SourceAlpha", size * (g.spread / 100), size * (1 - g.spread / 100), ext), g.range, ext), g.color, g.opacity, ext));
  }

  // On the text, in Photoshop's order.
  // The gradient overlay is painted, not filtered (librsvg runs no feImage of inline SVG): a
  // rect of the gradient masked to the glyphs, drawn into the interior filter's source.
  let overlay = "";
  let overlayDefs = "";
  if (e.gradientOverlay) {
    const g = e.gradientOverlay;
    const stops = (g.reverse ? [...g.stops].reverse().map((s) => ({ ...s, location: 100 - s.location })) : g.stops)
      .map((s) => `<stop offset="${f(s.location / 100)}" stop-color="${s.color}"/>`)
      .join("");
    const a = (g.angle * Math.PI) / 180;
    const k = g.scale / 100;
    // Photoshop spans the layer bounds' chord along the angle; y runs up at 90°.
    const half = ((Math.abs(Math.cos(a)) * bounds.width + Math.abs(Math.sin(a)) * bounds.height) / 2) * k;
    const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
    const grad =
      g.style === "radial"
        ? `<radialGradient id="fx-grad" gradientUnits="userSpaceOnUse" cx="${f(cx)}" cy="${f(cy)}" r="${f(Math.max(1, (Math.hypot(bounds.width, bounds.height) / 2) * k))}">${stops}</radialGradient>`
        : g.style === "reflected"
          ? `<linearGradient id="fx-grad" gradientUnits="userSpaceOnUse" x1="${f(cx)}" y1="${f(cy)}" x2="${f(cx + Math.cos(a) * half)}" y2="${f(cy - Math.sin(a) * half)}" spreadMethod="reflect">${stops}</linearGradient>`
          : `<linearGradient id="fx-grad" gradientUnits="userSpaceOnUse" x1="${f(cx - Math.cos(a) * half)}" y1="${f(cy + Math.sin(a) * half)}" x2="${f(cx + Math.cos(a) * half)}" y2="${f(cy - Math.sin(a) * half)}">${stops}</linearGradient>`;
    overlayDefs =
      grad +
      `<filter id="fx-white" ${region}><feFlood flood-color="#ffffff" result="w"/><feComposite in="w" in2="SourceAlpha" operator="in"/></filter>` +
      `<mask id="fx-gmask" maskUnits="userSpaceOnUse" x="${f(rect.x)}" y="${f(rect.y)}" width="${f(rect.width)}" height="${f(rect.height)}"><use href="${fillRef}" filter="url(#fx-white)"/></mask>`;
    overlay = `<rect x="${f(rect.x)}" y="${f(rect.y)}" width="${f(rect.width)}" height="${f(rect.height)}" fill="url(#fx-grad)" opacity="${f(g.opacity / 100)}" mask="url(#fx-gmask)"/>`;
  }
  if (e.colorOverlay) over(paint("SourceAlpha", e.colorOverlay.color, e.colorOverlay.opacity, int));
  if (e.satin) {
    // Two copies of the shape offset each way along the angle, blurred: their difference.
    const s = e.satin, { dx, dy } = offset(s.angle, s.distance * px);
    const a = id("a"), b = id("b"), ab = id("x"), ba = id("y"), diff = id("z");
    int.push(`<feOffset in="SourceAlpha" dx="${dx}" dy="${dy}" result="${a}"/>`);
    int.push(`<feOffset in="SourceAlpha" dx="${-dx}" dy="${-dy}" result="${b}"/>`);
    const sa = soft(a, 0, s.size * px, int), sb = soft(b, 0, s.size * px, int);
    int.push(`<feComposite in="${sa}" in2="${sb}" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0" result="${ab}"/>`);
    int.push(`<feComposite in="${sb}" in2="${sa}" operator="arithmetic" k1="0" k2="1" k3="-1" k4="0" result="${ba}"/>`);
    int.push(`<feComposite in="${ab}" in2="${ba}" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${diff}"/>`);
    let mask = diff;
    if (s.invert) {
      mask = id("v");
      int.push(`<feComponentTransfer in="${diff}" result="${mask}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
    }
    over(inside(paint(mask, s.color, s.opacity, int)));
  }
  if (e.innerGlow) {
    const g = e.innerGlow, size = g.size * px;
    let m = ranged(soft(invertAlpha(int), size * (g.spread / 100), size * (1 - g.spread / 100), int), g.range, int);
    if (g.source === "center") {
      const c = id("c");
      int.push(`<feComponentTransfer in="${m}" result="${c}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
      m = c;
    }
    over(inside(paint(m, g.color, g.opacity, int)));
  }
  if (e.innerShadow) {
    const s = e.innerShadow, size = s.size * px, { dx, dy } = offset(s.angle, s.distance * px);
    const o = id("o");
    int.push(`<feOffset in="${invertAlpha(int)}" dx="${dx}" dy="${dy}" result="${o}"/>`);
    over(inside(paint(soft(o, size * (s.spread / 100), size * (1 - s.spread / 100), int), s.color, s.opacity, int)));
  }
  if (e.bevel) {
    // Height from the blurred shape, lit from the light; brighter than a flat surface is
    // highlight, darker is shadow. The style picks where the bevel sits.
    const b = e.bevel, size = Math.max(0.5, b.size * px);
    const flat = Math.sin((b.altitude * Math.PI) / 180);
    const lit = (out: string[]) => {
      const h = soft("SourceAlpha", 0, size * (b.style === "inner bevel" ? 1.2 : 2), out), l = id("l");
      const azimuth = -b.angle;
      out.push(`<feDiffuseLighting in="${h}" surfaceScale="${f((size * b.depth) / 100 * (b.direction === "down" ? -1 : 1))}" diffuseConstant="1" lighting-color="#ffffff" result="${l}"><feDistantLight azimuth="${f(azimuth)}" elevation="${f(b.altitude)}"/></feDiffuseLighting>`);
      let at = l;
      if (b.soften > 0) at = soft(l, 0, b.soften * px, out);
      const hi = id("h"), sh = id("s");
      // Light above the flat level → highlight coverage; below it → shadow coverage.
      out.push(`<feColorMatrix in="${at}" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${f(2 / (1 - flat + 0.05))} 0 0 0 ${f((-2 * flat) / (1 - flat + 0.05))}" result="${hi}"/>`);
      out.push(`<feColorMatrix in="${at}" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  ${f(-2 / (flat + 0.05))} 0 0 0 ${f((2 * flat) / (flat + 0.05))}" result="${sh}"/>`);
      return { hi: paint(hi, b.highlightColor, b.highlightOpacity, out), sh: paint(sh, b.shadowColor, b.shadowOpacity, out) };
    };
    if (b.style === "inner bevel" || b.style === "emboss") {
      const { hi, sh } = lit(int);
      over(inside(sh));
      over(inside(hi));
    }
    if (b.style !== "inner bevel") {
      // Outside the shape: outer bevel and both emboss styles light the rim behind the text.
      const { hi, sh } = lit(ext);
      // Only the rim within the bevel's size of the text, never the flat canvas beyond it.
      const rimBlur = soft("SourceAlpha", 0, size * 2, ext), rim = id("w");
      ext.push(`<feComponentTransfer in="${rimBlur}" result="${rim}"><feFuncA type="linear" slope="4"/></feComponentTransfer>`);
      for (const p of b.style === "pillow emboss" ? [hi, sh] : [sh, hi]) {
        const o = id("q"), r = id("u");
        ext.push(`<feComposite in="${p}" in2="SourceAlpha" operator="out" result="${o}"/>`);
        ext.push(`<feComposite in="${o}" in2="${rim}" operator="in" result="${r}"/>`);
        extOut.push(r);
      }
      if (b.style === "pillow emboss") {
        const { hi: h2, sh: s2 } = lit(int);
        over(inside(h2));
        over(inside(s2));
      }
    }
  }

  const exterior = extOut.length
    ? `<filter id="fx-ext" ${region}>${ext.join("")}<feMerge>${extOut.map((r) => `<feMergeNode in="${r}"/>`).join("")}</feMerge></filter>`
    : "";
  const interior = int.length ? `<filter id="fx-int" ${region}>${int.join("")}<feMerge><feMergeNode in="${cur}"/></feMerge></filter>` : "";
  return { defs: exterior + interior + overlayDefs, exterior: !!exterior, interior: !!interior, overlay };
}

// ── Photoshop (ag-psd) ───────────────────────────────────────────────

type Rgb = { r: number; g: number; b: number };
const rgb = (hex: string): Rgb => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) });
const toHex = (c: unknown, fallback: string) => {
  const v = c as Partial<Rgb> | undefined;
  return v && Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b)
    ? `#${[v.r!, v.g!, v.b!].map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0")).join("")}`
    : fallback;
};
const pxv = (pt: number, dpi: number) => ({ units: "Pixels" as const, value: Math.round(((pt * dpi) / 72) * 100) / 100 });
/** Spread / choke: Photoshop stores the percentage under pixel units (`Ckmt`). */
const pct = (v: number) => ({ units: "Pixels" as const, value: v });
const ptOf = (u: { value?: number } | undefined, dpi: number, fallback: number) => (u?.value !== undefined ? Math.round(((u.value * 72) / dpi) * 10) / 10 : fallback);

/** ag-psd layer effects for `effects`; Photoshop draws them from the layer's own pixels. */
export function psdEffects(effects: TextEffects | undefined, dpi: number) {
  const e = effects ?? {};
  const out: Record<string, unknown> = {};
  const shadow = (s: ShadowEffect) => ({
    present: true, showInDialog: true, enabled: s.enabled, color: rgb(s.color), opacity: s.opacity / 100, blendMode: s.blend,
    angle: s.angle, useGlobalLight: false, distance: pxv(s.distance, dpi), size: pxv(s.size, dpi), choke: pct(s.spread),
    antialiased: false, layerConceals: true,
  });
  if (e.dropShadow) out.dropShadow = [shadow(e.dropShadow)];
  if (e.innerShadow) out.innerShadow = [shadow(e.innerShadow)];
  if (e.outerGlow) {
    const g = e.outerGlow;
    out.outerGlow = { present: true, showInDialog: true, enabled: g.enabled, color: rgb(g.color), opacity: g.opacity / 100, blendMode: g.blend, size: pxv(g.size, dpi), choke: pct(g.spread), range: g.range / 100, noise: 0, jitter: 0, antialiased: false };
  }
  if (e.innerGlow) {
    const g = e.innerGlow;
    out.innerGlow = { present: true, showInDialog: true, enabled: g.enabled, color: rgb(g.color), opacity: g.opacity / 100, blendMode: g.blend, size: pxv(g.size, dpi), choke: pct(g.spread), range: g.range / 100, source: g.source, technique: "softer", noise: 0, jitter: 0, antialiased: false };
  }
  if (e.satin) {
    const s = e.satin;
    out.satin = { present: true, showInDialog: true, enabled: s.enabled, color: rgb(s.color), opacity: s.opacity / 100, blendMode: s.blend, angle: s.angle, distance: pxv(s.distance, dpi), size: pxv(s.size, dpi), invert: s.invert, antialiased: true };
  }
  if (e.colorOverlay) {
    const c = e.colorOverlay;
    out.solidFill = [{ present: true, showInDialog: true, enabled: c.enabled, color: rgb(c.color), opacity: c.opacity / 100, blendMode: c.blend }];
  }
  if (e.gradientOverlay) {
    const g = e.gradientOverlay;
    out.gradientOverlay = [{
      present: true, showInDialog: true, enabled: g.enabled, opacity: g.opacity / 100, blendMode: g.blend, align: true, scale: g.scale / 100,
      dither: false, reverse: g.reverse, type: g.style, angle: g.angle, offset: { x: 0, y: 0 },
      gradient: {
        name: "Custom", type: "solid", smoothness: 1,
        colorStops: g.stops.map((s) => ({ color: rgb(s.color), location: s.location / 100, midpoint: 0.5 })),
        opacityStops: [{ opacity: 1, location: 0, midpoint: 0.5 }, { opacity: 1, location: 1, midpoint: 0.5 }],
      },
    }];
  }
  if (e.bevel) {
    const b = e.bevel;
    out.bevel = {
      present: true, showInDialog: true, enabled: b.enabled, style: b.style, technique: "smooth", strength: b.depth, direction: b.direction,
      size: pxv(b.size, dpi), soften: pxv(b.soften, dpi), angle: b.angle, altitude: b.altitude, useGlobalLight: false,
      highlightColor: rgb(b.highlightColor), highlightOpacity: b.highlightOpacity / 100, highlightBlendMode: b.highlightBlend,
      shadowColor: rgb(b.shadowColor), shadowOpacity: b.shadowOpacity / 100, shadowBlendMode: b.shadowBlend,
      useTexture: false, useShape: false, antialiasGloss: false,
    };
  }
  return out;
}

/** Layer effects read from a PSD layer, as text effects (the stroke is read as the outline). */
export function effectsFromPsd(fx: Record<string, any> | undefined, dpi: number): TextEffects | undefined {
  if (!fx) return;
  const out: Record<string, unknown> = {};
  const blend = (v: unknown, d: EffectBlend) => pick(v, EFFECT_BLENDS, d);
  const shadow = (s: any, d: ShadowEffect): ShadowEffect => ({
    enabled: s.enabled !== false, color: toHex(s.color, d.color), opacity: Math.round((s.opacity ?? d.opacity / 100) * 100), blend: blend(s.blendMode, d.blend),
    angle: s.angle ?? d.angle, distance: ptOf(s.distance, dpi, d.distance), size: ptOf(s.size, dpi, d.size), spread: s.choke?.value ?? d.spread,
  });
  const first = (v: any) => (Array.isArray(v) ? v[0] : v);
  if (first(fx.dropShadow)) out.dropShadow = shadow(first(fx.dropShadow), EFFECT_DEFAULTS.dropShadow);
  if (first(fx.innerShadow)) out.innerShadow = shadow(first(fx.innerShadow), EFFECT_DEFAULTS.innerShadow);
  for (const kind of ["outerGlow", "innerGlow"] as const) {
    const g = fx[kind];
    if (!g) continue;
    const d = EFFECT_DEFAULTS[kind];
    out[kind] = {
      enabled: g.enabled !== false, color: toHex(g.color, d.color), opacity: Math.round((g.opacity ?? d.opacity / 100) * 100), blend: blend(g.blendMode, d.blend),
      size: ptOf(g.size, dpi, d.size), spread: g.choke?.value ?? d.spread, range: Math.round((g.range ?? 0.5) * 100),
      ...(kind === "innerGlow" ? { source: g.source === "center" ? "center" : "edge" } : {}),
    };
  }
  if (fx.satin) {
    const s = fx.satin, d = EFFECT_DEFAULTS.satin;
    out.satin = { enabled: s.enabled !== false, color: toHex(s.color, d.color), opacity: Math.round((s.opacity ?? 0.5) * 100), blend: blend(s.blendMode, d.blend), angle: s.angle ?? d.angle, distance: ptOf(s.distance, dpi, d.distance), size: ptOf(s.size, dpi, d.size), invert: s.invert !== false };
  }
  const fill = first(fx.solidFill);
  if (fill) out.colorOverlay = { enabled: fill.enabled !== false, color: toHex(fill.color, "#ff0000"), opacity: Math.round((fill.opacity ?? 1) * 100), blend: blend(fill.blendMode, "normal") };
  const grad = first(fx.gradientOverlay);
  if (grad?.gradient?.colorStops) {
    out.gradientOverlay = {
      enabled: grad.enabled !== false, opacity: Math.round((grad.opacity ?? 1) * 100), blend: blend(grad.blendMode, "normal"), angle: grad.angle ?? 90,
      style: grad.type === "radial" || grad.type === "reflected" ? grad.type : "linear", reverse: !!grad.reverse, scale: Math.round((grad.scale ?? 1) * 100),
      stops: grad.gradient.colorStops.map((s: any) => ({ color: toHex(s.color, "#000000"), location: Math.round((s.location ?? 0) * 100) })),
    };
  }
  if (fx.bevel) {
    const b = fx.bevel, d = EFFECT_DEFAULTS.bevel;
    out.bevel = {
      enabled: b.enabled !== false, style: b.style ?? d.style, depth: b.strength ?? d.depth, direction: b.direction ?? d.direction,
      size: ptOf(b.size, dpi, d.size), soften: ptOf(b.soften, dpi, d.soften), angle: b.angle ?? d.angle, altitude: b.altitude ?? d.altitude,
      highlightColor: toHex(b.highlightColor, d.highlightColor), highlightOpacity: Math.round((b.highlightOpacity ?? 0.75) * 100), highlightBlend: blend(b.highlightBlendMode, d.highlightBlend),
      shadowColor: toHex(b.shadowColor, d.shadowColor), shadowOpacity: Math.round((b.shadowOpacity ?? 0.75) * 100), shadowBlend: blend(b.shadowBlendMode, d.shadowBlend),
    };
  }
  return normalizeEffects(out);
}
