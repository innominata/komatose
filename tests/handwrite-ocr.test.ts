import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
	cleanHandwriteReading,
	drawingLooksEmpty,
	drawingToJpeg,
	HANDWRITE_OCR_PROMPT,
	parseDrawingPng,
	pickHandwriteModel,
	readHandwriting,
} from "../src/lib/server/handwriteOcr";

async function pngDataUrl(opts: { ink?: boolean }) {
	const image = sharp({
		create: { width: 24, height: 24, channels: 3, background: "#ffffff" },
	});
	const png = await (opts.ink
		? image.composite([
				{
					input: Buffer.from(
						'<svg width="24" height="24"><rect x="6" y="6" width="6" height="8" fill="black"/></svg>',
					),
				},
			])
		: image
	)
		.png()
		.toBuffer();
	return `data:image/png;base64,${png.toString("base64")}`;
}

test("handwrite model picker uses the first model that already passed Read Text / OCR", () => {
	assert.equal(pickHandwriteModel([]), null);
	assert.equal(pickHandwriteModel([{ id: "grok" }, { id: "qwen3-vl-8b" }]), "grok");
	assert.equal(pickHandwriteModel([{ id: "hayai-ocr-v2" }, { id: "qwen3-vl-8b" }]), "hayai-ocr-v2");
	assert.match(HANDWRITE_OCR_PROMPT, /handwritten Japanese/);
	assert.equal(cleanHandwriteReading('"太"\nextra'), "太");
});

test("drawing parser rejects empty, non-image, and blank pads", async () => {
	assert.throws(() => parseDrawingPng(""), /Draw a character/);
	assert.throws(() => parseDrawingPng("not-an-image"), /must be a PNG/);
	const blank = await pngDataUrl({ ink: false });
	const ink = await pngDataUrl({ ink: true });
	assert.equal(await drawingLooksEmpty(await drawingToJpeg(parseDrawingPng(blank))), true);
	assert.equal(await drawingLooksEmpty(await drawingToJpeg(parseDrawingPng(ink))), false);
	await assert.rejects(
		readHandwriting(blank, new AbortController().signal, {
			installed: () => [{ id: "qwen3-vl-8b" }],
			read: async () => {
				throw new Error("should not read a blank pad");
			},
		}),
		/Draw a character/,
	);
});

test("handwriting OCR keeps an explicit model and explains a missing pass", async () => {
	const ink = await pngDataUrl({ ink: true });
	const seen: string[] = [];
	const result = await readHandwriting(ink, new AbortController().signal, {
		model: { engine: "qwen3-vl-8b", model: "qwen3-vl-8b" },
		installed: () => [{ id: "grok" }, { id: "hayai-ocr-v2" }],
		read: async (id) => {
			seen.push(id);
			return "太郎";
		},
	});
	assert.deepEqual(seen, ["qwen3-vl-8b"]);
	assert.equal(result.source, "太郎");
	assert.equal(result.model, "qwen3-vl-8b");
	await assert.rejects(
		readHandwriting(ink, new AbortController().signal, {
			installed: () => [],
			read: async () => {
				throw new Error("nothing eligible should run");
			},
		}),
		/current passing Read Text \/ OCR test/,
	);
	await assert.rejects(
		readHandwriting(ink, new AbortController().signal, {
			model: { engine: "missing-reader", model: "missing-reader" },
			installed: () => [{ id: "hayai-ocr-v2" }],
			read: async () => "should not run",
		}),
		/unavailable/,
	);
});
