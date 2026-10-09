import type { GlossaryTerm } from './types';

/** Preserve character metadata through all glossary edit, merge and prompt paths. */
function glossaryMetadata(rec: Record<string, unknown>): Partial<GlossaryTerm> {
	const aliases = Array.isArray(rec.aliases) ? [...new Set(rec.aliases.filter((v): v is string => typeof v === 'string').map(v => v.trim().slice(0, 100)).filter(Boolean))].slice(0, 30) : [];
	return {
		...(typeof rec.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(rec.id) ? { id: rec.id } : {}),
		...(rec.kind === 'character' ? { kind: 'character' as const } : {}),
		...(aliases.length ? { aliases } : {}),
		...(typeof rec.notes === 'string' && rec.notes.trim() ? { notes: rec.notes.trim().slice(0, 2000) } : {}),
	};
}

export function parseGlossary(raw: string | null | undefined): GlossaryTerm[] {
	if (!raw || !raw.trim()) return [];
	try {
		const data = JSON.parse(raw) as unknown;
		if (!Array.isArray(data)) return [];
		const out: GlossaryTerm[] = [];
		for (const item of data) {
			if (!item || typeof item !== 'object') continue;
			const rec = item as Record<string, unknown>;
			const source = String(rec.source || '').trim();
			const translation = String(rec.translation || '').trim();
			if (!source && !translation) continue;
			out.push({
				...glossaryMetadata(rec),
				source,
				translation,
				edited: Boolean(rec.edited)
			});
		}
		return out;
	} catch {
		return [];
	}
}

export function serializeGlossary(terms: GlossaryTerm[]): string {
	return JSON.stringify(
		terms
			.map((t) => ({
				...glossaryMetadata(t),
				source: t.source.trim(),
				translation: t.translation.trim(),
				...(t.edited ? { edited: true } : {})
			}))
			.filter((t) => t.source || t.translation)
	);
}

export function upsertGlossary(
	terms: GlossaryTerm[],
	source: string,
	translation: string
): { terms: GlossaryTerm[]; changed: boolean } {
	const src = source.trim();
	const dest = translation.trim();
	if (!src || !dest) return { terms, changed: false };
	const i = terms.findIndex((t) => t.source.trim() === src);
	if (i === -1) return { terms: [...terms, { source: src, translation: dest }], changed: true };
	if (terms[i].edited) return { terms, changed: false };
	if (terms[i].translation === dest) return { terms, changed: false };
	const next = terms.slice();
	next[i] = { ...next[i], translation: dest };
	return { terms: next, changed: true };
}

/** Merge lists onto one series glossary. Later edited terms win over unedited duplicates. */
export function mergeGlossaryLists(...lists: GlossaryTerm[][]): GlossaryTerm[] {
	const out: GlossaryTerm[] = [];
	for (const list of lists) {
		for (const term of list) {
			const source = term.source.trim();
			const translation = term.translation.trim();
			if (!source && !translation) continue;
			const i = out.findIndex((t) => (term.id && t.id === term.id) || (source ? t.source.trim() === source : !t.source.trim() && t.translation.trim() === translation));
			if (i === -1) {
				out.push({ ...glossaryMetadata(term), source, translation, ...(term.edited ? { edited: true } : {}) });
				continue;
			}
			if (!term.edited || out[i].edited) continue;
			out[i] = { ...out[i], ...glossaryMetadata(term), source, translation: translation || out[i].translation, edited: true };
		}
	}
	return out;
}

/** Accepted Review-mine pairs become locked series terms. */
export function acceptGlossaryTerm(
	terms: GlossaryTerm[],
	source: string,
	translation: string
): { terms: GlossaryTerm[]; changed: boolean } {
	const src = source.trim();
	const dest = translation.trim();
	if (!src || !dest) return { terms, changed: false };
	const i = terms.findIndex((t) => t.source.trim() === src);
	if (i === -1) return { terms: [...terms, { source: src, translation: dest, edited: true }], changed: true };
	if (terms[i].edited) return { terms, changed: false };
	if (terms[i].translation === dest && terms[i].edited) return { terms, changed: false };
	const next = terms.slice();
	next[i] = { ...next[i], source: src, translation: dest, edited: true };
	return { terms: next, changed: true };
}

function foldTerm(value: string) {
	return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('en');
}

/** The term counts when it appears anywhere in the phrase, including inside a longer name. Line breaks are ignored. Skip 1-character needles. */
export function textHasTerm(haystack: string, needle: string): boolean {
	const text = foldTerm(haystack);
	const term = foldTerm(needle);
	if (!text || term.length < 2) return false;
	return text.includes(term);
}

/** Edited series terms whose source appears but required English does not. */
export function glossaryMismatches(
	source: string,
	english: string,
	terms: GlossaryTerm[]
): GlossaryTerm[] {
	const src = source.trim();
	const en = english.trim();
	if (!src || !en) return [];
	return terms.filter(
		(t) =>
			t.edited &&
			t.source.trim() &&
			t.translation.trim() &&
			textHasTerm(src, t.source) &&
			!textHasTerm(en, t.translation)
	);
}

export function glossaryPrompt(terms: GlossaryTerm[], limit = 80): string {
	if (!terms.length) return '';
	const characters = terms.filter(t => t.kind === 'character' && t.translation);
	const edited = terms.filter((t) => t.kind !== 'character' && t.edited && t.source && t.translation);
	const rest = terms.filter((t) => t.kind !== 'character' && !t.edited && t.source && t.translation);
	const picked = [...characters, ...edited, ...rest.slice(-Math.max(0, limit - edited.length - characters.length))].slice(0, Math.max(limit, characters.length));
	return picked.map((t) => t.kind === 'character'
		? `Character: ${t.source || '(original name not recorded)'} → ${t.translation}. Keep this exact spelling, spacing and hyphenation; do not re-romanize. Preserve full-name versus given-name usage from the source.${t.aliases?.length ? ` Other spellings to recognize: ${t.aliases.join(', ')}.` : ''}${t.notes ? ` Character notes: ${t.notes}` : ''}`
		: `${t.source} → ${t.translation}`).join('\n');
}

/** Series terms whose source appears in this balloon. Longer phrases first. */
export function glossaryHits(terms: GlossaryTerm[], source: string): GlossaryTerm[] {
	const hits = terms.filter(
		(t) => t.source.trim() && t.translation.trim() && textHasTerm(source, t.source),
	);
	hits.sort(
		(a, b) =>
			b.source.trim().length - a.source.trim().length ||
			Number(Boolean(b.edited)) - Number(Boolean(a.edited)) ||
			a.source.localeCompare(b.source, "en"),
	);
	const seen = new Set<string>();
	const out: GlossaryTerm[] = [];
	for (const term of hits) {
		const key = term.source.trim();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			...glossaryMetadata(term),
			source: key,
			translation: term.translation.trim(),
			...(term.edited ? { edited: true } : {}),
		});
	}
	return out;
}

/** Only terms whose source appears in this balloon. Empty when none apply. */
export function glossaryForSource(terms: GlossaryTerm[], source: string, limit = 40): string {
	return glossaryPrompt(glossaryHits(terms, source), limit);
}

const HAN = /[\u4e00-\u9fff]/;

export function hasKanji(text: string) {
	return HAN.test(text);
}

/** Series terms that contain kanji, for the Japanese character-entry keyboard. */
export function glossaryKanjiTerms(terms: GlossaryTerm[]): GlossaryTerm[] {
	const bySource = new Map<string, GlossaryTerm>();
	for (const term of terms) {
		const source = term.source.trim();
		const translation = term.translation.trim();
		if (!source || !hasKanji(source)) continue;
		const existing = bySource.get(source);
		if (!existing) {
			bySource.set(source, {
				source,
				translation,
				...(term.edited ? { edited: true } : {}),
			});
			continue;
		}
		if (term.edited && !existing.edited) {
			bySource.set(source, {
				source,
				translation: translation || existing.translation,
				edited: true,
			});
		}
	}
	return [...bySource.values()];
}

export function looksLikeNamePair(source: string, translation: string): boolean {
	const src = source.trim();
	const dest = translation.trim();
	if (!src || !dest) return false;
	if (src.length > 40 || dest.length > 48) return false;
	if (/\s{2,}/.test(src) || src.split(/\s+/).length > 5) return false;
	if (/[.!?]$/.test(dest)) return false;
	return true;
}
