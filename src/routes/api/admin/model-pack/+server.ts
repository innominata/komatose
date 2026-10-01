import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { ModelPackError } from '$lib/modelPack';
import { ModelProfileError } from '$lib/modelProfiles';
import {
	applyImportedPack,
	modelPackFilename,
	previewExportedPack,
	previewImportedPack,
} from '$lib/server/modelPackStore';

function packFail(error: unknown) {
	if (error instanceof ModelPackError || error instanceof ModelProfileError) {
		return fail(400, error.message);
	}
	return fail(statusOf(error), messageOf(error));
}

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const includePrivate = url.searchParams.get('includePrivate') === '1' || url.searchParams.get('includePrivate') === 'true';
		const preview = previewExportedPack(new Date(), { includePrivate });
		return json({
			ok: true,
			pack: preview.pack,
			filename: modelPackFilename(preview.pack),
			counts: { models: preview.pack.models.length, profiles: preview.pack.profiles.length },
			includePrivate: preview.includePrivate,
			includedPrivate: preview.includedPrivate,
			excludedModels: preview.excludedModels,
			profilesNeedingConfig: preview.profilesNeedingConfig,
		});
	} catch (error) {
		return packFail(error);
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const action = String(body.action || '');
		if (action === 'export-preview') {
			const preview = previewExportedPack(new Date(), { includePrivate: body.includePrivate === true });
			return json({
				ok: true,
				includePrivate: preview.includePrivate,
				includedPrivate: preview.includedPrivate,
				excludedModels: preview.excludedModels,
				profilesNeedingConfig: preview.profilesNeedingConfig,
				counts: { models: preview.pack.models.length, profiles: preview.pack.profiles.length },
			});
		}
		if (action === 'preview') {
			const preview = previewImportedPack(body.pack);
			return json({
				ok: true,
				preview: {
					add: preview.add,
					conflicts: preview.conflicts,
					missing: preview.missing,
				},
				pack: preview.pack,
			});
		}
		if (action === 'apply') {
			const result = applyImportedPack(body.pack, body.decisions);
			return json({ ok: true, ...result });
		}
		return fail(400, 'Choose export-preview, preview, or apply.');
	} catch (error) {
		return packFail(error);
	}
};
