/** Start the clipboard write during the click; resolve PNG bytes after pending saves. */
export function copyPngToClipboard(load: () => Promise<Blob>) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('Image clipboard access needs a supported browser over HTTPS or localhost.');
  const png = load();
  // A denied clipboard request can finish before image preparation does.
  void png.catch(() => {});
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
