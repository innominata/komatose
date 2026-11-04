/** Reusable series graphics and independent page placements, in native pixels. */
export type CleanAsset = {
  id: string;
  name: string;
  hash: string;
  width: number;
  height: number;
};
export type PlacedAsset = CleanAsset & {
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
};
export const ASSET_DRAG_TYPE = "application/x-komatose-clean-asset";
