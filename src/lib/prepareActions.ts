import type { ImageRow } from './types';

export type PageUndoSummary = { token: string; label: string; confirmation: string };

export function preparePageLabel(id: string, images: readonly ImageRow[]): string {
  const index = images.findIndex(image => image.id === id);
  return index < 0 ? 'the selected page' : `page ${index + 1} (${images[index].originalName})`;
}

/** Shared by toolbar, context menu, grid and manual page-edit controls. */
export function prepareActionConfirmation(body: Record<string, unknown>, images: readonly ImageRow[]): string | null {
  const op = String(body.op || '');
  const count = Array.isArray(body.imageIds) ? body.imageIds.length : images.filter(image => image.role !== 'pre-credits' && image.role !== 'post-credits').length;
  const target = body.imageId ? preparePageLabel(String(body.imageId), images)
    : Array.isArray(body.imageIds) && body.imageIds.length <= 3 ? body.imageIds.map(id => preparePageLabel(String(id), images)).join('; ')
    : `${count} chapter page${count === 1 ? '' : 's'}`;
  switch (op) {
    case 'crop': return `Crop ${target}? Pixels outside the crop will be removed and saved region positions and lettering will move with the crop.`;
    case 'resize': return `Resize ${target} to ${body.width} × ${body.height} pixels? This changes the image, region geometry, and saved lettering.`;
    case 'nudge': return `Nudge ${target} by ${body.dx}, ${body.dy} pixels? Artwork and saved region positions will move; pixels crossing the page edge will be clipped.`;
    case 'revert': return `Revert ${target} to its original raw image? This replaces the current page pixels.`;
    case 'split': return `Split ${target} into separate pages? This changes page boundaries, order, and region positions.`;
    case 'auto-crop': return `Auto-crop ${target}? Detected margins will be removed and saved region geometry and lettering will be adjusted.`;
    case 'auto-align': return `Auto-align ${target}? This changes page dimensions, padding, and saved region geometry and lettering.`;
    case 'combine': return `Combine ${target} into one spread? Their pixels, regions, and lettering will be moved onto one page.`;
    case 'reslice': return `Split ${target} into ${Array.isArray(body.cuts) ? `${body.cuts.length + 1} page${body.cuts.length ? 's' : ''} using the previewed cuts` : 'new pages using automatic cuts'}? This replaces the current pages and changes boundaries, order, and region positions. Saved cleaning and lettering will be carried across. Later work can prevent Undo from safely restoring the old pages.`;
    case 'reorder': return 'Reorder these chapter pages? This changes the reading order and makes page numbering stale.';
    case 'delete': return `Delete ${target} and all their regions, comments, cleaning and typesetting? This cannot be undone.`;
    default: return null;
  }
}

/** Search in reading order, wrapping once; completion must reflect the current work. */
export function nextUnfinishedPage<T extends { id: string }>(images: readonly T[], currentId: string, done: (id: string) => boolean): T | undefined {
  const current = images.findIndex(image => image.id === currentId);
  if (current < 0) return undefined;
  for (let offset = 1; offset < images.length; offset++) {
    const image = images[(current + offset) % images.length];
    if (!done(image.id)) return image;
  }
  return undefined;
}
