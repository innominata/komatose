import { probeModelConnection } from './modelConnection';
import { listRegistryRows } from './modelRegistryStore';
import { listCliToolAdminStatus } from './cliToolStatus';
import { envVar } from './envFile';
import { llmConfig } from './llm';
import { installedLocalReviewModels } from './localReview';
import { listTranslationModels } from './translationRuntime';
import { buildSetupReport, type LocalProbeResult, type SetupDeps, type SetupReport } from './setupReport';

export async function probeLocalModels(url: string): Promise<LocalProbeResult> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
		return { ok: res.ok, status: res.status };
	} catch {
		return { ok: false };
	}
}

export function liveSetupDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
	const cfg = llmConfig();
	return {
		rows: overrides.rows ?? listRegistryRows(),
		cli: overrides.cli ?? listCliToolAdminStatus(),
		env: overrides.env ?? ((name) => envVar(name)),
		localBaseUrl: overrides.localBaseUrl ?? cfg.url,
		probeRow: overrides.probeRow ?? (overrides.probeLocal ? undefined : probeModelConnection),
		probeLocal: overrides.probeLocal ?? probeLocalModels,
		installedReview: overrides.installedReview ?? installedLocalReviewModels().map((item) => item.id),
		installedSpecialists:
			overrides.installedSpecialists ??
			listTranslationModels().filter((item) => item.available).map((item) => item.id),
		proofreadServiceSet: overrides.proofreadServiceSet ?? Boolean(envVar('SCAN_PROOFREAD_SERVICE_URL')),
	};
}

export async function loadSetupReport(overrides: Partial<SetupDeps> = {}): Promise<SetupReport> {
	return buildSetupReport(liveSetupDeps(overrides));
}
