import { json } from '@sveltejs/kit';
import { parseGlossary } from '$lib/glossary';
import { logActivity } from '$lib/server/activity';
import { canClean, canEditStickies, canUpload } from '$lib/server/access';
import { fail, messageOf, requireSeriesAccess, requireUser, statusOf } from '$lib/server/http';
import { persistSeriesGlossary } from '$lib/server/seriesGlossary';
import { listFonts, uploadFont } from '$lib/server/typesetting';
import { getDoc } from '$lib/server/workflowStore';
import { saveSeriesTypeSettings } from '$lib/server/workflowService';
import { allTypeStyles, type Preferences } from '$lib/workflow';
import type { SessionUser } from '$lib/server/auth';
import type { RequestHandler } from './$types';

function canManageType(user: SessionUser) {
	return canUpload(user) || canClean(user);
}

export const GET: RequestHandler = async ({ locals, params }) => {
	try {
		const user = requireUser(locals.user);
		const s = await requireSeriesAccess(user, params.id);
		const typeDoc = getDoc<Partial<Preferences>>(`series:${s.id}`, {});
		return json({
			fonts: listFonts(s.id),
			revision: typeDoc.revision,
			style: typeDoc.data.style ?? {},
			styles: typeDoc.data.styles ?? {},
			typeStyles: allTypeStyles(typeDoc.data),
			canManageType: canManageType(user)
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const s = await requireSeriesAccess(user, params.id);
		const body = await request.json();
		if (body.style != null || body.styles != null) {
			if (!canManageType(user)) return fail(403, 'Forbidden');
			const doc = saveSeriesTypeSettings(s.id, Number(body.expectedRevision), {
				style: body.style,
				styles: body.styles
			});
			await logActivity({
				seriesId: s.id,
				userId: user.id,
				action: 'updated_series_type',
				payload: { types: Object.keys(body.styles || {}) }
			});
			return json({
				ok: true,
				revision: doc.revision,
				style: doc.data.style,
				styles: doc.data.styles,
				typeStyles: allTypeStyles(doc.data)
			});
		}
		if (!canEditStickies(user)) return fail(403, 'Forbidden');
		if (body.glossary == null) return fail(400, 'glossary required');
		const glossary = Array.isArray(body.glossary)
			? parseGlossary(JSON.stringify(body.glossary))
			: parseGlossary(String(body.glossary));
		for (const term of glossary) term.edited = true;
		const saved = persistSeriesGlossary(s.id, glossary);
		await logActivity({ seriesId: s.id, userId: user.id, action: 'updated_series_glossary' });
		return json({ ok: true, glossary: saved });
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	try {
		const user = requireUser(locals.user);
		const s = await requireSeriesAccess(user, params.id);
		if (request.headers.get('content-type')?.includes('multipart/form-data')) {
			if (!canManageType(user)) return fail(403, 'Forbidden');
			const form = await request.formData();
			const files = form.getAll('font').filter((f): f is File => f instanceof File && f.size > 0);
			if (!files.length) return fail(400, 'Choose a font file');
			const results = [];
			const category = form.get('category');
			for (const font of files) {
				const result = await uploadFont(s.id, font.name, Buffer.from(await font.arrayBuffer()), category);
				results.push(result);
				await logActivity({
					seriesId: s.id,
					userId: user.id,
					action: 'uploaded_series_font',
					payload: { filename: font.name }
				});
			}
			const last = results[results.length - 1]!;
			return json({
				ok: true,
				duplicate: last.duplicate,
				font: last.font,
				uploaded: results.map((r) => r.font),
				fonts: listFonts(s.id)
			});
		}
		return fail(400, 'Unknown operation');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
