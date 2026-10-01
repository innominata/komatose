export type ListedModel = { id: string; label: string };

/** `cursor-agent --list-models` / `status` when this server's account is not logged in. */
export function cursorAuthError(text: string): string | null {
	const raw = String(text || '');
	if (/authentication required/i.test(raw) || /^not logged in\b/im.test(raw)) {
		return "Cursor CLI is not signed in on this server. Run `cursor-agent login` as the account Komatose runs under.";
	}
	return null;
}

/** `id - Label` lines from `cursor-agent --list-models` / `cursor-agent models`. */
export function parseCursorModelList(text: string): ListedModel[] {
	const found: ListedModel[] = [];
	for (const line of String(text || '').split('\n')) {
		const m = line.match(/^([\w.\[\]=,+-]+)\s+-\s+(.+)$/);
		if (!m) continue;
		if (found.some((item) => item.id === m[1])) continue;
		found.push({ id: m[1], label: m[2].trim() });
	}
	return found;
}

/** `grok models` text: capture grok-* tokens. */
export function parseGrokModelList(text: string): ListedModel[] {
	const found: ListedModel[] = [];
	for (const line of `${text || ''}`.split('\n')) {
		const m = line.match(/\b(grok-[\w.-]+)\b/);
		if (!m || found.some((item) => item.id === m[1])) continue;
		found.push({ id: m[1], label: m[1] });
	}
	return found;
}

/**
 * `codex debug models` JSON. Keep slug + display_name only;
 * ignore huge prompt dumps like model_messages.
 */
export function parseCodexDebugModels(json: unknown): ListedModel[] {
	const root = json && typeof json === 'object' ? (json as { models?: unknown }) : {};
	const list = Array.isArray(root.models) ? root.models : Array.isArray(json) ? json : [];
	const found: ListedModel[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const rec = item as Record<string, unknown>;
		const slug = String(rec.slug || rec.id || '').trim();
		if (!slug) continue;
		const visibility = String(rec.visibility || 'list');
		if (visibility && visibility !== 'list') continue;
		if (rec.supported_in_api === false) continue;
		if (found.some((row) => row.id === slug)) continue;
		found.push({ id: slug, label: String(rec.display_name || rec.name || slug).trim() || slug });
	}
	return found;
}

/** `codex debug models` may wrap JSON in logs; keep slug + display_name only. */
export function parseCodexDebugModelsText(text: string): ListedModel[] {
	const raw = String(text || '').trim();
	if (!raw) return [];
	try {
		return parseCodexDebugModels(JSON.parse(raw));
	} catch {
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start < 0 || end <= start) return [];
		try {
			return parseCodexDebugModels(JSON.parse(raw.slice(start, end + 1)));
		} catch {
			return [];
		}
	}
}

export function parseOpenAiModelList(json: unknown): ListedModel[] {
	const root = json && typeof json === 'object' ? (json as { data?: unknown }) : {};
	const list = Array.isArray(root.data) ? root.data : Array.isArray(json) ? json : [];
	const found: ListedModel[] = [];
	for (const item of list) {
		const id = item && typeof item === 'object'
			? String((item as { id?: unknown }).id || '').trim()
			: String(item || '').trim();
		if (!id || found.some((row) => row.id === id)) continue;
		found.push({ id, label: id });
	}
	return found;
}
