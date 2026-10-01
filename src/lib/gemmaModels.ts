export const GEMMA4_E2B_ID = "gemma-4-e2b-it";
export const GEMMA4_E2B_LABEL = "Gemma 4 E2B (~2B)";

export const GEMMA4_12B_ID = "gemma-4-12b-it";
export const GEMMA4_12B_LABEL = "Gemma 4 12B";

export const GEMMA4_26B_ID = "gemma-4-26b-a4b-it";
export const GEMMA4_26B_LABEL = "Gemma 4 26B A4B";

export const GEMMA4_CHAT_IDS = [
	GEMMA4_E2B_ID,
	GEMMA4_12B_ID,
	GEMMA4_26B_ID,
] as const;

export type Gemma4ChatId = (typeof GEMMA4_CHAT_IDS)[number];

export function gemma4ModelLabel(id: string): string {
	const key = String(id || "").trim().toLowerCase();
	if (key === GEMMA4_E2B_ID) return GEMMA4_E2B_LABEL;
	if (key === GEMMA4_12B_ID) return GEMMA4_12B_LABEL;
	if (key === GEMMA4_26B_ID) return GEMMA4_26B_LABEL;
	return String(id || "").trim();
}
