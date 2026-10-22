import sharp from "sharp";

/**
 * Masks for touching up a cleaned candidate, as a person would: find what is
 * left of the lettering and inpaint only those pixels, not the whole region.
 */

/** Square dilation by `r` pixels, done as two running-maximum passes. */
export function dilateMask(on: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return on;
  const across = new Uint8Array(on.length);
  for (let y = 0; y < height; y++) {
    // Forward and backward sweeps keep the nearest set pixel within r on either side.
    let seen = -Infinity;
    for (let x = 0; x < width; x++) {
      if (on[y * width + x]) seen = x;
      if (x - seen <= r) across[y * width + x] = 1;
    }
    seen = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (on[y * width + x]) seen = x;
      if (seen - x <= r) across[y * width + x] = 1;
    }
  }
  const out = new Uint8Array(on.length);
  for (let x = 0; x < width; x++) {
    let seen = -Infinity;
    for (let y = 0; y < height; y++) {
      if (across[y * width + x]) seen = y;
      if (y - seen <= r) out[y * width + x] = 1;
    }
    seen = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (across[y * width + x]) seen = y;
      if (seen - y <= r) out[y * width + x] = 1;
    }
  }
  return out;
}

/**
 * Faint leftovers the text detector no longer sees: pixels near the original
 * lettering that stand out from their smoothed surroundings. `grey` and
 * `smooth` are the candidate and its median blur; `letters` is the original
 * lettering mask. Returns the touch-up mask and how many pixels it covers.
 */
export function ghostPixels(
  grey: Uint8Array,
  smooth: Uint8Array,
  letters: Uint8Array,
  width: number,
  height: number,
  { reach = 3, threshold = 18, grow = 3 } = {},
): { mask: Uint8Array; pixels: number } {
  const near = dilateMask(letters, width, height, reach);
  const marks = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++)
    if (near[i] && Math.abs(grey[i] - smooth[i]) > threshold) marks[i] = 1;
  const mask = dilateMask(marks, width, height, grow);
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) pixels++;
  return { mask, pixels };
}

/** {@link ghostPixels} on stored images: a PNG mask (white = inpaint) and its pixel count. */
export async function ghostMask(candidate: Buffer, letters: Buffer): Promise<{ png: Buffer; pixels: number }> {
  const image = sharp(candidate).greyscale();
  const { data: grey, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });
  const smooth = await image.clone().median(9).raw().toBuffer();
  const lettering = await sharp(letters)
    .greyscale()
    .resize(info.width, info.height, { fit: "fill", kernel: "nearest" })
    .raw()
    .toBuffer();
  const on = new Uint8Array(lettering.length);
  for (let i = 0; i < lettering.length; i++) on[i] = lettering[i] > 127 ? 1 : 0;
  const { mask, pixels } = ghostPixels(
    new Uint8Array(grey.buffer, grey.byteOffset, grey.length),
    new Uint8Array(smooth.buffer, smooth.byteOffset, smooth.length),
    on,
    info.width,
    info.height,
  );
  const out = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 255 : 0;
  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  return { png, pixels };
}
