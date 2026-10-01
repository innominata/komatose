/**
 * Move `movedId` to immediately after `afterId`.
 * `afterId` null places it first. Returns null when unchanged or invalid.
 */
export function placeRegionAfter<T>(
  items: T[],
  idOf: (item: T) => string,
  afterId: string | null,
  movedId: string,
): T[] | null {
  const from = items.findIndex((item) => idOf(item) === movedId);
  if (from < 0) return null;
  if (afterId == null) {
    if (from === 0) return null;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.unshift(moved);
    return next;
  }
  if (afterId === movedId) return null;
  const after = items.findIndex((item) => idOf(item) === afterId);
  if (after < 0 || from === after + 1) return null;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(next.findIndex((item) => idOf(item) === afterId) + 1, 0, moved);
  return next;
}

/** Stable reading bands. Manual sortOrder remains authoritative after detection. */
export function orderRegions<T>(
  items: T[],
  box: (item: T) => { x: number; y: number; w: number; h: number },
  direction: "rtl" | "ltr",
): T[] {
  const pending = items
    .map((item, index) => ({ item, index, box: box(item) }))
    .sort((a, b) => a.box.y - b.box.y || a.index - b.index);
  const rows: (typeof pending)[] = [];
  for (const item of pending) {
    const row = rows.find((row) => {
      const anchor = row[0].box;
      return (
        Math.min(anchor.y + anchor.h, item.box.y + item.box.h) -
          Math.max(anchor.y, item.box.y) >
        Math.min(anchor.h, item.box.h) * 0.5
      );
    });
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) =>
    row
      .sort(
        (a, b) =>
          (direction === "rtl" ? b.box.x - a.box.x : a.box.x - b.box.x) ||
          a.index - b.index,
      )
      .map((i) => i.item),
  );
}
