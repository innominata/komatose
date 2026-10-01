import type { LineType } from './types';

export type ParsedLine = {
	body: string;
	lineType: LineType;
	page: number | null;
};

const PREFIXES: { re: RegExp; type: LineType }[] = [
	{ re: /^OT:\s*/i, type: 'OT' },
	{ re: /^ST:\s*/i, type: 'ST' },
	{ re: /^\[\]:\s*/, type: '[]' },
	{ re: /^<>:\s*/, type: '<>' },
	{ re: /^\(\):\s*/, type: '()' },
	{ re: /^"":\s*/, type: '""' },
	{ re: /^\/\/:\s*/, type: '//' },
	{ re: /^note:\s*/i, type: 'note' },
	{ re: /^::\s*/, type: '::' }
];

const PAGE_RE = /^---\s*Page\s+(\d+)\s*---\s*$/i;

export function parseTranslation(text: string): { lines: ParsedLine[]; hasPages: boolean } {
	let page: number | null = null;
	let hasPages = false;
	const lines: ParsedLine[] = [];

	for (const raw of text.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const pageMatch = trimmed.match(PAGE_RE);
		if (pageMatch) {
			hasPages = true;
			page = Number(pageMatch[1]);
			continue;
		}
		let lineType: LineType = 'plain';
		let body = trimmed;
		for (const p of PREFIXES) {
			if (p.re.test(trimmed)) {
				lineType = p.type;
				body = trimmed.replace(p.re, '');
				break;
			}
		}
		if (!body) continue;
		lines.push({ body, lineType, page: hasPages ? page : null });
	}

	return { lines, hasPages };
}

export function formatScript(
	items: { body: string; lineType: LineType; page?: number | null }[]
): string {
	const chunks: string[] = [];
	let lastPage: number | null | undefined = undefined;
	for (const item of items) {
		const page = item.page ?? null;
		if (page !== lastPage && page !== null) {
			chunks.push(`--- Page ${page} ---`);
			lastPage = page;
		}
		const prefix = item.lineType === 'plain' ? '' : `${item.lineType}: `;
		chunks.push(`${prefix}${item.body}`);
	}
	return chunks.join('\n') + (chunks.length ? '\n' : '');
}
