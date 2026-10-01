import sharp from "sharp";
import { storeAsset } from "./workflowStore";

export const PAGE_THUMB_WIDTH = 160;

export async function storePageThumbnail(source: Buffer) {
  return storeAsset(
    await sharp(source)
      .resize({ width: PAGE_THUMB_WIDTH, withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  );
}
