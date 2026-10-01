import { LINE_COLORS } from "./lineColors";
import { LINE_TYPES, LINE_TYPE_LABELS, type LineType } from "./types";

/** A region type the editor can draw and color. The id is stable; the name and color can change. */
export type RegionKind = {
  id: string;
  label: string;
  color: string;
};

const KIND_ID = /^[\x21-\x7e]{1,24}$/;
const MAX_KINDS = 40;
const MAX_COLOR_KEYS = 80;

export function isRegionKindId(id: string): boolean {
  return KIND_ID.test(id);
}

export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
  return match ? `#${match[1].toLowerCase()}` : null;
}

export function builtinRegionKinds(): RegionKind[] {
  return LINE_TYPES.map((id) => ({
    id,
    label: LINE_TYPE_LABELS[id],
    color: LINE_COLORS[id],
  }));
}

/** Accept a series-defined list, or throw when the payload is present but unusable. */
export function normalizeRegionKinds(value: unknown): RegionKind[] {
  if (!Array.isArray(value) || !value.length)
    throw new Error("Add at least one region type");
  if (value.length > MAX_KINDS)
    throw new Error(`A series can have at most ${MAX_KINDS} region types`);
  const out: RegionKind[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object")
      throw new Error("Each region type needs an id, a name, and a color");
    const rec = item as { id?: unknown; label?: unknown; color?: unknown };
    const id = String(rec.id ?? "").trim();
    const label = String(rec.label ?? "").trim();
    const color = normalizeHex(rec.color);
    if (!isRegionKindId(id) || !label || label.length > 40 || !color || seen.has(id))
      throw new Error("Each region type needs a unique id, a name, and a color");
    seen.add(id);
    out.push({ id, label, color });
  }
  return out;
}

/** Missing or unreadable series data uses the built-in types. */
export function activeRegionKinds(value: unknown): RegionKind[] {
  if (value == null) return builtinRegionKinds();
  try {
    return normalizeRegionKinds(value);
  } catch {
    return builtinRegionKinds();
  }
}

export function parseColorMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, color] of Object.entries(value as Record<string, unknown>)) {
    const hex = normalizeHex(color);
    if (!isRegionKindId(id) || !hex) continue;
    out[id] = hex;
    if (Object.keys(out).length >= MAX_COLOR_KEYS) break;
  }
  return out;
}

export function regionColor(
  id: string,
  kinds: RegionKind[],
  userColors: Record<string, string> = {},
): string {
  return userColors[id]
    || kinds.find((kind) => kind.id === id)?.color
    || builtinRegionKinds().find((kind) => kind.id === id)?.color
    || LINE_COLORS.plain;
}

export function regionKindLabel(id: string, kinds: RegionKind[]): string {
  return kinds.find((kind) => kind.id === id)?.label
    || LINE_TYPE_LABELS[id as LineType]
    || id;
}

export function isBuiltinRegionKind(id: string): boolean {
  return (LINE_TYPES as readonly string[]).includes(id);
}

/** Keep a removed type in menus so existing regions can still be labeled. */
export function regionKindOptions(kinds: RegionKind[], currentId?: string): RegionKind[] {
  return regionKindUsage(kinds, currentId ? [currentId] : []);
}

/**
 * The series list plus any id still used by saved regions. A type the series
 * removed keeps its label, color, and menu entry so old regions stay readable
 * and the owner can still recolor them.
 */
export function regionKindUsage(kinds: RegionKind[], usedIds: string[]): RegionKind[] {
  const extra = [...new Set(usedIds)]
    .filter((id) => id && isRegionKindId(id) && !kinds.some((kind) => kind.id === id))
    .sort();
  if (!extra.length) return kinds;
  return [
    ...kinds,
    ...extra.map((id) => ({
      id,
      label: regionKindLabel(id, kinds),
      color: regionColor(id, kinds),
    })),
  ];
}
