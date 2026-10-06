import { json } from '@sveltejs/kit';
import {
	assertEpisodeIdle,
	fail,
	messageOf,
	requireEpisodeAccess,
	requireClean,
	requireStickies,
	requireUpload,
	requireUser,
	statusOf
} from '$lib/server/http';
import { isRegionQueueBusy } from '$lib/server/aiTranslate';
import { parseTranslateEngine } from '$lib/server/cliTranslate';
import {
	combineSpread,
	autoAlignPages,
	autoCropPages,
	addSeriesCredits,
	cropPage,
	nudgePage,
	PageEditError,
	reorderPages,
	resizePage,
	revertPageToRaw,
	setCaption,
	splitSpread,
	splitWideSpreads,
	startDescribePages,
	undoPageOp
} from '$lib/server/pageEdit';
import { previewReslice, startReslice, ResliceError } from '$lib/server/reslice';
import { readUndoLog } from '$lib/server/pageUndo';
import { deletePages, extractPages } from '$lib/server/pageSelection';
import type { RequestHandler } from './$types';

function box(body: Record<string, unknown>) {
	return {
		x: Number(body.x),
		y: Number(body.y),
		w: Number(body.w),
		h: Number(body.h)
	};
}

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		const undo = await readUndoLog(series.slug, episode.slug);
		return json({ ok: true, undoCount: undo.length });
	} catch (e) {
		return fail(statusOf(e),messageOf(e),e&&typeof e==='object'&&'current' in e?{current:e.current}:undefined);
	}
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const { episode, series } = await requireEpisodeAccess(user, params.eid);
		assertEpisodeIdle(episode.id);
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const op = String(body.op || '');
		const ctx = { series, episode, user };

		if (op === 'caption') {
			requireStickies(user);
			const image = await setCaption(ctx, String(body.imageId || ''), String(body.caption || ''),typeof body.expectedRevision==='number'?body.expectedRevision:undefined);
			return json({ ok: true, image });
		}

		if (op === 'describe') {
			requireUpload(user);
			return json(
				startDescribePages(
					ctx,
					Array.isArray(body.imageIds) ? (body.imageIds as string[]) : undefined,
					Boolean(body.overwrite),
					parseTranslateEngine(body.engine),
					typeof body.model === 'string' ? body.model : undefined
				),
				{ status: 202 }
			);
		}
		if (op === 'reslice-preview') {
			requireUpload(user);
			return json(
				await previewReslice(
					ctx,
					Array.isArray(body.imageIds) ? (body.imageIds as string[]) : undefined
				)
			);
		}
		if (op === 'reslice') {
			requireUpload(user);
			const cuts = Array.isArray(body.cuts)
				? body.cuts.map((n) => Number(n)).filter((n) => Number.isFinite(n))
				: undefined;
			return json(
				startReslice(ctx, {
					imageIds: Array.isArray(body.imageIds) ? (body.imageIds as string[]) : undefined,
					cuts
				}),
				{ status: 202 }
			);
		}

		if (op === 'revert') {
			requireClean(user);
			const image = await revertPageToRaw(ctx, String(body.imageId || ''));
			return json({ ok: true, image });
		}

		requireUpload(user);
		if (isRegionQueueBusy(episode.id)) {
			return fail(409, 'Finish or cancel queued translates before changing pages');
		}

		if (op === 'combine') return json({ ok: true, image: await combineSpread(ctx, body.imageIds) });
		if (op === 'delete') return json({ ok: true, ...await deletePages(ctx, body.imageIds) });
		if (op === 'extract') return json({ ok: true, chapter: await extractPages(ctx, body.imageIds, body.chapterNumber) }, { status: 201 });
		if (op === 'add-credits') return json({ ok: true, ...await addSeriesCredits(ctx) });

		if (op === 'undo') {
			const result = await undoPageOp(ctx);
			return json({ ok: true, ...result });
		}
		if (op === 'crop') {
			const image = await cropPage(ctx, String(body.imageId || ''), box(body));
			return json({ ok: true, image });
		}
		if (op === 'resize') {
			const image = await resizePage(ctx, String(body.imageId || ''), Number(body.width), Number(body.height));
			return json({ ok: true, image });
		}
		if (op === 'nudge') {
			const fill = body.fill === 'white' || body.fill === 'black' ? body.fill : 'auto';
			const image = await nudgePage(ctx, String(body.imageId || ''), Number(body.dx), Number(body.dy), fill);
			return json({ ok: true, image });
		}
		if (op === 'auto-crop') {
			const images = await autoCropPages(
				ctx,
				Array.isArray(body.imageIds) ? (body.imageIds as string[]) : undefined
			);
			return json({ ok: true, images });
		}
		if (op === 'auto-align') {
			const images = await autoAlignPages(ctx);
			return json({ ok: true, images });
		}
		if (op === 'split') {
			const force = Boolean(body.force);
			const imageIds = Array.isArray(body.imageIds)
				? body.imageIds.filter((id): id is string => typeof id === 'string')
				: undefined;
			const at = Number(body.at);
			if (body.imageId) {
				const images = await splitSpread(ctx, String(body.imageId), {
					force,
					at: Number.isFinite(at) ? at : undefined
				});
				return json({ ok: true, images, skipped: [] });
			}
			const { images, skipped } = await splitWideSpreads(ctx, { force, imageIds });
			return json({ ok: true, images, skipped });
		}
		if (op === 'reorder') {
			const order = body.order as { id: string; sortOrder: number }[];
			if (!Array.isArray(order)) return fail(400, 'Invalid order');
			await reorderPages(ctx, order);
			return json({ ok: true });
		}
		return fail(400, 'Unknown page operation');
	} catch (e) {
		if (e instanceof PageEditError) {
			return fail(e.status, e.message, e.code ? { code: e.code } : undefined);
		}
		if (e instanceof ResliceError) {
			return fail(e.status, e.message);
		}
		return fail(statusOf(e),messageOf(e),e&&typeof e==='object'&&'current' in e?{current:e.current}:undefined);
	}
};
