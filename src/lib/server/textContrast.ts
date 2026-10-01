import sharp from "sharp";
import type { Point } from "../workflow";

/** Median background luminance inside the polygon ignores sparse source glyphs. */
export async function contrastingText(bytes: Buffer, polygon: Point[]): Promise<"#000000" | "#ffffff"> {
  const { data, info } = await sharp(bytes).resize(160, 160, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const inside = (x: number, y: number) => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  };
  const values: number[] = [];
  const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (!inside((x + 0.5) / info.width, (y + 0.5) / info.height)) continue;
    const i = (y * info.width + x) * info.channels;
    values.push(0.2126 * linear(data[i] / 255) + 0.7152 * linear(data[i + 1] / 255) + 0.0722 * linear(data[i + 2] / 255));
  }
  values.sort((a, b) => a - b);
  const luminance = values[Math.floor(values.length / 2)] ?? 1;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
