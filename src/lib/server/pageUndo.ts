import type { GeometrySnapshot } from './pageGeometry';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { episodeDir } from './storage';

export type PageUndoOp =
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
	  };

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
	log.push(op);
	await writeFile(undoPath(seriesSlug, episodeSlug), JSON.stringify(log));
}

export async function popUndo(
	seriesSlug: string,
	episodeSlug: string
): Promise<PageUndoOp | null> {
	const log = await readUndoLog(seriesSlug, episodeSlug);
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
		if (op.type === 'split') return !deleted.has(op.originalId) && !deleted.has(op.createdId);
		if (op.type === 'reslice') return ![...op.createdIds, ...op.previous.map(page => page.id)].some(id => deleted.has(id));
		return true;
	}).map(op => op.type === 'reorder' || op.type === 'split'
		? { ...op, order: op.order.filter(page => !deleted.has(page.id)) } : op);
	if (kept.length !== log.length || JSON.stringify(kept) !== JSON.stringify(log))
		await writeFile(undoPath(seriesSlug, episodeSlug), JSON.stringify(kept));
}
