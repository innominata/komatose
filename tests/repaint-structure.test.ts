import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { repaintStructure, BLOTCH_RATIO } from '../src/lib/server/directorCleaningResidue';

const size = 200;
async function page(draw: (x: number, y: number) => [number, number, number]) {
  const data = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(draw(x, y), (y * size + x) * 3);
  return sharp(data, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}
const purple: [number, number, number] = [70, 40, 80];
const letters = (x: number, y: number) => x > 60 && x < 140 && y > 80 && y < 120 && (x % 20 < 8);

test('a repaint that continues a flat background passes the measured blotch check', async () => {
  const raw = await page((x, y) => (letters(x, y) ? [0, 0, 0] : purple));
  const clean = await page(() => purple);
  const { ratio } = await repaintStructure(raw, clean);
  assert.ok(ratio < BLOTCH_RATIO, `ratio ${ratio}`);
});

test('dark-edged blotches left where lettering was fail the measured blotch check', async () => {
  const raw = await page((x, y) => (letters(x, y) ? [0, 0, 0] : purple));
  const smudged = await page((x, y) => {
    if (!letters(x, y)) return purple;
    // A smudge: a lighter fill with a dark rim, like LaMa's leftovers on page 15.
    return x % 20 === 0 || x % 20 === 7 || y === 81 || y === 119 ? [20, 10, 25] : [110, 80, 120];
  });
  const { ratio } = await repaintStructure(raw, smudged);
  assert.ok(ratio >= BLOTCH_RATIO, `ratio ${ratio}`);
});
