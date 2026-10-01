import {
	GEMMA4_CHAT_IDS,
	gemma4ModelLabel,
} from './gemmaModels';

/** Display names for the local Qwen engines so pickers never collapse to "Qwen". */
export const QWEN_38_27B_ID = 'qwen3.8-27b-q4';
export const QWEN3_VL_ID = 'qwen3-vl-8b';

export const QWEN_38_27B_LABEL = 'Qwen 3.8 27B';
export const QWEN3_VL_LABEL = 'Qwen3-VL';

export const QWEN3_VL_REVIEW_IDS = [QWEN3_VL_ID] as const;
export type Qwen3VlReviewId = (typeof QWEN3_VL_REVIEW_IDS)[number];

export const DESCRIBE_QWEN_MODELS = [
	{ id: QWEN_38_27B_ID, label: QWEN_38_27B_LABEL },
	...GEMMA4_CHAT_IDS.map((id) => ({ id, label: gemma4ModelLabel(id) })),
	{ id: QWEN3_VL_ID, label: QWEN3_VL_LABEL },
] as const;

export function qwenModelLabel(id: string): string {
	const key = String(id || '').trim().toLowerCase();
	if (!key) return QWEN_38_27B_LABEL;
	if ((GEMMA4_CHAT_IDS as readonly string[]).includes(key)) return gemma4ModelLabel(key);
	if (key === QWEN3_VL_ID) return QWEN3_VL_LABEL;
	if (key === QWEN_38_27B_ID || key === `${QWEN_38_27B_ID} (default)`)
		return QWEN_38_27B_LABEL;
	return String(id).trim();
}

export function isQwen3VlModel(id?: string | null): id is typeof QWEN3_VL_ID {
	return String(id || '').trim().toLowerCase() === QWEN3_VL_ID;
}

export function qwen3VlReviewId(_id?: string | null): Qwen3VlReviewId {
	return QWEN3_VL_ID;
}

export function describeQwenModels(
	qwen: Array<{ id: string; label: string }> = [],
): Array<{ id: string; label: string }> {
	const named = DESCRIBE_QWEN_MODELS.map((m) => ({ id: m.id, label: m.label }));
	const seen = new Set<string>(named.map((m) => m.id));
	return [
		...named,
		...qwen
			.filter((m) => !seen.has(m.id))
			.map((m) => ({ id: m.id, label: qwenModelLabel(m.id) })),
	];
}
