/**
 * Proofreader vocabulary.
 *
 * A "proofreader" is an external review service the application can ask for a
 * critique of a page image pair. How a proofreader produces its reply is the
 * service's business: the application only sends images and text and receives a
 * critique, plus an opaque conversation token it compares to decide follow-ups.
 *
 * Nothing here — and nothing that imports it — should describe the mechanism.
 */

export const PROOFREADER_IDS = ['proofreader-a', 'proofreader-b'] as const;
export type ProofreaderId = (typeof PROOFREADER_IDS)[number];

export type ProofreaderDef = {
	readonly id: ProofreaderId;
	readonly label: string;
	readonly catalogLabel: string;
};

const a = {
	id: 'proofreader-a',
	label: 'Proofreader A',
	catalogLabel: 'Proofreader A',
} as const satisfies ProofreaderDef;

const b = {
	id: 'proofreader-b',
	label: 'Proofreader B',
	catalogLabel: 'Proofreader B',
} as const satisfies ProofreaderDef;

export const PROOFREADER_DEFS = [a, b] as const;

export function proofreaderDef(id: string): ProofreaderDef | undefined {
	return PROOFREADER_DEFS.find((item) => item.id === id);
}

export function isProofreaderId(id: string): id is ProofreaderId {
	return PROOFREADER_DEFS.some((item) => item.id === id);
}

export function proofreaderLabel(id: string): string {
	return proofreaderDef(id)?.label || 'This proofreader';
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
