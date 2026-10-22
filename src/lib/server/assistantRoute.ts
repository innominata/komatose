import { qualificationReason } from '../modelCapabilities';
import { AsyncLocalStorage } from 'node:async_hooks';
import { modelHttpConfig } from './modelConnection';
import { isCliProvider, type CliProviderId, type ProviderOperation } from '../providerCatalog';
import { listRegistryRows } from './modelRegistryStore';
import { modelDefaultFor } from './modelDefaultStore';
import { resolveAssistant, rowHasOperation, type ModelRow, type ResolvedAssistant } from '../modelRegistry';
import { WorkflowError } from './workflowStore';
import { currentAssistantHttp, type AssistantHttpConfig } from './openaiHttp';

export type AssistantKind = 'local' | 'cli' | 'qwen3vl' | 'proofreader' | 'ocr' | 'specialist';

export type RoutedAssistant = ResolvedAssistant & {
	kind: AssistantKind;
	cliEngine?: CliProviderId;
};

/** The failed-vision gate used to persist itself (ms: 0). That is not an API result. */
export function isCircularVisionProbeFailure(reason?: string): boolean {
	return /failed its vision Test/i.test(reason ?? '');
}

/**
 * While set, routing treats the run as diagnostic: probes and Jobs-grid retests
 * may reach a model whose test previously failed (or which is hidden).
 */
const diagnosticRuns = new AsyncLocalStorage<boolean>();
export function withDiagnosticRuns<T>(run: () => Promise<T>): Promise<T> {
	return diagnosticRuns.run(true, run);
}
export const isDiagnosticRun = () => diagnosticRuns.getStore() === true;

/**
 * An unchosen engine (empty, or the legacy "qwen" host without a model) means the
 * operator's default for chat work under Admin → Models, then any chat row this
 * machine has passed. No model is built in.
 */
export function resolveLiveAssistant(engine: string, model?: string): ResolvedAssistant {
	const rows = listRegistryRows();
	const id = String(engine || '').trim();
	const unchosen = () => {
		// A legacy "qwen" model name is a slug on the local endpoint; it keeps that slug.
		const chosen = modelDefaultFor('translate');
		const row = chosen ? rows.find((item) => item.id === chosen && !item.disabled) : undefined;
		if (row) return { row, slug: model || row.slug, host: resolveAssistant(row.id, '', rows, false).host };
		return resolveAssistant('', model, rows, true);
	};
	if (!id) return unchosen();
	if (id === 'qwen') {
		if (!model) return unchosen();
		try {
			return resolveAssistant(id, model, rows, false);
		} catch {
			return unchosen();
		}
	}
	return resolveAssistant(id, model, rows, false);
}

export function liveAssistantName(engine: string, model = ''): string {
	try {
		return resolveLiveAssistant(engine, model).row.name;
	} catch {
		return String(engine || model || 'Unknown model');
	}
}

export function routeAssistant(
	engine: string,
	model: string | undefined,
	operation: ProviderOperation,
	proofreaderAction: string,
	opts?: { diagnostic?: boolean },
): RoutedAssistant {
	const resolved = resolveLiveAssistant(engine, model);
	const { row } = resolved;
	// Probes and Jobs-grid retests run "diagnostically": they must reach the
	// model even when a previous test failed or the row is hidden.
	const diagnostic = Boolean(opts?.diagnostic) || isDiagnosticRun();
	if (row.disabled && !diagnostic) throw new Error(`${row.name} is disabled`);
	if (!diagnostic && !rowHasOperation(row, operation)) {
    throw new Error(`${row.name}: ${qualificationReason(row, operation)}. Run the required checks under Admin → Models → Jobs.`);
  }
	return continueRouting();

	function continueRouting(): RoutedAssistant {
		if (row.access === 'cli') {
			const cli = row.cliAdapter;
			if (!cli || !isCliProvider(cli)) throw new Error(`Unsupported translation engine: ${engine}`);
			return { ...resolved, kind: 'cli', cliEngine: cli };
		}
		return { ...resolved, kind: 'local' };
	}
}

export function httpConfigFor(row: ModelRow, slug: string): AssistantHttpConfig | undefined {
 const override = currentAssistantHttp();
 if (override && (!override.rowId || override.rowId === row.id)) return override;
 return modelHttpConfig(row, slug);
}
