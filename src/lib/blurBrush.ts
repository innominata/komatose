/** Gaussian sigma for the blur brush; grows with brush size. */
export function blurSigma(radius: number) {
  return Math.max(0.8, Math.max(1, radius) * 0.5);
}

/** Smoothstep coverage at `distance` from a brush centre of `radius`. */
export function blurFeather(distance: number, radius: number) {
  const r = Math.max(1, radius);
  const t = Math.min(1, Math.max(0, distance / r));
  return 1 - t * t * (3 - 2 * t);
}
