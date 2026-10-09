import { qualificationChecks, type QualificationId } from '$lib/modelCapabilities';
import { runQualification } from '$lib/server/modelQualification';
import { saveCapabilityResults } from '$lib/server/modelRegistryStore';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fail, messageOf, requireManageUsers, requireUser, statusOf } from '$lib/server/http';
import {
	CHAT_AND_CLI_OPERATIONS,
	CLI_ADAPTER_IDS,
	accessGroup,
	isCliAdapterId,
	isProbeable,
	type CliAdapterId,
} from '$lib/modelRegistry';
import type { ProviderOperation } from '$lib/providerCatalog';
import { ROLES } from '$lib/roles';
import {
	addCliSlug,
	catalogCache,
	createRemoteHttpRow,
	createLocalHttpRow,
	findRegistryRow,
	listRegistryRows,
	readModelOverlay,
	removeOverlayRow,
	saveProbeResult,
	setRowsDisabled,
	updateRegistryRow,
} from '$lib/server/modelRegistryStore';
import { refreshLiveCatalog } from '$lib/server/modelCatalogs';
import type { ManagedLaunch, RequestPreset } from '$lib/managedModels';
import { managedModelStatus } from '$lib/server/managedModels';
import { medianMs } from '$lib/modelEstimate';

function publicRow(row: ReturnType<typeof listRegistryRows>[number]) {
	const last = Object.values(row.probes || {})[0];
	const probes = Object.fromEntries(
		Object.entries(row.probes || {}).map(([operation, sample]) => [
			operation,
			{
				...sample,
				medianMs: medianMs(sample.samplesMs || (sample.ms != null ? [sample.ms] : [])),
			},
		]),
	);
	return {
		...row,
		group: accessGroup(row),
		probeable: isProbeable(row),
		probeOperations: qualificationChecks(row),
		defaultProbe: qualificationChecks(row)[0],
		lastProbe: last,
		probes,
		http: row.http ? { baseUrl: row.http.baseUrl, apiKeyEnv: row.http.apiKeyEnv } : undefined,
	};
}

export const GET: RequestHandler = async ({ locals }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const overlay = readModelOverlay();
		const catalogs = Object.fromEntries(
			[
				...CLI_ADAPTER_IDS,
				'llamacpp',
				...(overlay.catalogs || []).map((item) => item.adapter),
			].map((id) => [id, catalogCache(id) || null]),
		);
		return json({
			ok: true,
			rows: listRegistryRows().map(publicRow),
			catalogs,
			operations: CHAT_AND_CLI_OPERATIONS,
		});
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};

export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		requireManageUsers(requireUser(locals.user));
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const action = String(body.action || '');
		if (action === 'refresh') {
			const adapter = String(body.adapter || '');
			const result = await refreshLiveCatalog(adapter);
			return json({ ok: !result.error, ...result });
		}
		if (action === 'add-cli') {
			const adapter = String(body.adapter || '');
			if (!isCliAdapterId(adapter)) return fail(400, 'Choose a CLI host');
			const slug = String(body.slug || '').trim();
			const row = addCliSlug(adapter as CliAdapterId, slug, String(body.label || slug));
			return json({ ok: true, row: publicRow(row) });
		}
		if (action === 'bulk-add-cli') {
			const adapter = String(body.adapter || '');
			if (!isCliAdapterId(adapter)) return fail(400, 'Choose a CLI host');
			const slugs = Array.isArray(body.models) ? body.models : [];
			const rows = slugs
				.map((item) => {
					const rec = item && typeof item === 'object' ? (item as { id?: string; label?: string }) : {};
					const slug = String(rec.id || '').trim();
					if (!slug) return null;
					return addCliSlug(adapter as CliAdapterId, slug, rec.label);
				})
				.filter(Boolean);
			return json({ ok: true, rows: listRegistryRows().map(publicRow), added: rows.length });
		}
		if (action === 'add-local') {
			const launch = body.managedLaunch;
			const preset = body.requestPreset;
			const row = createLocalHttpRow({
				name: String(body.name || ''),
				slug: String(body.slug || ''),
				baseUrl: String(body.baseUrl || ''),
				apiKeyEnv: String(body.apiKeyEnv || ''),
				...(launch && typeof launch === 'object' ? { managedLaunch: launch as ManagedLaunch } : {}),
				...(typeof preset === 'string' ? { requestPreset: preset as RequestPreset } : {}),
			});
			return json({ ok: true, row: publicRow(row) });
		}
		if (action === 'add-remote') {
			const row = createRemoteHttpRow({
				id: typeof body.id === 'string' ? body.id : undefined,
				name: String(body.name || ''),
				slug: String(body.slug || ''),
				baseUrl: String(body.baseUrl || ''),
				apiKeyEnv: String(body.apiKeyEnv || 'OPENAI_API_KEY'),
				operations: Array.isArray(body.operations) ? (body.operations as ProviderOperation[]) : undefined,
			});
			return json({ ok: true, row: publicRow(row) });
		}
		if (action === 'update') {
			const id = String(body.id || '');
			const row = updateRegistryRow(id, {
				...(Object.hasOwn(body, 'managedLaunch') ? { managedLaunch: body.managedLaunch as import('$lib/managedModels').ManagedLaunch | null } : {}),
				...(Object.hasOwn(body, 'requestPreset') ? { requestPreset: body.requestPreset as import('$lib/managedModels').RequestPreset } : {}),
				name: typeof body.name === 'string' ? body.name : undefined,
				slug: typeof body.slug === 'string' ? body.slug : undefined,
				disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
				autoRun: typeof body.autoRun === 'boolean' ? body.autoRun : undefined,
				operations: Array.isArray(body.operations) ? (body.operations as ProviderOperation[]) : undefined,
				roles: Array.isArray(body.roles) ? ROLES.filter((role) => (body.roles as unknown[]).includes(role)) : undefined,
				http: body.http && typeof body.http === 'object' ? (body.http as { baseUrl: string; apiKeyEnv: string }) : undefined,
			});
			return json({ ok: true, row: publicRow(row) });
		}
		if (action === 'set-disabled') {
			if (typeof body.disabled !== 'boolean') return fail(400, 'Choose show or hide');
			const ids = Array.isArray(body.ids) ? body.ids.map((item) => String(item || '').trim()).filter(Boolean) : [];
			return json({ ok: true, rows: setRowsDisabled(ids, body.disabled).map(publicRow) });
		}
		if (action === 'delete') {
			const id = String(body.id || '');
			// A managed model must be stopped before its config goes away, or the
			// orphaned llama-server keeps running with nothing to own it.
			const target = findRegistryRow(id);
			if (target?.managedLaunch) {
				const status = managedModelStatus(target);
				if (['starting', 'running', 'stopping', 'queued'].includes(status.state))
					return fail(400, 'Stop the model first — it is starting, running or stopping.');
				if (status.activeUses)
					return fail(400, `Stop the model first — ${status.activeUses} active use${status.activeUses === 1 ? '' : 's'}.`);
			}
			removeOverlayRow(id);
			return json({ ok: true, rows: listRegistryRows().map(publicRow) });
		}
		if (action === 'test') {
			const id = String(body.id || '');
			const row = findRegistryRow(id);
			if (!row) return fail(404, 'Model not found');
			const check = String(body.check || body.operation || qualificationChecks(row)[0]) as QualificationId;
      if (!qualificationChecks(row).includes(check)) return fail(400, 'Choose a supported capability or integration check');
      const result = await runQualification(row, check, { abort: request.signal });
      const saved = result.sample ? saveProbeResult(id, result.sample) : saveCapabilityResults(id, result.samples);
      const samples = result.sample ? [result.sample] : result.samples;
      return json({ ok: samples.every(sample => sample.ok), row: publicRow(saved), samples, sample: samples.find(sample => !sample.ok) || samples[0] });
		}
		return fail(400, 'Unknown action');
	} catch (e) {
		return fail(statusOf(e), messageOf(e));
	}
};
