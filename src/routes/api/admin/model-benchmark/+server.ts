import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	fail,
	messageOf,
	requireManageUsers,
	requireUser,
	statusOf,
} from '$lib/server/http';
import {
	benchmarkPageImage,
	cancelBenchmark,
	listBenchmarkStatus,
	startOcrBenchmark,
	startTranslationBenchmark,
	startTranslationReview,
} from '$lib/server/modelBenchmark';

const strings = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item || '')) : []);

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const dataset = url.searchParams.get('dataset') ?? 'manga-ja';
		const page = url.searchParams.get('page');
		if (page) {
			const jpeg = await benchmarkPageImage(page, url.searchParams.get('lang') === 'en', 720, dataset);
			return new Response(new Uint8Array(jpeg), {
				headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' },
			});
		}
		return json(listBenchmarkStatus(dataset));
	} catch (error) {
		return fail(statusOf(error), messageOf(error));
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		if (body.action === 'cancel') return json({ ok: true, cancelled: cancelBenchmark() });
		if (body.kind === 'translation') {
			const run = startTranslationBenchmark({ dataset: body.dataset === undefined ? undefined : String(body.dataset), models: strings(body.models) });
			return json({ ok: true, run }, { status: 202 });
		}
		if (body.kind === 'review') {
			const review = startTranslationReview({
				dataset: body.dataset === undefined ? undefined : String(body.dataset),
				reviewer: String(body.reviewer || ''),
				models: strings(body.models),
			});
			return json({ ok: true, review }, { status: 202 });
		}
		if (body.kind === 'ocr') {
			const run = startOcrBenchmark({
				dataset: body.dataset === undefined ? undefined : String(body.dataset),
				detectors: strings(body.detectors),
				models: strings(body.models),
				sources: strings(body.sources),
			});
			return json({ ok: true, run }, { status: 202 });
		}
		return fail(400, 'Choose the OCR or translation benchmark');
	} catch (error) {
		return fail(statusOf(error), messageOf(error));
	}
};
