import sharp from 'sharp';

const LUMA_CUTOFF = 148;

/**
 * Sample a normalised page region and return true when black lettering will
 * read better than white (bright bubble interiors, cream caption boxes).
 */
export async function shouldInvertText(
	bytes: Buffer,
	x: number,
	y: number,
	w: number,
	h: number
): Promise<boolean> {
	const meta = await sharp(bytes).metadata();
	const W = meta.width || 1;
	const H = meta.height || 1;
	const padX = Math.max(0, w * 0.18);
	const padY = Math.max(0, h * 0.18);
	const left = Math.max(0, Math.floor((x + padX) * W));
	const top = Math.max(0, Math.floor((y + padY) * H));
	const width = Math.max(2, Math.min(W - left, Math.ceil((w - padX * 2) * W)));
	const height = Math.max(2, Math.min(H - top, Math.ceil((h - padY * 2) * H)));
	if (width < 2 || height < 2 || left >= W || top >= H) return false;

	const { data, info } = await sharp(bytes)
		.extract({ left, top, width, height })
		.resize(16, 16, { fit: 'fill' })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });

	let sum = 0;
	const n = info.width * info.height;
	for (let i = 0; i < n; i++) {
		const o = i * 3;
		sum += 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
	}
	return sum / Math.max(1, n) >= LUMA_CUTOFF;
}
