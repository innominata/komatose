import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { renderPage } from "../src/lib/server/finishedExport";
import { DEFAULT_STYLE } from "../src/lib/workflow";

test("typeset export clips text from geometry outside the page", async () => {
  const width = 64, height = 64;
  const base = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="-16" y="16" width="40" height="24" fill="red"/></svg>`;
  const line = { sourceState: "read", x: 0, y: 0.25, w: 0.375, h: 0.375 };
  const layout = { svg, rows: [{ text: "A", x: -16, baseline: 32, width: 40 }],
    size: 12, style: DEFAULT_STYLE, overflow: false };
  const page = { image: { width, height }, dpi: 72, regions: [{ line,
    data: { polygon: [{ x: -0.25, y: 0.25 }, { x: 0.375, y: 0.25 },
      { x: 0.375, y: 0.625 }, { x: -0.25, y: 0.625 }], layout } }] };

  const partial = await renderPage(page as any, { base });
  const { data: pixels, info } = await sharp(partial.composite).raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [...pixels.subarray(
    (y * width + x) * info.channels, (y * width + x) * info.channels + 3)];
  assert.deepEqual(pixel(0, 20), [255, 0, 0]);
  assert.deepEqual(pixel(23, 20), [255, 0, 0]);
  assert.deepEqual(pixel(24, 20), [255, 255, 255]);

  page.regions[0].data.polygon = [
    { x: 1.5, y: 0.25 }, { x: 2, y: 0.25 }, { x: 2, y: 0.625 }, { x: 1.5, y: 0.625 },
  ];
  page.regions[0].data.layout.svg = svg.replace('x="-16"', 'x="96"');
  const outside = await renderPage(page as any, { base });
  const outsidePixels = await sharp(outside.composite).removeAlpha().raw().toBuffer();
  const basePixels = await sharp(base).raw().toBuffer();
  assert.ok(outsidePixels.equals(basePixels), "text entirely beyond the page adds no pixels");
});
