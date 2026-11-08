/**
 * Proofreader vocabulary.
 *
 * A "proofreader" is an external review service the application can ask for a
 * critique of a page image pair. Which proofreaders exist, and what they are
 * called, comes from that service's report. How a proofreader produces its
 * reply is the service's business: the application only sends images and text
 * and receives a critique, plus an opaque conversation token it compares to
 * decide follow-ups.
 *
 * Nothing here — and nothing that imports it — should describe the mechanism.
 */

export type ProofreaderId = string;

export type ProofreaderOption = {
	id: string;
	label: string;
};

/** Ids the service has reported, plus registry rows already saved for them. */
const options = new Map<string, ProofreaderOption>();

const PROOFREADER_ID = /^proofreader-[a-z0-9][a-z0-9._-]{0,64}$/;

export function isProofreaderSlug(id: string): boolean {
	return /^[a-z0-9][a-z0-9._-]{0,80}$/.test(id);
}

/** Readable fallback when a report has an id and no label. */
export function proofreaderLabelFromId(id: string): string {
	const words = String(id || '')
		.split(/[-_.]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1));
	return words.join(' ') || 'This proofreader';
}

/**
 * Remember options from a service report or from saved registry rows.
 * `replace` drops previously reported options first, so a new report is the list.
 */
export function noteProofreaderOptions(
	reported: readonly { id: string; label?: string }[],
	mode?: { replace?: boolean },
): ProofreaderOption[] {
	if (mode?.replace) options.clear();
	for (const item of reported) {
		const id = String(item?.id || '').trim();
		if (!isProofreaderSlug(id)) continue;
		const label = String(item?.label || '').trim() || options.get(id)?.label || proofreaderLabelFromId(id);
		options.set(id, { id, label });
	}
	return proofreaderOptions();
}

export function proofreaderOptions(): ProofreaderOption[] {
	return [...options.values()];
}

export function proofreaderDef(id: string): ProofreaderOption | undefined {
	return options.get(id);
}

export function isProofreaderId(id: string): id is ProofreaderId {
	return options.has(id) || PROOFREADER_ID.test(id);
}

export function proofreaderLabel(id: string): string {
	return options.get(id)?.label || (PROOFREADER_ID.test(id) ? proofreaderLabelFromId(id) : 'This proofreader');
}

/** Shown when a proofreader is selected for something other than page proofreading. */
export function proofreaderOnlyMessage(id: string, action: string): string {
	return `${proofreaderLabel(id)} is only for Proofread raw + typeset images, not ${action}. Keep using the Review/Typeset toolbar so it can reuse the same conversation.`;
}

/** Shown when a proofreader is used from a task area that cannot reuse a conversation. */
export function proofreaderToolbarOnlyMessage(id: string): string {
	return `${proofreaderLabel(id)} is only for Proofread raw + typeset images on the Review/Typeset toolbar.`;
}

/** Shown when the proofreading service is not configured or not reachable. */
export const PROOFREADER_UNAVAILABLE_MESSAGE =
	'The proofreading service is not available. Check Admin → Setup.';
