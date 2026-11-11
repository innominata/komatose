/** Magic wand for the text mask: selects the contiguous area of similar colour around a click. */

export const WAND_TOLERANCE_MIN = 0;
export const WAND_TOLERANCE_MAX = 255;
export const WAND_TOLERANCE_DEFAULT = 32;
export const WAND_GROW_MAX = 8;
export const WAND_GROW_DEFAULT = 1;

export type WandWindow = { left: number; top: number; width: number; height: number };

/**
 * Pixels connected to the seed (4-connected) whose every channel is within `tolerance` of the
 * seed colour, then grown outwards by `grow` pixels so anti-aliased edges are covered.
 * `pixels` holds the window only, `channels` bytes per pixel; the seed is in window coordinates.
 * Returns one byte per window pixel: 1 selected, 0 not.
 */
export function wandSelect(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  seedX: number,
  seedY: number,
  tolerance: number,
  grow = 0,
): Uint8Array {
  const sel = new Uint8Array(width * height);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return sel;
  const colour = Math.min(channels, 3);
  const seed = (seedY * width + seedX) * channels;
  const ref = Array.from({ length: colour }, (_, c) => pixels[seed + c]);
  const near = (i: number) => {
    const o = i * channels;
    for (let c = 0; c < colour; c++) if (Math.abs(pixels[o + c] - ref[c]) > tolerance) return false;
    return true;
  };
  const stack = new Int32Array(width * height);
  let top = 0;
  stack[top++] = seedY * width + seedX;
  sel[seedY * width + seedX] = 1;
  while (top) {
    const i = stack[--top];
    const x = i % width;
    const visit = (j: number) => {
      if (!sel[j] && near(j)) {
        sel[j] = 1;
        stack[top++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < width * (height - 1)) visit(i + width);
  }
  return grow > 0 ? dilate(sel, width, height, grow) : sel;
}

/** Grows a selection by `steps` pixels (8-connected, so corners grow evenly enough). */
export function dilate(sel: Uint8Array, width: number, height: number, steps: number): Uint8Array {
  let cur = sel;
  for (let s = 0; s < steps; s++) {
    const next = new Uint8Array(cur);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        if (cur[y * width + x]) continue;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < width && cur[yy * width + xx]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) next[y * width + x] = 1;
      }
    cur = next;
  }
  return cur;
}

/**
 * The part of the page the wand may fill: the region's box padded by half its larger side
 * (at least 48 px), so a balloon outline that touches a panel border cannot flood the page.
 */
export function wandWindow(
  box: { x: number; y: number; w: number; h: number },
  pageWidth: number,
  pageHeight: number,
): WandWindow {
  const bx = box.x * pageWidth, by = box.y * pageHeight, bw = box.w * pageWidth, bh = box.h * pageHeight;
  const pad = Math.max(48, Math.max(bw, bh) / 2);
  const left = Math.max(0, Math.floor(bx - pad)), top = Math.max(0, Math.floor(by - pad));
  const right = Math.min(pageWidth, Math.ceil(bx + bw + pad)), bottom = Math.min(pageHeight, Math.ceil(by + bh + pad));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
