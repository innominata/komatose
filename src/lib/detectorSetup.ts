import { DETECTORS, type Detector } from './types';

/**
 * What chapter transcription runs to find lettering: one box detector, plus
 * optional add-ons. COO finds sound effects outside bubbles; Koharu grows or
 * adds boxes for lettering the box detector missed. The id (`ctd+koharu`) is
 * the same one the benchmark scores.
 */
export type DetectorSetupConfig = { base: Detector; coo: boolean; koharu: boolean };

export type DetectorAddOn = 'coo' | 'koharu';

export const DEFAULT_DETECT_CONF = 0.2;

export const DETECTOR_BASE_LABELS: Record<Detector, string> = {
	rtdetr: 'RT-DETR',
	ctd: 'Comic Text Detector',
	paddle: 'PaddleOCR lines',
	heuristic: 'Geometric bubbles',
};

export const DETECTOR_ADDON_LABELS: Record<DetectorAddOn, string> = {
	coo: 'COO',
	koharu: 'Koharu',
};

/** The geometric fallback finds bubble outlines only; add-ons have nothing to extend. */
export function acceptsAddOns(base: Detector): boolean {
	return base !== 'heuristic';
}

export function detectorSetupId(setup: DetectorSetupConfig): string {
	if (!acceptsAddOns(setup.base)) return setup.base;
	return [setup.base, ...(setup.coo ? ['coo'] : []), ...(setup.koharu ? ['koharu'] : [])].join('+');
}

export function parseDetectorSetup(value: unknown): DetectorSetupConfig | undefined {
	const parts = String(value ?? '').trim().toLowerCase().split('+').filter(Boolean);
	const [base, ...rest] = parts;
	if (!base || !/^[a-z0-9][a-z0-9._-]*$/.test(base)) return undefined;
	if (new Set(rest).size !== rest.length || rest.some((part) => part !== 'coo' && part !== 'koharu')) return undefined;
	if (rest.length && !acceptsAddOns(base as Detector)) return undefined;
	return { base: base as Detector, coo: rest.includes('coo'), koharu: rest.includes('koharu') };
}

export function detectorSetupLabel(setup: DetectorSetupConfig): string {
	return [
		DETECTOR_BASE_LABELS[setup.base] || setup.base,
		...(setup.coo ? [DETECTOR_ADDON_LABELS.coo] : []),
		...(setup.koharu ? [DETECTOR_ADDON_LABELS.koharu] : []),
	].join(' + ');
}

/** Every setup an operator can choose, box detectors with each add-on combination. */
export function allDetectorSetups(): DetectorSetupConfig[] {
	return DETECTORS.flatMap((base) =>
		acceptsAddOns(base)
			? [
					{ base, coo: true, koharu: true },
					{ base, coo: false, koharu: true },
					{ base, coo: true, koharu: false },
					{ base, coo: false, koharu: false },
				]
			: [{ base, coo: false, koharu: false }],
	);
}

export function clampDetectConf(value: unknown): number | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	const n = Number(value);
	if (!Number.isFinite(n)) return undefined;
	return Math.min(0.9, Math.max(0.05, Math.round(n * 100) / 100));
}

/** Which parts this machine can run; the chapter picker and admin card grey out the rest. */
export type DetectorAvailability = Record<Detector | DetectorAddOn, { installed: boolean; detail?: string }>;

export type DetectorDefaults = {
	setup: string;
	conf: number;
	/** False until an operator saves; the default then follows the legacy auto rules. */
	saved: boolean;
	available: DetectorAvailability;
};
