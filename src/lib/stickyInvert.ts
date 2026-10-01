/** Mean luma above this → black text (light bubble). Below → white text. */
const LUMA_CUTOFF = 148;

function luma(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

/**
 * Sample the artwork under a sticky. Returns true when the region is bright
 * enough that black lettering reads better than white. `null` if the image
 * has not decoded yet.
 */
export function shouldInvertText(
	img: HTMLImageElement,
	x: number,
	y: number,
	w: number,
	h: number
): boolean | null {
	if (!img.naturalWidth || !img.naturalHeight) return null;
	if (!canvas) {
		canvas = document.createElement('canvas');
		ctx = canvas.getContext('2d', { willReadFrequently: true });
	}
	if (!ctx) return null;

	const iw = img.naturalWidth;
	const ih = img.naturalHeight;
	const padX = Math.max(0, w * 0.18);
	const padY = Math.max(0, h * 0.18);
	const sx = Math.max(0, (x + padX) * iw);
	const sy = Math.max(0, (y + padY) * ih);
	const sw = Math.max(2, (w - padX * 2) * iw);
	const sh = Math.max(2, (h - padY * 2) * ih);
	if (sx >= iw || sy >= ih) return null;

	const tw = 16;
	const th = 16;
	canvas.width = tw;
	canvas.height = th;
	ctx.clearRect(0, 0, tw, th);
	ctx.drawImage(img, sx, sy, Math.min(sw, iw - sx), Math.min(sh, ih - sy), 0, 0, tw, th);
	const data = ctx.getImageData(0, 0, tw, th).data;
	let sum = 0;
	let n = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 16) continue;
		sum += luma(data[i], data[i + 1], data[i + 2]);
		n++;
	}
	if (!n) return null;
	return sum / n >= LUMA_CUTOFF;
}
