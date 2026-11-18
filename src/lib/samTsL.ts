/**
 * SAM-TS-L, the full-page lettering mask model (Hugging Face
 * `mayocream/koharu-text-sam-ts-l`). Its id is `sam-ts-l`: the model row,
 * mask engine, detector setup add-on (`rtdetr+sam-ts-l`) and detection source.
 */
export const SAM_TS_L_ID = 'sam-ts-l';
export const SAM_TS_L_NAME = 'SAM-TS-L';

/**
 * Ids earlier versions saved for the same model, in model rows, defaults,
 * detector setups, mask engines and detection provenance. Read them as
 * `sam-ts-l`; never write them.
 */
export const LEGACY_SAM_TS_L_IDS: readonly string[] = ['koharu', 'koharu-sam-ts-l'];
/** The display name earlier versions gave the model row. */
export const LEGACY_SAM_TS_L_NAME = 'Koharu';

/** Every spelling that means SAM-TS-L, lower case. */
export const SAM_TS_L_ALIASES: readonly string[] = [SAM_TS_L_ID, ...LEGACY_SAM_TS_L_IDS];

/** `id` with a legacy SAM-TS-L id replaced by `sam-ts-l`; anything else unchanged. */
export function canonicalModelId<T extends string | undefined | null>(id: T): T {
	if (typeof id !== 'string') return id;
	return (LEGACY_SAM_TS_L_IDS.includes(id.trim().toLowerCase()) ? SAM_TS_L_ID : id) as T;
}

export function isSamTsL(id: unknown): boolean {
	return typeof id === 'string' && SAM_TS_L_ALIASES.includes(id.trim().toLowerCase());
}
