import sharp from "sharp";

export type CleaningRegion = {
  id: string;
  box: [number | null, number | null, number | null, number | null];
};
type Pixels = { data: Buffer; width: number; height: number };
type Interior = {
  mask: Uint8Array;
  x: number;
  y: number;
  width: number;
  height: number;
  colour: number[];
};
export type CleaningResidue = {
  lineId: string;
  pixels: number;
  bounds: { x: number; y: number; w: number; h: number };
  connectedRegionIds: string[];
};
const decode = async (bytes: Buffer): Promise<Pixels> => {
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
function rect(region: CleaningRegion, image: Pixels, padding = 0) {
  const [x, y, w, h] = region.box;
  if (x == null || y == null || !w || !h || !region.box.every(Number.isFinite))
    return;
  const left = Math.max(0, Math.floor(x * image.width) - padding);
  const top = Math.max(0, Math.floor(y * image.height) - padding);
  const right = Math.min(
    image.width,
    Math.ceil((x + w) * image.width) + padding,
  );
  const bottom = Math.min(
    image.height,
    Math.ceil((y + h) * image.height) + padding,
  );
  return right > left && bottom > top
    ? { left, top, right, bottom }
    : undefined;
}
const difference = (data: Buffer, pixel: number, colour: number[]) => {
  const p = pixel * 3;
  return Math.max(
    Math.abs(data[p] - colour[0]),
    Math.abs(data[p + 1] - colour[1]),
    Math.abs(data[p + 2] - colour[2]),
  );
};

/** Find a genuinely enclosed flat interior in RAW, including enclosed glyph
 * holes. An open page background, gradient or border crossing is not evidence
 * that a text area ought to be blank. No editing is performed here. */
function locateInterior(
  image: Pixels,
  region: CleaningRegion,
): Interior | undefined {
  const box = rect(region, image);
  if (!box) return;
  const { width: W, height: H, data } = image;
  const histogram = new Map<number, { count: number; sums: number[] }>();
  for (let y = box.top; y < box.bottom; y++)
    for (let x = box.left; x < box.right; x++) {
      const p = (y * W + x) * 3;
      const key =
        (data[p] >> 4) * 256 + (data[p + 1] >> 4) * 16 + (data[p + 2] >> 4);
      const bin = histogram.get(key) || { count: 0, sums: [0, 0, 0] };
      bin.count++;
      for (let c = 0; c < 3; c++) bin.sums[c] += data[p + c];
      histogram.set(key, bin);
    }
  const dominant = [...histogram.values()].sort((a, b) => b.count - a.count)[0];
  const boxArea = (box.right - box.left) * (box.bottom - box.top);
  if (!dominant || dominant.count < boxArea * 0.55) return;
  const colour = dominant.sums.map((value) =>
    Math.round(value / dominant.count),
  );
  // The centre can be the white counter INSIDE a glyph (e.g. ㅇ or O).
  // Prefer the surrounding background at the text box's corner.
  const cx = box.left,
    cy = box.top;
  let seed = -1,
    distance = Infinity;
  for (let y = box.top; y < box.bottom; y++)
    for (let x = box.left; x < box.right; x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < distance && difference(data, y * W + x, colour) <= 16) {
        seed = y * W + x;
        distance = d;
      }
    }
  if (seed < 0) return;
  const visited = new Uint8Array(W * H),
    queue = new Int32Array(W * H);
  let head = 0,
    tail = 1,
    minX = W,
    minY = H,
    maxX = 0,
    maxY = 0;
  queue[0] = seed;
  visited[seed] = 1;
  while (head < tail) {
    const p = queue[head++],
      x = p % W,
      y = Math.floor(p / W);
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    for (const next of [p - 1, p + 1, p - W, p + W])
      if (!visited[next] && difference(data, next, colour) <= 16) {
        visited[next] = 1;
        queue[tail++] = next;
      }
  }
  if (
    tail < Math.max(400, boxArea * 0.6) ||
    Math.max(maxX - minX, maxY - minY) > W * 0.75
  )
    return;
  const x0 = minX - 1,
    y0 = minY - 1,
    width = maxX - minX + 3,
    height = maxY - minY + 3;
  const outside = new Uint8Array(width * height),
    holes = new Int32Array(width * height);
  head = 0;
  tail = 1;
  outside[0] = 1;
  holes[0] = 0;
  while (head < tail) {
    const p = holes[head++],
      x = p % width,
      y = Math.floor(p / width);
    for (const next of [
      x > 0 ? p - 1 : -1,
      x + 1 < width ? p + 1 : -1,
      y > 0 ? p - width : -1,
      y + 1 < height ? p + width : -1,
    ]) {
      if (next < 0 || outside[next]) continue;
      const nx = (next % width) + x0,
        ny = Math.floor(next / width) + y0;
      if (visited[ny * W + nx]) continue;
      outside[next] = 1;
      holes[tail++] = next;
    }
  }
  const mask = outside.map((value) => (value ? 0 : 1));
  // Require the text box to sit inside the enclosure, rather than intersecting
  // its outline. Border-touching or decorated cases retain visual review.
  let enclosed = 0;
  for (let y = box.top; y < box.bottom; y++)
    for (let x = box.left; x < box.right; x++) {
      const rx = x - x0,
        ry = y - y0;
      if (
        rx >= 0 &&
        ry >= 0 &&
        rx < width &&
        ry < height &&
        mask[ry * width + rx]
      )
        enclosed++;
    }
  if (enclosed < boxArea * 0.98) return;
  return { mask, x: x0, y: y0, width, height, colour };
}

function findInterior(image: Pixels, region: CleaningRegion) {
  const box = rect(region, image);
  if (!box) return;
  // A tall webtoon must not allocate a full-page flood queue for every bubble.
  // An enclosure larger than this bounded context retains visual review.
  const padding = Math.min(
    1024,
    Math.max(64, image.width * 0.5, box.right - box.left, box.bottom - box.top),
  );
  const left = Math.max(0, Math.floor(box.left - padding)),
    top = Math.max(0, Math.floor(box.top - padding));
  const width = Math.min(image.width, Math.ceil(box.right + padding)) - left;
  const height = Math.min(image.height, Math.ceil(box.bottom + padding)) - top;
  if (width * height > 8_000_000) return;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    image.data.copy(
      data,
      y * width * 3,
      ((top + y) * image.width + left) * 3,
      ((top + y) * image.width + left + width) * 3,
    );
  const [x, y, w, h] = region.box as [number, number, number, number];
  const result = locateInterior(
    { data, width, height },
    {
      id: region.id,
      box: [
        (x * image.width - left) / width,
        (y * image.height - top) / height,
        (w * image.width) / width,
        (h * image.height) / height,
      ],
    },
  );
  if (result) {
    result.x += left;
    result.y += top;
  }
  return result;
}

function flatBackground(
  image: Pixels,
  interior: Interior,
  regions: CleaningRegion[],
) {
  const text = regions
    .map((region) => rect(region, image, 6))
    .filter((box): box is NonNullable<typeof box> => !!box);
  let samples = 0,
    offColour = 0;
  for (let ry = 3; ry + 3 < interior.height; ry++)
    for (let rx = 3; rx + 3 < interior.width; rx++) {
      if (
        ![-3, 0, 3].every((dy) =>
          [-3, 0, 3].every(
            (dx) => interior.mask[(ry + dy) * interior.width + rx + dx],
          ),
        )
      )
        continue;
      const x = interior.x + rx,
        y = interior.y + ry;
      if (
        text.some(
          (box) =>
            x >= box.left && x < box.right && y >= box.top && y < box.bottom,
        )
      )
        continue;
      samples++;
      if (difference(image.data, y * image.width + x, interior.colour) > 16)
        offColour++;
    }
  // Screentones, gradients and illustrations belong to visual review. Only a
  // demonstrably flat background makes leftover ink a deterministic failure.
  return samples >= 100 && offColour <= Math.max(6, samples * 0.005);
}

/** White lettering outlines left behind after cleaning lettering drawn over artwork.
 * A pixel counts when it was bright in RAW and is still bright, stands out from the
 * background around the region, and had near-black lettering beside it in RAW that
 * cleaning removed: the letter went, its outline stayed. White artwork keeps its own
 * dark edges, so it is not counted. Light backgrounds are skipped. */
export function outlineResidueInspector(rawBytes: Buffer, regions: CleaningRegion[]) {
  const raw = decode(rawBytes);
  return async (afterBytes: Buffer, ids: string[]) => {
    const before = await raw;
    const after = await decode(afterBytes);
    const findings: { lineId: string; pixels: number }[] = [];
    const min = (img: Pixels, i: number) => Math.min(img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]);
    const max = (img: Pixels, i: number) => Math.max(img.data[i * 3], img.data[i * 3 + 1], img.data[i * 3 + 2]);
    for (const region of regions.filter((r) => ids.includes(r.id))) {
      const box = rect(region, before, 4), outer = rect(region, before, 14);
      if (!box || !outer || after.width !== before.width || after.height !== before.height) continue;
      // Background tone from the cleaned band around the region.
      const band: number[] = [];
      for (let y = outer.top; y < outer.bottom; y += 2)
        for (let x = outer.left; x < outer.right; x += 2)
          if (x < box.left || x >= box.right || y < box.top || y >= box.bottom) band.push(min(after, y * after.width + x));
      if (band.length < 50) continue;
      band.sort((m, n) => m - n);
      const background = band[band.length >> 1];
      if (background >= 190) continue;
      const near = (img: Pixels, x: number, y: number, test: (i: number) => boolean) => {
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < img.width && ny < img.height && test(ny * img.width + nx)) return true;
          }
        return false;
      };
      // Bright pixels joined to bright paper at the edge of the search box are a
      // page gutter or balloon the lettering crossed into, not an outline island.
      const ow = outer.right - outer.left, oh = outer.bottom - outer.top;
      const paper = new Uint8Array(ow * oh), queue: number[] = [];
      const bright = (x: number, y: number) => min(after, y * after.width + x) >= 215;
      for (let y = outer.top; y < outer.bottom; y++)
        for (let x = outer.left; x < outer.right; x++)
          if ((x === outer.left || y === outer.top || x === outer.right - 1 || y === outer.bottom - 1) && bright(x, y)) {
            paper[(y - outer.top) * ow + x - outer.left] = 1; queue.push(x, y);
          }
      while (queue.length) {
        const y = queue.pop()!, x = queue.pop()!;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < outer.left || ny < outer.top || nx >= outer.right || ny >= outer.bottom) continue;
          const k = (ny - outer.top) * ow + nx - outer.left;
          if (paper[k] || !bright(nx, ny)) continue;
          paper[k] = 1; queue.push(nx, ny);
        }
      }
      let pixels = 0;
      for (let y = box.top; y < box.bottom; y++)
        for (let x = box.left; x < box.right; x++) {
          const i = y * before.width + x;
          if (min(before, i) < 215 || min(after, i) < 215 || min(after, i) - background < 50) continue;
          if (paper[(y - outer.top) * ow + x - outer.left]) continue;
          if (!near(before, x, y, (j) => max(before, j) < 60)) continue;
          if (near(after, x, y, (j) => max(after, j) < 60)) continue;
          pixels++;
        }
      if (pixels >= 12) findings.push({ lineId: region.id, pixels });
    }
    return findings;
  };
}

/** Whether each region's lettering sits on balloon paper in RAW: a closed flat
 * interior, or (for borderless balloons on a white page) a flat, light band just
 * outside the lettering box. Narration and SFX drawn over artwork fail both. */
export function flatEnclosureInspector(rawBytes: Buffer) {
  const raw = decode(rawBytes);
  return async (region: CleaningRegion) => {
    const image = await raw;
    const interior = findInterior(image, region);
    if (interior && flatBackground(image, interior, [region])) return true;
    const outer = rect(region, image, 12), inner = rect(region, image, 2);
    if (!outer || !inner) return false;
    const band: number[] = [];
    for (let y = outer.top; y < outer.bottom; y++)
      for (let x = outer.left; x < outer.right; x++)
        if (x < inner.left || x >= inner.right || y < inner.top || y >= inner.bottom)
          band.push(y * image.width + x);
    if (band.length < 100) return false;
    const median = [0, 1, 2].map((c) => {
      const values = band.map((p) => image.data[p * 3 + c]).sort((m, n) => m - n);
      return values[values.length >> 1];
    });
    // Balloon paper is light; a dark or coloured scene behind narration is not.
    if (Math.min(...median) < 200) return false;
    const flat = band.filter((p) => difference(image.data, p, median) <= 24).length;
    return flat >= band.length * 0.85;
  };
}

/** Independent of OCR readability and the Director's "safe" verdict. A partial
 * character, curved stroke or dark smudge still fails a plain-bubble clean. */
export function cleaningResidueInspector(
  rawBytes: Buffer,
  regions: CleaningRegion[],
) {
  const raw = decode(rawBytes);
  const interiors = new Map<string, Promise<Interior | undefined>>();
  const interiorFor = (region: CleaningRegion) => {
    if (!interiors.has(region.id))
      interiors.set(
        region.id,
        raw.then((image) => {
          const interior = findInterior(image, region);
          return interior && flatBackground(image, interior, regions)
            ? interior
            : undefined;
        }),
      );
    return interiors.get(region.id)!;
  };
  return async (
    bytes: Buffer,
    targetIds = regions.map((region) => region.id),
  ): Promise<CleaningResidue[]> => {
    const image = await decode(bytes),
      source = await raw;
    if (image.width !== source.width || image.height !== source.height)
      throw new Error("Cleaning candidate dimensions differ from raw");
    const findings: CleaningResidue[] = [];
    for (const region of regions.filter((region) =>
      targetIds.includes(region.id),
    )) {
      const interior = await interiorFor(region),
        box = rect(region, image, 4);
      if (!interior || !box) continue;
      const { mask, x: ix, y: iy, width: iw, height: ih, colour } = interior;
      const bw = box.right - box.left,
        bh = box.bottom - box.top;
      const ink = new Uint8Array(bw * bh);
      for (let y = box.top; y < box.bottom; y++)
        for (let x = box.left; x < box.right; x++) {
          const rx = x - ix,
            ry = y - iy;
          // A three-pixel inset excludes the border's antialiasing and outline.
          if (rx < 3 || ry < 3 || rx + 3 >= iw || ry + 3 >= ih) continue;
          if (
            ![-3, 0, 3].every((dy) =>
              [-3, 0, 3].every((dx) => mask[(ry + dy) * iw + rx + dx]),
            )
          )
            continue;
          if (difference(image.data, y * image.width + x, colour) >= 32)
            ink[(y - box.top) * bw + x - box.left] = 1;
        }
      let pixels = 0,
        x0 = bw,
        y0 = bh,
        x1 = 0,
        y1 = 0;
      const queue = new Int32Array(ink.length);
      for (let start = 0; start < ink.length; start++) {
        if (!ink[start]) continue;
        let head = 0,
          tail = 1,
          ax = bw,
          ay = bh,
          bx = 0,
          by = 0;
        queue[0] = start;
        ink[start] = 0;
        while (head < tail) {
          const p = queue[head++],
            x = p % bw,
            y = Math.floor(p / bw);
          ax = Math.min(ax, x);
          ay = Math.min(ay, y);
          bx = Math.max(bx, x);
          by = Math.max(by, y);
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx,
                ny = y + dy,
                next = ny * bw + nx;
              if (nx < 0 || ny < 0 || nx >= bw || ny >= bh || !ink[next])
                continue;
              ink[next] = 0;
              queue[tail++] = next;
            }
        }
        if (
          tail < Math.max(6, Math.round((image.width / 700) ** 2 * 6)) ||
          Math.max(bx - ax, by - ay) < 2
        )
          continue;
        pixels += tail;
        x0 = Math.min(x0, ax);
        y0 = Math.min(y0, ay);
        x1 = Math.max(x1, bx);
        y1 = Math.max(y1, by);
      }
      if (!pixels) continue;
      findings.push({
        lineId: region.id,
        pixels,
        bounds: {
          x: (box.left + x0) / image.width,
          y: (box.top + y0) / image.height,
          w: (x1 - x0 + 1) / image.width,
          h: (y1 - y0 + 1) / image.height,
        },
        connectedRegionIds: regions
          .filter((other) => {
            const [x, y, w, h] = other.box;
            if (x == null || y == null || !w || !h) return false;
            const rx = Math.round((x + w / 2) * image.width) - ix,
              ry = Math.round((y + h / 2) * image.height) - iy;
            return (
              rx >= 0 && ry >= 0 && rx < iw && ry < ih && !!mask[ry * iw + rx]
            );
          })
          .map((other) => other.id),
      });
    }
    return findings;
  };
}

export async function cleaningDetailCrop(
  bytes: Buffer,
  region: CleaningRegion,
) {
  const meta = await sharp(bytes).metadata();
  const box = rect(
    region,
    { data: Buffer.alloc(0), width: meta.width!, height: meta.height! },
    8,
  );
  if (!box) throw new Error("Cleaning detail needs valid text bounds");
  return sharp(bytes)
    .extract({
      left: box.left,
      top: box.top,
      width: box.right - box.left,
      height: box.bottom - box.top,
    })
    .resize({ width: 700, height: 700, fit: "inside", kernel: "nearest" })
    .png()
    .toBuffer();
}

/**
 * Share of the masked pixels a cleaner actually changed. An image editor that
 * returns the lettering untouched (page 44: Qwen kept a glowing caption pixel for
 * pixel) changes almost none, and retrying it with a wider mask only costs time.
 */
export async function changedShare(before: Buffer, after: Buffer, mask: Buffer): Promise<number> {
  const a = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = a.info;
  const b = await sharp(after).removeAlpha().resize(width, height, { fit: "fill" }).raw().toBuffer();
  const m = await sharp(mask).greyscale().resize(width, height, { fit: "fill", kernel: "nearest" }).extractChannel(0).raw().toBuffer();
  let inside = 0, changed = 0;
  for (let i = 0; i < width * height; i++) {
    if (m[i] < 128) continue;
    inside++;
    let diff = 0;
    for (let c = 0; c < channels; c++) diff = Math.max(diff, Math.abs(a.data[i * channels + c] - b[i * channels + c]));
    if (diff > 24) changed++;
  }
  return inside ? changed / inside : 1;
}

/** An editor that changed less than this share of the letters left them in place (page 44: 6%; real erases 88-100%). */
export const EDITOR_NO_OP_SHARE = 0.1;

/** Repainted areas with this much more structure than the art around them are blotches. */
export const BLOTCH_RATIO = 3;

/**
 * How much more edge structure the repainted area has than the art around it.
 *
 * Takes the enlarged raw and cleaned crops (aligned, from cleaningDetailCrop). The
 * repainted area is where they differ. Grain is smoothed away first, so what is
 * measured is blotch outlines and smears, not screentone. A clean that continues
 * the background scores about 1; page 15's LaMa smudges scored 4.2, while good
 * cleans with line art running through them stayed under 2.
 */
export async function repaintStructure(rawCrop: Buffer, cleanedCrop: Buffer): Promise<{ ratio: number; pixels: number }> {
  const a = await sharp(rawCrop).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(cleanedCrop).removeAlpha().raw().toBuffer();
  const { width, height, channels } = a.info;
  if (b.length !== a.data.length) return { ratio: 0, pixels: 0 };
  const changed = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    let diff = 0;
    for (let c = 0; c < channels; c++) diff = Math.max(diff, Math.abs(a.data[i * channels + c] - b[i * channels + c]));
    if (diff > 24) changed[i] = 255;
  }
  const grow = (sigma: number) => sharp(changed, { raw: { width, height, channels: 1 } })
    .blur(sigma).threshold(16).extractChannel(0).raw().toBuffer();
  const [inside, outer] = await Promise.all([grow(2), grow(8)]);
  const grey = await sharp(cleanedCrop).removeAlpha().greyscale().blur(2).extractChannel(0).raw().toBuffer();
  const inner: number[] = [], ring: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!outer[i]) continue;
      const gx = grey[i - width + 1] + 2 * grey[i + 1] + grey[i + width + 1] - grey[i - width - 1] - 2 * grey[i - 1] - grey[i + width - 1];
      const gy = grey[i + width - 1] + 2 * grey[i + width] + grey[i + width + 1] - grey[i - width - 1] - 2 * grey[i - width] - grey[i - width + 1];
      (inside[i] ? inner : ring).push(Math.hypot(gx, gy));
    }
  }
  if (inner.length < 64 || ring.length < 64) return { ratio: 0, pixels: inner.length };
  const p90 = (values: number[]) => values.sort((m, n) => m - n)[Math.floor(values.length * 0.9)];
  return { ratio: p90(inner) / Math.max(1, p90(ring)), pixels: inner.length };
}

export async function cleaningComparison(raw:Buffer,cleaned:Buffer) {
  const size=await sharp(raw).metadata(),other=await sharp(cleaned).metadata();
  if(size.width!==other.width||size.height!==other.height)throw new Error("Cleaning comparison crops must align");
  const width=size.width!,height=size.height!,gap=12,header=36;
  const labels=Buffer.from(`<svg width="${width*2+gap}" height="${header}"><g font-family="sans-serif" font-size="24" fill="white" text-anchor="middle"><text x="${width/2}" y="27">RAW SOURCE</text><text x="${width*1.5+gap}" y="27">CLEANED RESULT</text></g></svg>`);
  return sharp({create:{width:width*2+gap,height:height+header,channels:3,background:'#181818'}})
    .composite([{input:raw,left:0,top:header},{input:cleaned,left:width+gap,top:header},{input:labels,left:0,top:0}]).png().toBuffer();
}

/** Lettering masks often omit the white outline/shadow outside OCR bounds.
 * Keep the same small, pixel-scaled margin for editing and close-up review. */
function cleaningArtworkCore(
  bounds: { x: number; y: number; w: number; h: number },
  size: { width: number; height: number },
) {
  const padding = 4 + Math.max(8, Math.min(24, Math.ceil(Math.max(
    8 * size.width / 700, bounds.h * size.height * 0.15,
  ))));
  const x = Math.max(0, bounds.x - padding / size.width);
  const y = Math.max(0, bounds.y - padding / size.height);
  return {
    x, y,
    w: Math.min(1, bounds.x + bounds.w + padding / size.width) - x,
    h: Math.min(1, bounds.y + bounds.h + padding / size.height) - y,
  };
}

export function cleaningArtworkBounds(
  bounds:{x:number;y:number;w:number;h:number},size:{width:number;height:number},
) {
  const core=cleaningArtworkCore(bounds,size),padding=Math.max(8,Math.ceil(size.width*8/700));
  const x=Math.max(0,core.x-padding/size.width),y=Math.max(0,core.y-padding/size.height);
  return {x,y,w:Math.min(1,core.x+core.w+padding/size.width)-x,h:Math.min(1,core.y+core.h+padding/size.height)-y};
}

/** A straight dark stroke just outside the text box is artwork, not lettering,
 * when RAW shows its continuation on both sides. Check its surviving RAW
 * pixels independently of the visual model, which can overlook erased borders.
 * This only rejects damage; it never draws or extrapolates a border. */
export function cleaningBoundaryInspector(rawBytes: Buffer, regions: CleaningRegion[]) {
  const raw = decode(rawBytes);
  return async (candidateBytes: Buffer, targetIds: string[]) => {
    if (!targetIds.length) return [];
    const [source, candidate] = await Promise.all([raw, decode(candidateBytes)]);
    if (source.width !== candidate.width || source.height !== candidate.height)
      throw new Error("Cleaning output has the wrong dimensions");
    const findings: Omit<CleaningResidue, "connectedRegionIds">[] = [];
    const dark = (image: Pixels, x: number, y: number) =>
      difference(image.data, y * image.width + x, [0, 0, 0]) < 80;
    const margin = Math.max(4, Math.min(24, Math.ceil(source.width * 12 / 700)));
    const support = Math.max(8, Math.ceil(source.width * 16 / 700));
    for (const region of regions.filter((r) => targetIds.includes(r.id))) {
      const box = rect(region, source);
      if (!box) continue;
      const lost = new Set<number>();
      for (const vertical of [true, false]) {
        const lo = vertical ? box.left : box.top, hi = vertical ? box.right : box.bottom;
        const start = vertical ? box.top : box.left, end = vertical ? box.bottom : box.right;
        const across = vertical ? source.width : source.height, along = vertical ? source.height : source.width;
        if (start < support || end + support >= along) continue;
        const point = (axis: number, pos: number) => vertical ? [axis, pos] : [pos, axis];
        for (let axis = Math.max(0, lo - margin); axis < Math.min(across, hi + margin); axis++) {
          if (axis >= lo && axis < hi) continue;
          let before = 0, after = 0;
          for (let n = 1; n <= support; n++) {
            const [bx, by] = point(axis, start - n), [ax, ay] = point(axis, end + n);
            if (dark(source, bx, by)) before++;
            if (dark(source, ax, ay)) after++;
          }
          if (Math.min(before, after) < support * .9) continue;
          const missing: number[] = [];
          let original = 0;
          for (let pos = start; pos < end; pos++) {
            const [x, y] = point(axis, pos), p = y * source.width + x;
            if (!dark(source, x, y)) continue;
            original++;
            if (difference(candidate.data, p, [...source.data.subarray(p * 3, p * 3 + 3)]) >= 64)
              missing.push(p);
          }
          if (missing.length >= Math.max(6, original * .15))
            for (const p of missing) lost.add(p);
        }
      }
      if (!lost.size) continue;
      let x = source.width, y = source.height, right = 0, bottom = 0;
      for (const p of lost) {
        const px = p % source.width, py = Math.floor(p / source.width);
        x = Math.min(x, px); y = Math.min(y, py);
        right = Math.max(right, px); bottom = Math.max(bottom, py);
      }
      findings.push({ lineId: region.id, pixels: lost.size, bounds: {
        x: x / source.width, y: y / source.height,
        w: (right - x + 1) / source.width,
        h: (bottom - y + 1) / source.height,
      } });
    }
    return findings;
  };
}

/** Blend only the spare margin, keeping the entire lettering box and its
 * outline opaque. Protected mask pixels stay zero. */
export async function featherCleaningMask(bytes: Buffer, region: CleaningRegion) {
  const {data,info} = await sharp(bytes).greyscale().raw().toBuffer({resolveWithObject:true});
  const image = {data:Buffer.alloc(0),width:info.width,height:info.height};
  if (!rect(region,image)) throw new Error("Cleaning blend needs valid bounds");
  const [x,y,w,h] = region.box as [number,number,number,number];
  const opaque=cleaningArtworkCore({x,y,w,h},info);
  const core=rect({id:region.id,box:[opaque.x,opaque.y,opaque.w,opaque.h]},image)!;
  const padded = cleaningArtworkBounds({x,y,w,h},info);
  const edge = rect({id:region.id,box:[padded.x,padded.y,padded.w,padded.h]},image)!;
  const fade = (distance:number,space:number) => space<=0?1:Math.min(1,Math.max(0,(space-distance)/space));
  // Native polygon masks include the last row/column; normalized bounds use an
  // exclusive edge. Process every selected pixel so no opaque one-pixel rim
  // survives outside the calculated feather rectangle.
  for(let py=0;py<info.height;py++)for(let px=0;px<info.width;px++) {
    if(!data[py*info.width+px])continue;
    const alpha = Math.min(
      fade(core.left-px-.5,core.left-edge.left),fade(px+.5-core.right,edge.right-core.right),
      fade(core.top-py-.5,core.top-edge.top),fade(py+.5-core.bottom,edge.bottom-core.bottom),
    );
    data[py*info.width+px]=Math.round(data[py*info.width+px]*alpha);
  }
  return sharp(data,{raw:{width:info.width,height:info.height,channels:1}}).png().toBuffer();
}

/** Long new colour steps at the whole-region mask edge expose rectangular
 * inpainting tiles. Ignore edges already present in RAW and isolated noise. */
export function cleaningSeamInspector(rawBytes:Buffer,regions:CleaningRegion[]) {
  let sourcePromise:Promise<Pixels>|undefined;
  return async(candidateBytes:Buffer,targetIds:string[])=>{
    if(!targetIds.length)return [];
    const [raw,candidate]=await Promise.all([sourcePromise??=decode(rawBytes),decode(candidateBytes)]);
    if(raw.width!==candidate.width||raw.height!==candidate.height)throw new Error("Cleaning output has the wrong dimensions");
    const findings:Omit<CleaningResidue,"connectedRegionIds">[]=[];
    const step=(image:Pixels,p:number,q:number)=>difference(image.data,p,[...image.data.subarray(q*3,q*3+3)]);
    for(const region of regions.filter(r=>targetIds.includes(r.id))) {
      if(region.box.some(v=>v==null))continue;
      const [x,y,w,h]=region.box as [number,number,number,number];
      const b=cleaningArtworkBounds({x,y,w,h},raw);
      const edge=rect({id:region.id,box:[b.x,b.y,b.w,b.h]},raw);if(!edge)continue;
      let pixels=0;
      for(const vertical of [true,false])for(const axis of vertical?[edge.left,edge.right]:[edge.top,edge.bottom]) {
        const limit=vertical?raw.width:raw.height;
        if(axis<=0||axis>=limit)continue;
        const start=vertical?edge.top:edge.left,end=vertical?edge.bottom:edge.right;
        let run=0,longest=0;
        // Rounding a normalized edge can put the native mask one pixel away.
        for(let offset=-1;offset<=1;offset++) {
          const a=axis+offset;if(a<=0||a>=limit)continue;run=0;
          for(let pos=start;pos<end;pos++) {
            const p=vertical?pos*raw.width+a:a*raw.width+pos,q=vertical?p-1:p-raw.width;
            const defect=step(raw,p,q)<4 && step(candidate,p,q)>=4;
            run=defect?run+1:0;longest=Math.max(longest,run);
          }
        }
        if(longest>=Math.max(24,Math.ceil(raw.width*.06)))pixels+=longest;
      }
      if(pixels)findings.push({lineId:region.id,pixels,bounds:{x:b.x,y:b.y,w:b.w,h:b.h}});
    }
    return findings;
  };
}
