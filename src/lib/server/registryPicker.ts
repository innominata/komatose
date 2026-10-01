import { probeModelConnection, modelHttpConfig } from './modelConnection';
import { isProofreaderId } from '../proofreaders';
import { accessGroup, allowedOperations, isOcrSpecialist, isTranslationSpecialist, rowAllowedForRole, rowHasOperation, visionEligible, type ModelRow } from '../modelRegistry';
import type { ProviderOperation } from '../providerCatalog';
import type { Role } from '../types';
import { listRegistryRows } from './modelRegistryStore';
import { cliReadiness, isCliToolId } from './cliDiscovery';
import { hasRegisteredCliAdapter, registeredCliExecutable } from './cliTranslate';
import { proofreaderStatus } from './proofreadService';
import { missingApiKeyMessage } from './openaiHttp';
import { installedLocalReviewModels } from './localReview';
import { listTranslationModels } from './translationRuntime';
import { translationModel } from '../translationModels';
import { medianMs } from '../modelEstimate';
import { estimateForOperation } from '../modelEstimate';

export type RegistryPickerRow = {
	id: string;
	label: string;
	available: boolean;
	reason?: string;
	pageImageOnly?: boolean;
	group: ReturnType<typeof accessGroup>;
	operations: ProviderOperation[];
	slug: string;
	access: ModelRow['access'];
	estimates?: Record<string, { label: string; ms: number; medianMs: number }>;
};

export async function rowAvailability(row: ModelRow): Promise<{ available: boolean; reason?: string }> {
 if (row.disabled) return { available: false, reason: 'Disabled' };
 const { packageForRow } = await import('./modelTaskRunner');
 try {
  const pkg = packageForRow(row);
  if (pkg.manifest.adapter.command) {
   const { invokePackage } = await import('./modelSupervisor');
   const status = await invokePackage(pkg, 'installation-status', {}, { signal: AbortSignal.timeout(5000) });
   return { available: status?.installed === true, reason: status?.reason };
  }
  const { builtinPackageReadiness } = await import('./modelAdapterLifecycle');
  return await builtinPackageReadiness(pkg);
 } catch (e) { return { available: false, reason: (e as Error).message }; }
}

function estimatesOf(row: ModelRow) {
	const out: Record<string, { label: string; ms: number; medianMs: number }> = {};
	for (const [operation, probe] of Object.entries(row.probes || {})) {
		const median = medianMs(probe.samplesMs || (probe.ms != null ? [probe.ms] : []));
		if (median == null) continue;
		out[operation] = {
			...estimateForOperation(operation as ProviderOperation, median, 8, {
				specialistPerLine: isTranslationSpecialist(row),
			}),
			medianMs: median,
		};
	}
	return out;
}

export async function registryPickerRows(role?: Role | null, operation?: ProviderOperation | readonly ProviderOperation[]): Promise<RegistryPickerRow[]> {
	const rows = listRegistryRows().filter((row) => rowAllowedForRole(row, role));
	const out: RegistryPickerRow[] = [];
	for (const row of rows) {
		if (operation) {
			const list = typeof operation === 'string' ? [operation] : [...operation];
			const ok = list.some((item) => rowHasOperation(row, item));
			if (!ok) continue;
		}
		const live = await rowAvailability(row);
		out.push({
			id: row.id,
			label: row.name,
			available: live.available,
			reason: live.reason,
			pageImageOnly: row.access === 'proofreader',
			group: accessGroup(row),
			operations: allowedOperations(row),
			slug: row.slug,
			access: row.access,
			estimates: estimatesOf(row),
		});
	}
	return out;
}

export function transcriptionPickerRows(rows: RegistryPickerRow[], registry = listRegistryRows()): RegistryPickerRow[] {
	const byId = new Map(registry.map((row) => [row.id, row]));
	return rows.filter((item) => {
		const row = byId.get(item.id);
		return row ? visionEligible(row) : false;
	});
}
