export type SortDir = 'asc' | 'desc';
export type SortState<K extends string> = { key: K; dir: SortDir };

/** First click uses the column's preferred direction; the same header again reverses it. */
export function nextSort<K extends string>(current: SortState<K>, key: K, prefer: SortDir): SortState<K> {
	if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
	return { key, dir: prefer };
}

export function compareSortValues(a: string | number, b: string | number, dir: SortDir): number {
	const sign = dir === 'asc' ? 1 : -1;
	const aMissing = a === '' || (typeof a === 'number' && !Number.isFinite(a));
	const bMissing = b === '' || (typeof b === 'number' && !Number.isFinite(b));
	if (aMissing && bMissing) return 0;
	if (aMissing) return 1;
	if (bMissing) return -1;
	if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
	return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true }) * sign;
}

export function sortedBy<T, K extends string>(
	rows: T[],
	sort: SortState<K>,
	value: (row: T, key: K) => string | number,
): T[] {
	return [...rows].sort((a, b) => compareSortValues(value(a, sort.key), value(b, sort.key), sort.dir));
}

export function ariaSort(active: boolean, dir: SortDir): 'ascending' | 'descending' | 'none' {
	if (!active) return 'none';
	return dir === 'asc' ? 'ascending' : 'descending';
}
