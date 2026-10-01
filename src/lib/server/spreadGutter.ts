import sharp from 'sharp';

/** Split only in the middle fifth so each page keeps at least 40% of the width. */
export const MIN_SIDE_FRAC = 0.4;
/** Click-to-split can be uneven; keep at least this many pixels on each side. */
export const MIN_CLICK_SIDE_PX = 20;
/** How far from the click to look for a white gutter, as a fraction of width. */
export const CLICK_GUTTER_RADIUS_FRAC = 0.08;
export const CLICK_GUTTER_RADIUS_PX = 40;
/** How bright a pixel must be to count as paper. */
export const WHITE_LUMA = 242;
/** Full-height / full-width solid columns (grey paper, etc.) count as margin. */
export const SOLID_STDEV = 12;
/** Solid columns darker than this are ink, not paper, unless they match the page edge. */
export const PAPER_LUMA_MIN = 80;
export const PAPER_LUMA_SLACK = 28;
/** JPEG dust: a column may have this fraction of darker samples and still pass. */
export const MAX_NONWHITE_FRAC = 0.008;
/** Minimum width of the white band, as a fraction of the page. */
export const MIN_BAND_FRAC = 0.01;
export const MIN_BAND_PX = 10;

export type WhiteGutter = {
	/** Split x: left page is [0, x), right page is [x, width). */
	x: number;
	bandLeft: number;
	bandRight: number;
	width: number;
	height: number;
};

export function splitXFromAt(width: number, at: number): number {
	const mid = Math.round(at * width);
	const min = Math.min(MIN_CLICK_SIDE_PX, Math.max(1, Math.floor(width / 3)));
	return Math.min(width - min, Math.max(min, mid));
}

/**
 * Find a full-height white gutter.
 * With no `around`, search the center 20% so batch split only runs on a real spread.
 * With `around` (0–1), search near the click so the cut can be off-center.
 */
export async function findWhiteGutter(
	bytes: Buffer,
	opts: { around?: number } = {},
): Promise<WhiteGutter | null> {
	const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const width = info.width;
	const height = info.height;
	const ch = info.channels;
	if (width < 80 || height < 40) return null;

	const around = opts.around;
	const clickMin = Math.min(MIN_CLICK_SIDE_PX, Math.max(1, Math.floor(width / 3)));
	const minSide =
		around != null && Number.isFinite(around) ? clickMin : Math.ceil(width * MIN_SIDE_FRAC);
	let lo: number;
	let hi: number;
	if (around != null && Number.isFinite(around)) {
		const cx = splitXFromAt(width, around);
		const radius = Math.max(CLICK_GUTTER_RADIUS_PX, Math.round(width * CLICK_GUTTER_RADIUS_FRAC));
		lo = Math.max(minSide, cx - radius);
		hi = Math.min(width - minSide, cx + radius);
	} else {
		lo = minSide;
		hi = Math.floor(width * (1 - MIN_SIDE_FRAC));
	}
	if (hi - lo < MIN_BAND_PX) return null;

	const yStep = height > 2400 ? 2 : 1;
	const samples = Math.ceil(height / yStep);
	const allowedDark = Math.max(2, Math.floor(samples * MAX_NONWHITE_FRAC));
	const lumaOf = (x: number, y: number) => {
		const i = (y * width + x) * ch;
		return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
	};
	const colStats = (x: number) => {
		let dark = 0;
		let sum = 0;
		let sum2 = 0;
		for (let y = 0; y < height; y += yStep) {
			const luma = lumaOf(x, y);
			sum += luma;
			sum2 += luma * luma;
			if (luma < WHITE_LUMA) dark += 1;
		}
		const mean = sum / samples;
		const stdev = Math.sqrt(Math.max(0, sum2 / samples - mean * mean));
		return { dark, mean, stdev };
	};
	let paper = 255;
	let paperStdev = Infinity;
	for (const x of [0, 1, 2, width - 3, width - 2, width - 1]) {
		if (x < 0 || x >= width) continue;
		const s = colStats(x);
		if (s.stdev < SOLID_STDEV && s.stdev < paperStdev) {
			paper = s.mean;
			paperStdev = s.stdev;
		}
	}
	const white = new Uint8Array(width);

	for (let x = lo; x < hi; x++) {
		const { dark, mean, stdev } = colStats(x);
		const paperLike =
			stdev < SOLID_STDEV &&
			(mean >= PAPER_LUMA_MIN || Math.abs(mean - paper) <= PAPER_LUMA_SLACK);
		white[x] = dark <= allowedDark || paperLike ? 1 : 0;
	}

	let bestL = -1;
	let bestR = -1;
	let runL = -1;
	for (let x = lo; x <= hi; x++) {
		const on = x < hi && white[x];
		if (on && runL < 0) runL = x;
		if (!on && runL >= 0) {
			if (x - runL > bestR - bestL) {
				bestL = runL;
				bestR = x;
			}
			runL = -1;
		}
	}

	const minBand = Math.max(MIN_BAND_PX, Math.round(width * MIN_BAND_FRAC));
	if (bestL < 0 || bestR - bestL < minBand) return null;

	const x = Math.round((bestL + bestR) / 2);
	if (x < minSide || width - x < minSide) return null;

	return { x, bandLeft: bestL, bandRight: bestR, width, height };
}
