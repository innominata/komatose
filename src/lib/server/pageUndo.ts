import type { GeometrySnapshot } from './pageGeometry';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { preparePageLabel, type PageUndoSummary } from '../prepareActions';
import { episodeDir } from './storage';

import type { ImageRow } from '../types';

export type PageUndoOp = { description?: string; undoId?: string } & (
	| { type: 'combine'; originalId: string; removed: ImageRow; geometry: Record<string, GeometrySnapshot> }
	| { type: 'pixels'; imageId: string; imageIds?: string[]; geometry?: Record<string, GeometrySnapshot> }
	| { type: 'reorder'; order: { id: string; sortOrder: number }[] }
	| {
			type: 'split';
			originalId: string;
			createdId: string;
			order: { id: string; sortOrder: number }[];
	  }
	| {
			type: 'reslice';
			dir: string;
			previous: {
				id: string;
				episodeId: string;
				filename: string;
				originalName: string;
				sortOrder: number;
				width: number;
				height: number;
				dpi?: number;
				caption: string;
				role?: string;
				createdAt: number;
				updatedAt: number;
			}[];
			createdIds: string[];
			/** Saved layers and complete region documents before changing page boundaries. */
			geometry?: Record<string, GeometrySnapshot>;
			/** Full chapter order before the reslice, so undo can put moved pages back. */
			order?: {
				id: string;
				sortOrder: number;
			}[];
			lines: {
				id: string;
				imageId: string | null;
				x: number | null;
				y: number | null;
				w: number | null;
				h: number | null;
				revision?: number;
			}[];
	  });

export function pageUndoToken(op: PageUndoOp): string {
	return createHash('sha256').update(JSON.stringify(op)).digest('hex');
}

export function pageUndoSummary(op: PageUndoOp | undefined, images: readonly ImageRow[]): PageUndoSummary | null {
	if (!op) return null;
	let label: string, effect: string, ids: string[];
	switch (op.type) {
		case 'reslice':
			label = `Reslice ${op.previous.length} → ${op.createdIds.length} pages`;
			effect = `Remove ${op.createdIds.length} sliced page${op.createdIds.length === 1 ? '' : 's'} and restore ${op.previous.length} previous page${op.previous.length === 1 ? '' : 's'}, their order, saved artwork, region positions and lettering. Undo is stopped if those sliced pages contain later work.`;
			ids = op.createdIds; break;
		case 'split':
			label = 'Split page into two halves';
			effect = 'Remove the added half and restore the original page pixels and page order. Regions on the removed half can become unassigned.';
			ids = [op.originalId, op.createdId]; break;
		case 'combine':
			label = 'Combine pages into a spread';
			effect = 'Restore the two separate pages, their saved artwork, region positions and lettering.';
			ids = [op.originalId]; break;
		case 'reorder':
			label = 'Reorder chapter pages'; effect = 'Restore the previous chapter page order.';
			ids = op.order.map(page => page.id); break;
		case 'pixels':
			label = op.description || 'Edit page artwork';
			effect = op.geometry ? 'Restore the previous image pixels and the saved cleaning, region positions and lettering captured before this edit.' : 'Restore the previous image pixels.';
			ids = op.imageIds?.length ? op.imageIds : [op.imageId]; break;
	}
	if (op.type !== 'pixels') label = op.description || label;
	const pages = ids.slice(0, 3).map(id => preparePageLabel(id, images)).join('; ');
	const affected = `${pages}${ids.length > 3 ? `; and ${ids.length - 3} more pages` : ''}`;
	return { token: pageUndoToken(op), label: `Undo: ${label}${ids.length === 1 ? ` · ${pages}` : ''}`, confirmation: `Undo “${label}”?\n\nAffected: ${affected}.\n\n${effect}` };
}

function undoPath(seriesSlug: string, episodeSlug: string) {
	return join(episodeDir(seriesSlug, episodeSlug), 'undo.json');
}

export async function readUndoLog(seriesSlug: string, episodeSlug: string): Promise<PageUndoOp[]> {
	const path = undoPath(seriesSlug, episodeSlug);
	if (!existsSync(path)) return [];
	try {
		const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
		return Array.isArray(data) ? (data as PageUndoOp[]) : [];
	} catch {
		return [];
	}
}

export async function pushUndo(
	seriesSlug: string,
	episodeSlug: string,
	op: PageUndoOp
): Promise<void> {
	const log = await readUndoLog(seriesSlug, episodeSlug);
	log.push({ ...op, undoId: randomUUID() });
	await writeFile(undoPath(seriesSlug, episodeSlug), JSON.stringify(log));
}

export async function popUndo(
	seriesSlug: string,
	episodeSlug: string,
	expectedToken?: string,
): Promise<PageUndoOp | null> {
	const log = await readUndoLog(seriesSlug, episodeSlug);
	if (expectedToken !== undefined && (!log.length || pageUndoToken(log[log.length - 1]) !== expectedToken))
		throw Object.assign(new Error('The next undo action changed. Review its updated description and confirm again.'), { status: 409 });
	const op = log.pop() || null;
	await writeFile(undoPath(seriesSlug, episodeSlug), JSON.stringify(log));
	return op;
}

/** Deleted pages must not be recreated by an older split/reslice operation. */
export async function discardDeletedPageUndo(seriesSlug: string, episodeSlug: string, imageIds: string[]) {
	const deleted = new Set(imageIds);
	const log = await readUndoLog(seriesSlug, episodeSlug);
	const kept = log.filter(op => {
		if (op.type === 'pixels') return ![op.imageId, ...(op.imageIds ?? [])].some(id => deleted.has(id));
		if (op.type === 'combine') return !deleted.has(op.originalId) && !deleted.has(op.removed.id);
		if (op.type === 'split') return !deleted.has(op.originalId) && !deleted.has(op.createdId);
		if (op.type === 'reslice') return ![...op.createdIds, ...op.previous.map(page => page.id)].some(id => deleted.has(id));
		return true;
	}).map(op => op.type === 'reorder' || op.type === 'split'
		? { ...op, order: op.order.filter(page => !deleted.has(page.id)) } : op);
	if (kept.length !== log.length || JSON.stringify(kept) !== JSON.stringify(log))
		await writeFile(undoPath(seriesSlug, episodeSlug), JSON.stringify(kept));
}
