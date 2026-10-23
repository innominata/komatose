import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { repaintStructure, BLOTCH_RATIO, changedShare, EDITOR_NO_OP_SHARE } from '../src/lib/server/directorCleaningResidue';
import { sourceKey } from '../src/lib/server/directorMemory';

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

test('an editor that returns the letters untouched is a no-op; erasing them is not', async () => {
  const raw = await page((x, y) => (letters(x, y) ? [255, 255, 255] : purple));
  const lettersMask = await page((x, y) => (letters(x, y) ? [255, 255, 255] : [0, 0, 0]));
  const erased = await page(() => purple);
  assert.ok((await changedShare(raw, raw, lettersMask)) < EDITOR_NO_OP_SHARE);
  assert.ok((await changedShare(raw, erased, lettersMask)) > 0.8);
});

test('reference matching ignores spacing, line breaks and punctuation', () => {
  assert.equal(sourceKey('누군가를\n진심으로 좋아하는\n마음은'), sourceKey('누군가를 진심으로 좋아하는 마음은'));
  assert.equal(sourceKey('단순한 설렘이나 들뜸만으로는 설명할 수 없다는 것을.'), sourceKey('단순한설렘이나\n들뜸만으로는설명할수\n없다는것을'));
  assert.notEqual(sourceKey('뭐?'), sourceKey('뭐야?'));
});
