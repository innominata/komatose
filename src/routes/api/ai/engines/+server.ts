import { modelDefaultFor } from '$lib/server/modelDefaultStore';
import { listManagedStatuses } from '$lib/server/managedModels';
import { engineReadiness } from '$lib/server/engineReadiness';
import { json } from '@sveltejs/kit';
import { gpuClientStatus } from '$lib/server/gpuMode';
import { presentGpuStatus } from '$lib/server/computeDevices';
import { cleaningDeviceLabel } from '$lib/server/localWorker';
import { fail, messageOf, requireUser, statusOf } from '$lib/server/http';
import type { RequestHandler } from './$types';
import { installedLocalReviewModels } from '$lib/server/localReview';
import { registryPickerRows, transcriptionPickerRows } from '$lib/server/registryPicker';
import { catalogCache, listRegistryRows } from '$lib/server/modelRegistryStore';
import { CLI_ADAPTER_IDS, allowedOperations } from '$lib/modelRegistry';
import { isProofreaderId } from '$lib/proofreaders';
import { readUserSettings } from '$lib/server/userSettings';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		// Proofreaders are granted per user and off by default: drop any the caller
		// may not use so the tools never appear for them.
		const granted = user.role === 'admin'
			? null
			: new Set(readUserSettings(user.id).proofreaders);
		const allowed = <T extends { id: string }>(list: T[]): T[] =>
			granted === null ? list : list.filter((item) => !isProofreaderId(item.id) || granted.has(item.id));
		const [allHosts, allRows] = await Promise.all([
			engineReadiness(),
			registryPickerRows(user.role),
		]);
		const hosts = allowed(allHosts);
		const rows = allowed(allRows);
		const registry = listRegistryRows();
		// A task's picker lists models that passed that job on Admin → Models → Jobs.
		const translate = rows.filter((row) => row.operations.includes('translate'));
		const describe = rows.filter((row) => row.operations.includes('describe'));
		const review = rows.filter((row) => row.operations.includes('sourceReview'));
		const transcription = transcriptionPickerRows(rows);
		return json({
			ok: true,
			gpu: { ...presentGpuStatus(gpuClientStatus(cleaningDeviceLabel())), models: listManagedStatuses() },
			engines: rows,
			rows,
			hosts,
			models: {},
			translationModels: Object.fromEntries(translate.map((row) => [row.id, [{ id: row.id, label: row.label, available: row.available, reason: row.reason }]])),
			translationEngines: translate,
			describeModels: Object.fromEntries(describe.map((row) => [row.id, [{ id: row.id, label: row.label, available: row.available, reason: row.reason }]])),
			sourceReviewEngines: review,
			sourceReviewModels: Object.fromEntries(review.map((row) => [row.id, [{ id: row.id, label: row.label }]])),
			localReviewModels: review.filter(model => registry.some(row => row.id === model.id && row.access === 'local_http')).map(model => ({ id: model.id, label: model.label, available: model.available, reason: model.reason })),
			transcriptionModels: transcription,
			transcriptionDeciders: rows.filter(row => row.operations.includes('sourceDecide')),
			defaultTranscriptionDecider: modelDefaultFor('sourceDecide') || null,
			catalogs: Object.fromEntries(CLI_ADAPTER_IDS.map((id) => [id, catalogCache(id) || null])),
			registry: listRegistryRows().map((row) => ({
				id: row.id,
				name: row.name,
				slug: row.slug,
				access: row.access,
				operations: allowedOperations(row),
				roles: row.roles,
				seeded: row.seeded,
				disabled: row.disabled,
				autoRun: row.autoRun,
			})),
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
