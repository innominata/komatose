/** CSS box vs letterboxed bitmap, as with object-fit: contain. */
export function containDisplayRect(
  box: { left: number; top: number; width: number; height: number },
  contentWidth: number,
  contentHeight: number,
) {
  if (contentWidth <= 0 || contentHeight <= 0 || box.width <= 0 || box.height <= 0)
    return { left: box.left, top: box.top, width: 0, height: 0, scale: 0 };
  const scale = Math.min(box.width / contentWidth, box.height / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
    scale,
  };
}

export function containContentPoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  contentWidth: number,
  contentHeight: number,
) {
  const shown = containDisplayRect(box, contentWidth, contentHeight);
  if (!shown.width || !shown.height) return null;
  return {
    x: ((clientX - shown.left) / shown.width) * contentWidth,
    y: ((clientY - shown.top) / shown.height) * contentHeight,
    shown,
  };
}
