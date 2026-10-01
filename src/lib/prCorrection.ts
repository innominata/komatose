import type { CommentRow, LineRow } from './types';

/** Latest proofreader correction on a line, if any. */
export function correctionFor(comments: CommentRow[], lineId: string): CommentRow | null {
	let best: CommentRow | null = null;
	for (const c of comments) {
		if (c.lineId !== lineId || !c.correction) continue;
		if (!best || c.createdAt >= best.createdAt) best = c;
	}
	return best;
}

export function latestCommentFor(comments: CommentRow[], lineId: string): string | null {
	let best: CommentRow | null = null;
	for (const c of comments) {
		if (c.lineId !== lineId) continue;
		if (!best || c.createdAt >= best.createdAt) best = c;
	}
	return best?.body ?? null;
}

export function stickyMainText(line: LineRow, comments: CommentRow[]): string {
	return correctionFor(comments, line.id)?.body ?? line.body;
}

export function stickyRedText(line: LineRow, comments: CommentRow[]): string | null {
	return correctionFor(comments, line.id) ? line.body : latestCommentFor(comments, line.id);
}
