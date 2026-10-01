import type { ProviderOperation } from './providerCatalog';

export const ESTIMATE_PAGE_BUBBLES = 8;

export function medianMs(samples: number[]): number | undefined {
	const values = samples.filter((item) => Number.isFinite(item) && item >= 0).sort((a, b) => a - b);
	if (!values.length) return undefined;
	const mid = Math.floor(values.length / 2);
	return values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
}

export function recordSample(samples: number[] | undefined, ms: number, keep = 5): number[] {
	const next = [...(samples || []).filter((item) => Number.isFinite(item) && item >= 0), ms];
	return next.slice(-keep);
}

/** Batched JSON translate/proofread/alternatives: not n serial calls. */
export function batchedPageMs(median: number, n: number): number {
	const lines = Math.max(1, n);
	return Math.round(median * (0.5 + 0.5 * lines));
}

export function serialPageMs(median: number, n: number): number {
	return Math.round(median * Math.max(0, n));
}

/** Per-region parallel: page time ≈ n × sum of wave maxes (concurrency cap). */
export function transcribeSetPageMs(medians: number[], n: number, concurrency = 3): number {
	const times = medians.filter((item) => Number.isFinite(item) && item > 0);
	if (!times.length || n <= 0) return 0;
	const cap = Math.max(1, concurrency);
	const sorted = [...times].sort((a, b) => b - a);
	let wave = 0;
	for (let i = 0; i < sorted.length; i += cap) {
		wave += Math.max(...sorted.slice(i, i + cap));
	}
	return Math.round(n * wave);
}

export function estimateForOperation(
	operation: ProviderOperation,
	median: number,
	n = ESTIMATE_PAGE_BUBBLES,
	opts?: { chapterLines?: number; fixtureLines?: number; specialistPerLine?: boolean },
): { label: string; ms: number } {
	if (operation === 'vision' || operation === 'advisory') {
		return { label: `${n}-bubble page`, ms: serialPageMs(median, n) };
	}
	if (operation === 'translate' || operation === 'proofreadEnglish' || operation === 'alternatives') {
		if (opts?.specialistPerLine) return { label: `${n}-line page`, ms: serialPageMs(median, n) };
		return { label: `${n}-line page`, ms: batchedPageMs(median, n) };
	}
	if (operation === 'describe' || operation === 'pageImageProofread') {
		return { label: 'per page', ms: Math.round(median) };
	}
	if (operation === 'compactNotes') {
		return { label: 'per chapter', ms: Math.round(median) };
	}
	if (operation === 'chapterReview') {
		const lines = Math.max(1, opts?.chapterLines ?? n);
		const fixture = Math.max(1, opts?.fixtureLines ?? 4);
		return { label: 'per chapter', ms: Math.round(median * Math.max(1, lines / fixture)) };
	}
	return { label: 'per call', ms: Math.round(median) };
}

export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
