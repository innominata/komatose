import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import {
	cancelInstall,
	cancelInstallStep,
	clearFinishedInstalls,
	installQueueStatus,
	listInstallStatuses,
	startInstall,
	startInstallQueue,
	startRuntimeUpgrade,
	uninstallPlan,
	uninstallTarget,
} from '$lib/server/modelInstall';
import { torchVariantPref } from '$lib/server/computeDevices';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		return json({
			ok: true,
			targets: listInstallStatuses(),
			queue: installQueueStatus(),
			torchVariant: torchVariantPref(),
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

/**
 * Body: `{ action: 'start' | 'cancel' | 'clear' | 'uninstall-plan' | 'uninstall', id?, ids? }`.
 * `start` with `ids` queues the whole plan — environments run before the models
 * that need them. The PyTorch build for new environments is set on `/api/admin/model-hub`. Admin-only.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const action = String(body.action || '');
		const id = String(body.id || '').trim();
		const ids = Array.isArray(body.ids) ? body.ids.map((item) => String(item || '').trim()).filter(Boolean) : id ? [id] : [];
		if (action === 'upgrade-runtime') {
			return json({ ok: true, job: startRuntimeUpgrade(id), queue: installQueueStatus() });
		}
		if (action === 'start') {
			if (!ids.length) return fail(400, 'Choose an install target');
			// A single id keeps the old one-step behaviour for "Install" buttons.
			if (ids.length === 1) {
				const wanted = ids[0];
				const steps = startInstallQueue([wanted]).plan;
				if (!steps.length) return json({ ok: true, job: null, queue: installQueueStatus() });
				return json({ ok: true, job: steps.find((step) => step.key === wanted) || steps[0], queue: installQueueStatus() });
			}
			const { plan, skipped } = startInstallQueue(ids);
			return json({ ok: true, plan, skipped, queue: installQueueStatus() });
		}
		if (action === 'cancel') {
			if (!id) return fail(400, 'Choose an install to cancel');
			const stepped = cancelInstallStep(id);
			const job = cancelInstall(id);
			if (!stepped && !job) return fail(404, 'That install is not running');
			return json({ ok: true, queue: installQueueStatus(), job: job ?? null });
		}
		if (action === 'clear') {
			clearFinishedInstalls();
			return json({ ok: true, queue: installQueueStatus() });
		}
		if (action === 'uninstall-plan') {
			if (!id) return fail(400, 'Choose a model to uninstall');
			return json({ ok: true, plan: uninstallPlan(id) });
		}
		if (action === 'uninstall') {
			if (!id) return fail(400, 'Choose a model to uninstall');
			const plan = uninstallTarget(id);
			return json({ ok: true, plan, targets: listInstallStatuses() });
		}
		return fail(400, 'Unknown action');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
