/** Categories a font can be filed under. Order here is the order dropdowns and the library show them. */
export const FONT_CATEGORIES = [
  { id: "lettering", label: "Lettering" },
  { id: "sfx", label: "Sfx" },
  { id: "overtext", label: "Overtext" },
  { id: "system", label: "System" },
  { id: "handwriting", label: "Handwriting" },
  { id: "other", label: "Other" },
] as const;

export type FontCategoryId = (typeof FONT_CATEGORIES)[number]["id"];

export const DEFAULT_FONT_CATEGORY: FontCategoryId = "other";

export function isFontCategory(value: unknown): value is FontCategoryId {
  return FONT_CATEGORIES.some((c) => c.id === value);
}

/** Unknown, missing or malformed values file under "other" so older fonts keep working. */
export function normalizeFontCategory(value: unknown): FontCategoryId {
  return isFontCategory(value) ? value : DEFAULT_FONT_CATEGORY;
}

export function fontCategoryLabel(value: unknown): string {
  const id = normalizeFontCategory(value);
  return FONT_CATEGORIES.find((c) => c.id === id)!.label;
}

type Grouped = { category?: string; familyName: string; subfamilyName: string };

export type FontGroup<T extends Grouped> = {
  id: FontCategoryId;
  label: string;
  fonts: T[];
};

/** Fonts grouped by category in the fixed category order, alphabetical inside a group; empty groups are dropped. */
export function groupFontsByCategory<T extends Grouped>(fonts: T[]): FontGroup<T>[] {
  const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
  const sorted = [...fonts].sort(
    (a, b) =>
      collator.compare(a.familyName, b.familyName) ||
      collator.compare(a.subfamilyName, b.subfamilyName),
  );
  return FONT_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    fonts: sorted.filter((f) => normalizeFontCategory(f.category) === c.id),
  })).filter((g) => g.fonts.length);
}
