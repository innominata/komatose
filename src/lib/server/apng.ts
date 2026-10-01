/**
 * Small Animated PNG writer. libvips reads animated PNG but cannot encode one,
 * so frames are filtered and deflated here and wrapped in the acTL/fcTL/fdAT
 * chunks the APNG spec adds on top of an ordinary PNG.
 */
import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "latin1");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  typeBytes.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([header, data, crc]);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dl = Math.abs(estimate - left);
  const du = Math.abs(estimate - up);
  const dul = Math.abs(estimate - upLeft);
  if (dl <= du && dl <= dul) return left;
  return du <= dul ? up : upLeft;
}

const FILTER_TYPES = [0, 1, 2, 3, 4] as const;

function filterRow(
  type: number,
  row: Buffer,
  previous: Buffer,
  bytesPerPixel: number,
  out: Buffer,
): void {
  for (let x = 0; x < row.length; x++) {
    const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
    const up = previous[x];
    const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
    let value: number;
    switch (type) {
      case 1:
        value = row[x] - left;
        break;
      case 2:
        value = row[x] - up;
        break;
      case 3:
        value = row[x] - ((left + up) >> 1);
        break;
      case 4:
        value = row[x] - paeth(left, up, upLeft);
        break;
      default:
        value = row[x];
    }
    out[x] = value & 0xff;
  }
}

function filterScore(row: Buffer): number {
  let score = 0;
  for (let i = 0; i < row.length; i++)
    score += row[i] < 128 ? row[i] : 256 - row[i];
  return score;
}

/** Adaptive PNG filtering, one filter type per row, then a single zlib stream. */
function scanlines(pixels: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const previous = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let bestType = 0;
    let bestScore = Infinity;
    for (const type of FILTER_TYPES) {
      filterRow(type, row, previous, channels, candidate);
      const score = filterScore(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestType = type;
      }
    }
    filterRow(bestType, row, previous, channels, candidate);
    filtered[y * (stride + 1)] = bestType;
    candidate.copy(filtered, y * (stride + 1) + 1);
    row.copy(previous);
  }
  return deflateSync(filtered, { level: 9 });
}

export type ApngOptions = {
  width: number;
  height: number;
  channels: 3 | 4;
  /** Display time for every frame. */
  delayMs?: number;
  /** Play count; 0 loops forever. */
  loop?: number;
};

/** Raw (unfiltered) pixel frames in, an animated PNG out. */
export function encodeApng(frames: Buffer[], options: ApngOptions): Buffer {
  const { width, height, channels } = options;
  if (!frames.length) throw new Error("APNG needs at least one frame");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("APNG needs whole pixel dimensions");
  const stride = width * channels;
  for (const frame of frames)
    if (frame.length !== stride * height)
      throw new Error("APNG frame size does not match the image size");
  const delayMs = Math.round(options.delayMs ?? 500);
  if (delayMs < 1 || delayMs > 65535) throw new Error("APNG delay must be 1-65535 ms");

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = channels === 4 ? 6 : 2; // truecolour, with alpha only when asked for
  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames.length, 0);
  control.writeUInt32BE(options.loop ?? 0, 4);

  const parts: Buffer[] = [SIGNATURE, chunk("IHDR", header), chunk("acTL", control)];
  let sequence = 0;
  frames.forEach((frame, index) => {
    const frameControl = Buffer.alloc(26);
    frameControl.writeUInt32BE(sequence++, 0);
    frameControl.writeUInt32BE(width, 4);
    frameControl.writeUInt32BE(height, 8);
    frameControl.writeUInt32BE(0, 12); // x offset
    frameControl.writeUInt32BE(0, 16); // y offset
    frameControl.writeUInt16BE(delayMs, 20); // numerator
    frameControl.writeUInt16BE(1000, 22); // denominator makes the unit 1 ms
    frameControl[24] = 0; // APNG_DISPOSE_OP_NONE: the next frame replaces this one whole
    frameControl[25] = 0; // APNG_BLEND_OP_SOURCE
    parts.push(chunk("fcTL", frameControl));
    const image = scanlines(frame, width, height, channels);
    if (index === 0) {
      parts.push(chunk("IDAT", image));
      return;
    }
    const payload = Buffer.alloc(4 + image.length);
    payload.writeUInt32BE(sequence++, 0);
    image.copy(payload, 4);
    parts.push(chunk("fdAT", payload));
  });
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
