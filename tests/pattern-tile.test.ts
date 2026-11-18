import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { findTile } from "../src/lib/patternTile";

/** A rendered patch: grayscale pixels of an SVG drawn by librsvg, as a sampled page area would be. */
async function patch(svg: string) {
  const { data, info } = await sharp(Buffer.from(svg)).flatten({ background: "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const dots = (w: number, h: number, pitch: number, angle = 0, r = pitch / 4) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><pattern id="d" patternUnits="userSpaceOnUse" width="${pitch}" height="${pitch}" patternTransform="rotate(${angle})"><circle cx="${pitch / 2}" cy="${pitch / 2}" r="${r}"/></pattern></defs><rect width="${w}" height="${h}" fill="#fff"/><rect width="${w}" height="${h}" fill="url(#d)"/></svg>`;

/** Mean absolute difference between the patch and its own tile repeated over it, near the tile. */
function seamError(img: { data: ArrayLike<number>; width: number }, t: { x: number; y: number; width: number; height: number }) {
  let sum = 0, n = 0;
  for (let y = t.y; y < t.y + t.height * 2 && y < img.data.length / img.width; y++)
    for (let x = t.x; x < t.x + t.width * 2 && x < img.width; x++) {
      const tx = t.x + ((x - t.x) % t.width), ty = t.y + ((y - t.y) % t.height);
      sum += Math.abs(img.data[y * img.width + x] - img.data[ty * img.width + tx]);
      n++;
    }
  return sum / n;
}

test("a square dot screen gives a tile of one repeat", async () => {
  const img = await patch(dots(120, 90, 8));
  const r = findTile(img);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  assert.equal(r.width, 8);
  assert.equal(r.height, 8);
  assert.ok(seamError(img, r) < 1);
});

test("a 45° screen repeats every pitch·√2 and the tile spans whole repeats", async () => {
  const img = await patch(dots(200, 160, 6, 45));
  const r = findTile(img);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  if (r.across.kind !== "periodic") throw new Error("expected a repeat across");
  // The repeat is found as one step or a whole number of them (a fractional step lines up
  // less well than two that land near a whole pixel).
  const steps = r.across.period / (6 * Math.SQRT2);
  assert.ok(Math.abs(steps - Math.round(steps)) < 0.05, `period ${r.across.period}`);
  // 8.49 px is not whole: two repeats (16.97 px) land on 17.
  assert.equal(r.width, 17);
  assert.ok(seamError(img, r) < 12);
});

test("lines that do not change along an axis tile at a short fixed length there", async () => {
  const img = await patch(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><pattern id="l" patternUnits="userSpaceOnUse" width="10" height="5"><rect width="10" height="2"/></pattern></defs><rect width="100" height="100" fill="#fff"/><rect width="100" height="100" fill="url(#l)"/></svg>`);
  const r = findTile(img);
  assert.ok(r.ok, !r.ok ? r.reason : "");
  assert.equal(r.across.kind, "uniform");
  assert.equal(r.height, 5);
});

test("artwork without a repeat, or too small a patch, says why", async () => {
  // Random speckle: nothing repeats.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const noise = { data: Float32Array.from({ length: 80 * 80 }, () => rand() * 255), width: 80, height: 80 };
  const r = findTile(noise);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.length > 0);
  const tiny = findTile(await patch(dots(10, 10, 8)));
  assert.equal(tiny.ok, false);
});
