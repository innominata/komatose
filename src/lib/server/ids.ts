export function nid(): string {
	return crypto.randomUUID();
}

/** Unguessable token for a public strip preview. */
export function makePreviewToken(): string {
	return crypto.getRandomValues(new Uint8Array(24)).reduce(
		(s, b) => s + b.toString(16).padStart(2, '0'),
		''
	);
}

export function slugify(input: string): string {
	const s = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\w\s-]/g, '')
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return s || 'item';
}

/** Chapter slugs keep dots so 07.5 stays 07.5. */
export function episodeSlugify(input: string): string {
	const s = input
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^\w.\s-]/g, '')
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	return s || 'chapter';
}

export function now(): number {
	return Date.now();
}
