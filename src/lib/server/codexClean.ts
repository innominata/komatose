import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { cliReadiness } from './cliDiscovery';
import { codexBin, generateCleaningImageWithCodex } from './cliTranslate';

const execFileAsync = promisify(execFile);
type Readiness = { available: boolean; reason: string };
let probe: { bin: string; expires: number; result: Promise<Readiness> } | undefined;

export async function probeCodexCleaning(): Promise<Readiness> {
	const cli = cliReadiness('codex');
	if (!cli.available) return { available: false, reason: cli.reason };
	const bin = codexBin();
	if (!bin) return { available: false, reason: cli.reason };
	if (probe?.bin === bin && probe.expires > Date.now()) return probe.result;
	const result = execFileAsync(bin, ['features', 'list'], { timeout: 5000, maxBuffer: 256 * 1024 })
		.then(({ stdout }) => /^image_generation\s/m.test(stdout)
			? { available: true, reason: 'Uses Codex image generation; sign-in and usage limits are checked when run' }
			: { available: false, reason: 'Update Codex CLI to a version with image generation' })
		.catch(() => ({ available: false, reason: 'Could not check Codex image generation support' }));
	probe = { bin, expires: Date.now() + 60_000, result };
	return result;
}

// Bound model inputs without shrinking whole webtoon strips. Keep each full
// reconstructed crop; the mask guides removal rather than clipping the result.
const CORE = 768;
const CONTEXT = 128;
type Crop = { left: number; top: number; width: number; height: number };

export async function cleanWithCodex(opts: {
	path: string;
	mask: string;
	out: string;
	prompt?: string;
	model?: string;
}, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const source = await sharp(opts.path).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const mask = await sharp(opts.mask).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
	const { width, height, channels } = source.info;
	if (mask.info.width !== width || mask.info.height !== height)
		throw new Error('Removal mask dimensions do not match the prepared page');
	const groups = new Map<string, { bounds: Crop }>();
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (!mask.data[y * width + x]) continue;
			const cx = Math.floor(x / CORE) * CORE, cy = Math.floor(y / CORE) * CORE;
			const key = `${cx}:${cy}`;
			const group = groups.get(key);
			if (group) {
				const right = Math.max(group.bounds.left + group.bounds.width, x + 1);
				group.bounds.left = Math.min(group.bounds.left, x);
				group.bounds.width = right - group.bounds.left;
				group.bounds.height = y + 1 - group.bounds.top;
			} else groups.set(key, { bounds: { left: x, top: y, width: 1, height: 1 } });
		}
	}
	if (!groups.size) throw new Error('The approved removal mask is empty');
	const output = Buffer.from(source.data);
	let patches = 0;
	for (const { bounds } of groups.values()) {
		signal?.throwIfAborted();
		const left = Math.max(0, bounds.left - CONTEXT), top = Math.max(0, bounds.top - CONTEXT);
		const crop = { left, top,
			width: Math.min(width, bounds.left + bounds.width + CONTEXT) - left,
			height: Math.min(height, bounds.top + bounds.height + CONTEXT) - top };
		const side = Math.max(512, crop.width, crop.height);
		const selection = Buffer.alloc(side * side);
		for (let y = 0; y < crop.height; y++) {
			for (let x = 0; x < crop.width; x++) {
				if (mask.data[(top + y) * width + left + x]) selection[y * side + x] = 255;
			}
		}
		if (!selection.some(value => value !== 0)) continue;
		// Overlapping crops start from the latest reconstruction, so later calls
		// cannot restore lettering or artwork from the original page.
		const image = await sharp(output, { raw: source.info }).extract(crop)
			.extend({ top: 0, left: 0, right: side - crop.width, bottom: side - crop.height, background: '#ffffff' })
			.png().toBuffer();
		const maskImage = await sharp(selection, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
		const generated = await generateCleaningImageWithCodex({
			image,
			mask: maskImage,
			abort: signal,
			prompt: opts.prompt,
			model: opts.model,
		});
		patches++;
		signal?.throwIfAborted();
		const meta = await sharp(generated).metadata();
		if (!meta.width || !meta.height || Math.abs(meta.width / meta.height - 1) > .02)
			throw new Error('Codex returned a different image framing; retry cleaning');
		const fill = await sharp(generated).resize(side, side, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer();
		for (let y = 0; y < crop.height; y++) {
			for (let x = 0; x < crop.width; x++) {
				const from = (y * side + x) * channels, to = ((top + y) * width + left + x) * channels;
				// Keep the complete reconstruction, including changes outside the mask.
				const alpha = fill[from + 3] / 255;
				for (let c = 0; c < 3; c++) output[to + c] = Math.round(fill[from + c] * alpha + output[to + c] * (1 - alpha));
				mask.data[(top + y) * width + left + x] = 0;
			}
		}
	}
	signal?.throwIfAborted();
	await sharp(output, { raw: source.info }).png().toFile(opts.out);
	return { method: 'codex', backend: 'Codex CLI · image generation', patches };
}
