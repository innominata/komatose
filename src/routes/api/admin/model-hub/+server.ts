import { qualificationChecks } from '$lib/modelCapabilities';
import { rowInstallationAvailability } from '$lib/server/registryPicker';
import { packageOperation, packageServiceStatus } from '$lib/server/modelSupervisor';
import { modelPackage } from '$lib/server/modelPackages';
import { MODEL_TASK_IDS } from '$lib/modelTasks';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import { medianMs } from '$lib/modelEstimate';
import {
	accessGroup,
	isProbeable,
	type ModelRow,
} from '$lib/modelRegistry';
import { PROVIDER_OPERATIONS, type ProviderOperation } from '$lib/providerCatalog';
import {
	devicePref,
	hardwareSnapshot,
	gpuUsage,
	invalidateTorchProbe,
	readDevicePrefs,
	setDevicePref,
	setTorchVariant,
	torchVariantPref,
	type TorchVariant,
} from '$lib/server/computeDevices';
import { komatoseGpuState, setKomatoseGpuEnabled } from '$lib/server/gpuMode';
import { restartWorkflowWorker, workflowResolved } from '$lib/server/localWorker';
import {
	environmentInstalled,
	installQueueStatus,
	listInstallStatuses,
} from '$lib/server/modelInstall';
import { listRegistryRows, findRegistryRow, updateRegistryRow, catalogCache, readModelOverlay } from '$lib/server/modelRegistryStore';
import { CLI_ADAPTER_IDS } from '$lib/modelRegistry';
import { listManagedStatuses, managedModelStatus } from '$lib/server/managedModels';
import { listReviewServerStatuses } from '$lib/server/localReview';
import { imageEditStatuses } from '$lib/server/imageEdit';
import { listCliToolAdminStatus } from '$lib/server/cliToolStatus';
import { loadSetupReport } from '$lib/server/setupLive';
import { readModelDefaults, setModelDefault, type DefaultJob } from '$lib/server/modelDefaultStore';
import { INSTALL_GROUPS } from '$lib/installCatalog';
import { detectorDefaults, saveDetectorDefaults } from '$lib/server/detectorConfig';
import { nvtopStatus, startNvtopBuild } from '$lib/server/nvtopBuild';

const DEFAULT_JOBS = new Set<string>([...PROVIDER_OPERATIONS, 'detect', 'transcribe']);

function isDefaultJob(job: string): job is DefaultJob {
	return DEFAULT_JOBS.has(job);
}

/**
 * One snapshot for the Admin → Models area: rows, install state, hardware,
 * services and the operator's defaults. The page polls this instead of six
 * endpoints, and the POST side keeps every setting change on one route.
 */

function publicRow(row: ModelRow) {
	return {
		...row,
		group: accessGroup(row),
		probeable: isProbeable(row),
		probeOperations: qualificationChecks(row),
		defaultProbe: qualificationChecks(row)[0],
		probes: Object.fromEntries(
			Object.entries(row.probes || {}).map(([operation, sample]) => [
				operation,
				{ ...sample, medianMs: medianMs(sample.samplesMs || (sample.ms != null ? [sample.ms] : [])) },
			]),
		),
		http: row.http ? { baseUrl: row.http.baseUrl, apiKeyEnv: row.http.apiKeyEnv } : undefined,
		managed: row.managedLaunch ? managedModelStatus(row) : undefined,
	};
}

const ENV_LABELS: Record<string, string> = {
	'env-ocr': '.venv-ocr',
	'env-review': '.venv-review',
	'env-workflow': '.venv-workflow',
};

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const environments = Object.entries(ENV_LABELS).map(([id, label]) => ({
			id,
			label,
			installed: environmentInstalled(id),
		}));
		const overlay = readModelOverlay();
		const catalogs = Object.fromEntries(
			[...CLI_ADAPTER_IDS, 'llamacpp', ...(overlay.catalogs || []).map((item) => item.adapter)].map((id) => [
				id,
				catalogCache(id) || null,
			]),
		);
		return json({
			ok: true,
			hardware: hardwareSnapshot(),
			usage: gpuUsage(),
			/** Per-model device choices, keyed exactly as `set-device` writes them. */
			devicePrefs: readDevicePrefs(),
			/** Komatose owns the GPUs: the switch in Admin → Hardware & services. */
			gpuMode: komatoseGpuState(),
			/** What `auto` really means for Koharu, SAM, Big-LaMa and AOT right now. */
			cleaningWorker: { choice: devicePref('cleaning-worker'), resolved: workflowResolved() },
			catalogs,
			rows: await Promise.all(listRegistryRows().map(async row => {
        const pkg = modelPackage(row.id);
        return { ...publicRow(row), readiness: await rowInstallationAvailability(row), packageOperation: packageOperation(row.id), service: pkg ? packageServiceStatus(pkg) : undefined };
      })),
			cliTools: listCliToolAdminStatus(),
			installs: listInstallStatuses(),
			queue: installQueueStatus(),
			torchVariant: torchVariantPref(),
			managed: listManagedStatuses(),
			reviewServers: await listReviewServerStatuses(),
			editors: imageEditStatuses(),
			environments,
			groups: INSTALL_GROUPS,
			defaults: readModelDefaults().defaults,
			detector: detectorDefaults(),
			report: await loadSetupReport(),
			nvtop: nvtopStatus(),
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

/** Device settings a select in this area reads back after it writes. */
function deviceState() {
	return {
		devicePrefs: readDevicePrefs(),
		gpuMode: komatoseGpuState(),
		cleaningWorker: { choice: devicePref('cleaning-worker'), resolved: workflowResolved() },
	};
}

/**
 * Body actions:
 *   { action: 'set-device', id, choice }        auto | cpu | Vulkan1 | cuda:0 | …
 *   { action: 'set-gpu-mode', enabled }         Komatose owns the GPUs (Admin → Hardware)
 *   { action: 'set-default', job, rowId? }      per-job default; empty clears
 *   { action: 'set-detector', setup, conf? }   text detector setup id (ctd+koharu, …) and confidence
 *   { action: 'set-torch-variant', variant }    auto | cpu | cuda | rocm
 *   { action: 'refresh-hardware' }              force a fresh device probe
 *   { action: 'build-nvtop' }                   download, patch, and build nvtop into data/tools/nvtop
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const action = String(body.action || '');
		if (action === 'set-device') {
			const id = String(body.id || '').trim();
			const choice = String(body.choice || 'auto').trim();
			if (!id) return fail(400, 'Choose a model');
			const row = findRegistryRow(id);
			if (row?.managedLaunch) {
				// Managed chat rows keep the choice in their launch recipe.
				updateRegistryRow(id, { managedLaunch: { ...row.managedLaunch, device: choice } });
			} else {
				setDevicePref(id, choice);
			}
			// Only the cleaning worker is the resident workflow process. Other device
			// choices apply the next time that model starts.
			if (id === 'cleaning-worker') restartWorkflowWorker();
			return json({ ok: true, rows: listRegistryRows().map(publicRow), managed: listManagedStatuses(), ...deviceState() });
		}
		if (action === 'set-gpu-mode') {
			const enabled = body.enabled === true || body.enabled === 'true';
			setKomatoseGpuEnabled(enabled);
			// The resident cleaning worker was spawned under the old mode, so restart it.
			// Review servers keep the environment they started with until restarted from this page.
			restartWorkflowWorker();
			return json({ ok: true, ...deviceState() });
		}
		if (action === 'set-default') {
			const job = String(body.job || '');
			if (!isDefaultJob(job)) return fail(400, 'Unknown job');
			const rowId = body.rowId ? String(body.rowId) : undefined;
			const saved = setModelDefault(job, rowId);
			return json({ ok: true, defaults: saved.defaults });
		}
		if (action === 'set-detector') {
			return json({ ok: true, detector: saveDetectorDefaults({ setup: body.setup, conf: body.conf }) });
		}
		if (action === 'set-torch-variant') {
			const variant = setTorchVariant(String(body.variant || 'auto') as TorchVariant);
			return json({ ok: true, torchVariant: variant });
		}
		if (action === 'refresh-hardware') {
			invalidateTorchProbe();
			return json({ ok: true, hardware: hardwareSnapshot({ refresh: true }), usage: gpuUsage(), nvtop: nvtopStatus() });
		}
		if (action === 'build-nvtop') {
			return json({ ok: true, nvtop: startNvtopBuild() });
		}
		return fail(400, 'Unknown action');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
