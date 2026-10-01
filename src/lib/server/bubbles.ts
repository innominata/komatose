import sharp, { type Sharp } from 'sharp';

export type SpeechBubble = {
	left: number;
	top: number;
	width: number;
	height: number;
	x: number;
	y: number;
	w: number;
	h: number;
	kind?: 'white' | 'dark';
};

function lumaOf(data: Buffer, i: number): number {
	const o = i * 3;
	return 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
}

function distanceTransform(mask: Uint8Array, W: number, H: number): Uint16Array {
	const dist = new Uint16Array(W * H);
	for (let i = 0; i < mask.length; i++) dist[i] = mask[i] ? 65535 : 0;
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (!mask[i]) continue;
			let d = dist[i];
			if (x) d = Math.min(d, dist[i - 1] + 1);
			if (y) d = Math.min(d, dist[i - W] + 1);
			dist[i] = d;
		}
	}
	for (let y = H - 1; y >= 0; y--) {
		for (let x = W - 1; x >= 0; x--) {
			const i = y * W + x;
			if (!mask[i]) continue;
			let d = dist[i];
			if (x + 1 < W) d = Math.min(d, dist[i + 1] + 1);
			if (y + 1 < H) d = Math.min(d, dist[i + W] + 1);
			dist[i] = d;
		}
	}
	return dist;
}

function toBubble(
	W: number,
	H: number,
	minx: number,
	miny: number,
	maxx: number,
	maxy: number,
	pad: number,
	kind: 'white' | 'dark' = 'white'
): SpeechBubble {
	const left = Math.max(0, minx - pad);
	const top = Math.max(0, miny - pad);
	const right = Math.min(W, maxx + 1 + pad);
	const bottom = Math.min(H, maxy + 1 + pad);
	return {
		left,
		top,
		width: right - left,
		height: bottom - top,
		x: left / W,
		y: top / H,
		w: (right - left) / W,
		h: (bottom - top) / H,
		kind
	};
}

export function bubbleFromNorm(
	W: number,
	H: number,
	x: number,
	y: number,
	w: number,
	h: number
): SpeechBubble {
	const nx = Math.min(1, Math.max(0, x));
	const ny = Math.min(1, Math.max(0, y));
	const nw = Math.min(1 - nx, Math.max(0, w));
	const nh = Math.min(1 - ny, Math.max(0, h));
	return toBubble(
		W,
		H,
		Math.floor(nx * W),
		Math.floor(ny * H),
		Math.max(Math.floor(nx * W), Math.ceil((nx + nw) * W) - 1),
		Math.max(Math.floor(ny * H), Math.ceil((ny + nh) * H) - 1),
		0
	);
}

type CoreBlob = {
	minx: number;
	maxx: number;
	miny: number;
	maxy: number;
	area: number;
	maxd: number;
};

function floodCores(dist: Uint16Array, W: number, H: number, core: number, floor: number): CoreBlob[] {
	const seen = new Uint8Array(W * H);
	const qx = new Int32Array(W * H);
	const qy = new Int32Array(W * H);
	const out: CoreBlob[] = [];
	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const i0 = y * W + x;
			if (dist[i0] < core || seen[i0]) continue;
			let qh = 0;
			let qt = 0;
			qx[qt] = x;
			qy[qt++] = y;
			seen[i0] = 1;
			let minx = x;
			let maxx = x;
			let miny = y;
			let maxy = y;
			let area = 0;
			let maxd = dist[i0];
			while (qh < qt) {
				const cx = qx[qh];
				const cy = qy[qh++];
				const i = cy * W + cx;
				if (dist[i] < floor) continue;
				area++;
				if (cx < minx) minx = cx;
				if (cx > maxx) maxx = cx;
				if (cy < miny) miny = cy;
				if (cy > maxy) maxy = cy;
				if (dist[i] > maxd) maxd = dist[i];
				for (const [dx, dy] of [
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1]
				] as const) {
					const nx = cx + dx;
					const ny = cy + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					const ni = ny * W + nx;
					if (seen[ni] || dist[ni] < floor) continue;
					seen[ni] = 1;
					qx[qt] = nx;
					qy[qt++] = ny;
				}
			}
			out.push({ minx, maxx, miny, maxy, area, maxd });
		}
	}
	return out;
}

function ringBrightFrac(
	data: Buffer,
	W: number,
	H: number,
	minx: number,
	maxx: number,
	miny: number,
	maxy: number,
	pad: number
): number {
	const x0 = Math.max(0, minx - pad);
	const x1 = Math.min(W - 1, maxx + pad);
	const y0 = Math.max(0, miny - pad);
	const y1 = Math.min(H - 1, maxy + pad);
	let ring = 0;
	let bright = 0;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if (x >= minx && x <= maxx && y >= miny && y <= maxy) continue;
			ring++;
			if (lumaOf(data, y * W + x) >= 150) bright++;
		}
	}
	return bright / Math.max(1, ring);
}

function findWhiteBubbles(data: Buffer, W: number, H: number): SpeechBubble[] {
	const mask = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) mask[i] = lumaOf(data, i) >= 242 ? 1 : 0;
	const dist = distanceTransform(mask, W, H);
	const out: SpeechBubble[] = [];
	for (const blob of floodCores(dist, W, H, 7, 2)) {
		const bw = blob.maxx - blob.minx + 1;
		const bh = blob.maxy - blob.miny + 1;
		if (blob.area < 2500 || blob.maxd < 7) continue;
		if (bw < 90 || bh < 48) continue;
		if (bw >= W * 0.9) continue;
		if (bh > 560) continue;

		const ix0 = blob.minx + Math.floor(bw * 0.18);
		const ix1 = blob.maxx - Math.floor(bw * 0.18);
		const iy0 = blob.miny + Math.floor(bh * 0.18);
		const iy1 = blob.maxy - Math.floor(bh * 0.18);
		let inner = 0;
		let innerInk = 0;
		let bright = 0;
		for (let yy = blob.miny; yy <= blob.maxy; yy++) {
			for (let xx = blob.minx; xx <= blob.maxx; xx++) {
				const v = lumaOf(data, yy * W + xx);
				if (v >= 230) bright++;
				if (xx < ix0 || xx > ix1 || yy < iy0 || yy > iy1) continue;
				inner++;
				if (v < 90) innerInk++;
			}
		}
		const ink = innerInk / Math.max(1, inner);
		const br = bright / Math.max(1, bw * bh);
		if (ink < 0.04 || br < 0.5) continue;
		out.push(toBubble(W, H, blob.minx, blob.miny, blob.maxx, blob.maxy, 8, 'white'));
	}
	return out;
}

function findDarkBubbles(data: Buffer, W: number, H: number): SpeechBubble[] {
	const mask = new Uint8Array(W * H);
	for (let i = 0; i < W * H; i++) mask[i] = lumaOf(data, i) <= 78 ? 1 : 0;
	const dist = distanceTransform(mask, W, H);
	const out: SpeechBubble[] = [];
	const maxArea = W * H * 0.025;
	for (const blob of floodCores(dist, W, H, 7, 2)) {
		const bw = blob.maxx - blob.minx + 1;
		const bh = blob.maxy - blob.miny + 1;
		if (blob.area < 1100 || blob.area > maxArea) continue;
		if (blob.maxd < 8 || blob.maxd > 64) continue;
		if (bw < 64 || bh < 44) continue;
		if (bw >= W * 0.7 || bh > 340) continue;
		if (bw / bh > 2.8 || bh / bw > 2.4) continue;
		if (blob.area / (bw * bh) < 0.46) continue;

		const ix0 = blob.minx + Math.floor(bw * 0.16);
		const ix1 = blob.maxx - Math.floor(bw * 0.16);
		const iy0 = blob.miny + Math.floor(bh * 0.16);
		const iy1 = blob.maxy - Math.floor(bh * 0.16);
		let inner = 0;
		let whiteInk = 0;
		let dark = 0;
		for (let yy = iy0; yy <= iy1; yy++) {
			for (let xx = ix0; xx <= ix1; xx++) {
				const v = lumaOf(data, yy * W + xx);
				inner++;
				if (v >= 185) whiteInk++;
				if (v <= 90) dark++;
			}
		}
		if (whiteInk < 50) continue;
		if (whiteInk / Math.max(1, inner) < 0.04) continue;
		if (dark / Math.max(1, inner) < 0.52) continue;
		if (ringBrightFrac(data, W, H, blob.minx, blob.maxx, blob.miny, blob.maxy, 4) < 0.12) continue;
		out.push(toBubble(W, H, blob.minx, blob.miny, blob.maxx, blob.maxy, 10, 'dark'));
	}
	return out;
}

/**
 * Speech bubbles: thick white interiors with dark ink, plus dark interiors
 * with white ink (night balloons).
 */
export async function findSpeechBubbles(bytes: Buffer): Promise<SpeechBubble[]> {
	const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const W = info.width;
	const H = info.height;
	const out = [...findWhiteBubbles(data, W, H), ...findDarkBubbles(data, W, H)];
	out.sort((a, b) => a.y - b.y || a.x - b.x);
	return mergeOverlapping(out);
}

function mergeOverlapping(boxes: SpeechBubble[]): SpeechBubble[] {
	const kept: SpeechBubble[] = [];
	for (const b of boxes) {
		const hit = kept.findIndex((k) => overlap(k, b) > 0.45 || contained(k, b) > 0.62);
		if (hit < 0) {
			kept.push(b);
			continue;
		}
		const cur = kept[hit];
		const bWhite = b.kind === 'white';
		const cWhite = cur.kind === 'white';
		if (bWhite !== cWhite) kept[hit] = bWhite ? b : cur;
		else if (b.width * b.height < cur.width * cur.height) kept[hit] = b;
	}
	return kept;
}

function contained(a: SpeechBubble, b: SpeechBubble): number {
	const ax2 = a.x + a.w;
	const ay2 = a.y + a.h;
	const bx2 = b.x + b.w;
	const by2 = b.y + b.h;
	const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
	const inter = ix * iy;
	const smaller = Math.min(a.w * a.h, b.w * b.h);
	return smaller <= 0 ? 0 : inter / smaller;
}

function overlap(a: SpeechBubble, b: SpeechBubble): number {
	const ax2 = a.x + a.w;
	const ay2 = a.y + a.h;
	const bx2 = b.x + b.w;
	const by2 = b.y + b.h;
	const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
	const inter = ix * iy;
	const union = a.w * a.h + b.w * b.h - inter;
	return union <= 0 ? 0 : inter / union;
}

async function maybeInvert(extracted: Sharp): Promise<Sharp> {
	const { data, info } = await extracted
		.clone()
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	let sum = 0;
	const n = info.width * info.height;
	for (let i = 0; i < n; i++) sum += lumaOf(data, i);
	if (sum / n < 110) return extracted.negate({ alpha: false });
	return extracted;
}

export async function cropBubble(bytes: Buffer, bubble: SpeechBubble): Promise<Buffer> {
	const width = Math.max(1, bubble.width);
	const height = Math.max(1, bubble.height);
	const extracted = sharp(bytes).extract({
		left: bubble.left,
		top: bubble.top,
		width,
		height
	});
	return (await maybeInvert(extracted)).jpeg({ quality: 90 }).toBuffer();
}
