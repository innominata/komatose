import { formatAdapterList, productionCliAdapterDefs } from '../cliAdapterDefs';
import { DEFAULT_REVIEW_MODEL_ID } from '../modelDefaults';
import type { ModelRow } from '../modelRegistry';
import { isOcrSpecialist, isTranslationSpecialist, rowHasOperation } from '../modelRegistry';
import { QWEN_38_27B_ID } from '../qwenModels';
import type { CliToolAdminStatus } from './cliToolStatus';
import { missingApiKeyMessage } from './openaiHttp';

export const SETUP_ACTIONS = ['configure_endpoint', 'set_api_key', 'install_agent', 'select_model'] as const;
export type SetupAction = (typeof SETUP_ACTIONS)[number];
export type SetupState = 'configured' | 'missing' | 'unavailable';

export type SetupNextStep = {
	action: SetupAction;
	text: string;
	href: string;
};

export type SetupItem = {
	id: string;
	label: string;
	group: string;
	state: SetupState;
	optional?: boolean;
	detail: string;
	next?: SetupNextStep;
};

export type SetupReport = {
	items: SetupItem[];
	summary: { configured: number; missing: number; unavailable: number };
	nextSteps: SetupNextStep[];
};

export type LocalProbeResult = { ok: boolean; status?: number };

export type SetupDeps = {
	rows: ModelRow[];
	cli: CliToolAdminStatus[];
	env: (name: string) => string;
	localBaseUrl: string;
	probeRow?: (row: ModelRow) => Promise<{ available: boolean; reason?: string }>;
	probeLocal: (url: string) => Promise<LocalProbeResult>;
	installedReview: readonly string[];
	installedSpecialists: readonly string[];
	proofreadServiceSet: boolean;
};

// Next-step links target the page that owns the job: getting models working is
// Setup, choosing which of them users may pick is Settings.
const SETUP = '/admin/setup';
const SETUP_CLI = '/admin/setup#cli';
const SETTINGS = '/admin/settings';

const NEXT: Record<SetupAction, SetupNextStep> = {
	configure_endpoint: {
		action: 'configure_endpoint',
		text: 'Configure a local or remote chat endpoint, then start that service.',
		href: SETUP,
	},
	set_api_key: {
		action: 'set_api_key',
		text: 'Set the API-key environment variable in .env. Admin stores the variable name only.',
		href: SETUP,
	},
	install_agent: {
		action: 'install_agent',
		text: `Install ${formatAdapterList(productionCliAdapterDefs().map((item) => item.label), 'or')} on this server and save the path under Command-line agents.`,
		href: SETUP_CLI,
	},
	select_model: {
		action: 'select_model',
		text: 'On a chapter, select a ready model. Defaults use the local chat model.',
		href: SETTINGS,
	},
};

function step(action: SetupAction, text?: string): SetupNextStep {
	return text ? { ...NEXT[action], text } : NEXT[action];
}

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/models`;
}

export async function buildSetupReport(deps: SetupDeps): Promise<SetupReport> {
	const items: SetupItem[] = [];
	const localUrl = (deps.localBaseUrl || '').trim();
	let localOk = false;
	const localStates = new Map<string, boolean>();
	const localRows = deps.rows.filter(
		(row) => row.access === 'local_http' && ['llamacpp', 'openai'].includes(row.runtime || '') && !row.disabled,
	);
	if (deps.probeRow) {
		for (const row of localRows) {
			const result = await deps.probeRow(row);
			localStates.set(row.id, result.available);
			items.push({ id: `local:${row.id}`, label: row.name, group: 'Local models', state: result.available ? 'configured' : 'unavailable', detail: result.reason || 'Local service status', next: result.available ? undefined : step('configure_endpoint') });
		}
	}
	// Local rows carry the endpoint state themselves; a machine that has none
	// yet (chat rows are added in Setup, not seeded) still gets the check.
	if (!(deps.probeRow && localRows.length)) {
		if (!localUrl) {
			items.push({
				id: 'endpoint:local',
				label: 'Local chat endpoint',
				group: 'Services',
				state: 'missing',
				detail: 'No local OpenAI-compatible URL is configured.',
				next: step('configure_endpoint', 'Set LLAMASWAP_URL to the local /v1 endpoint and start that service.'),
			});
		} else {
			const probe = await deps.probeLocal(modelsUrl(localUrl));
			localOk = probe.ok;
			items.push({
				id: 'endpoint:local',
				label: 'Local chat endpoint',
				group: 'Services',
				state: probe.ok ? 'configured' : 'unavailable',
				detail: probe.ok
					? 'Local /models responded. This is not a task Test.'
					: probe.status
						? `Local /models returned HTTP ${probe.status}. Start the service or fix the URL.`
						: 'Local /models did not respond. Start the service or fix LLAMASWAP_URL.',
				next: probe.ok
					? undefined
					: step('configure_endpoint', 'Start the local model service or set LLAMASWAP_URL.'),
			});
		}
	}

	for (const row of deps.rows.filter((item) => item.access === 'remote_http' && !item.disabled)) {
		const baseUrl = (row.http?.baseUrl || '').trim();
		const keyName = row.http?.apiKeyEnv || 'OPENAI_API_KEY';
		const key = deps.env(keyName).trim();
		if (!baseUrl) {
			items.push({
				id: `remote:${row.id}`,
				label: row.name,
				group: 'Remote models',
				state: 'missing',
				detail: 'This remote row has no base URL.',
				next: step('configure_endpoint', `Set a base URL for ${row.name} on the Setup page.`),
			});
			continue;
		}
		if (!key) {
			items.push({
				id: `remote:${row.id}`,
				label: row.name,
				group: 'Remote models',
				state: 'missing',
				detail: missingApiKeyMessage(keyName),
				next: step('set_api_key', `Set ${keyName} in .env. Admin stores the variable name only.`),
			});
			continue;
		}
		items.push({
			id: `remote:${row.id}`,
			label: row.name,
			group: 'Remote models',
			state: 'configured',
			detail: `Endpoint and ${keyName} are set. This is not a login or model Test.`,
		});
	}

	for (const row of deps.rows.filter((item) => item.access === 'remote_http' && item.disabled)) {
		items.push({
			id: `remote:${row.id}`,
			label: row.name,
			group: 'Remote models',
			state: 'unavailable',
			optional: true,
			detail: 'This remote row is hidden from user pickers.',
			next: step('select_model', `Show ${row.name} on the Settings page or pick another model.`),
		});
	}

	for (const tool of deps.cli) {
		if (tool.found) {
			items.push({
				id: `cli:${tool.id}`,
				label: tool.label,
				group: 'Command-line agents',
				state: 'configured',
				detail: `${tool.message} Found via ${tool.source === 'environment' ? 'environment' : tool.source === 'saved_setting' ? 'saved setting' : 'automatic discovery'}.`,
			});
			continue;
		}
		const explicit = tool.source === 'environment' || tool.source === 'saved_setting';
		items.push({
			id: `cli:${tool.id}`,
			label: tool.label,
			group: 'Command-line agents',
			state: explicit ? 'unavailable' : 'missing',
			detail: tool.message,
			next: step(
				'install_agent',
				explicit
					? `Fix or clear the ${tool.label} location, then check discovery on the Setup page.`
					: `Install ${tool.label} on this server and save the executable under Command-line agents.`,
			),
		});
	}

	const reviewWanted = deps.rows.filter((row) => isOcrSpecialist(row) || row.runtime === 'qwen3vl');
	for (const row of reviewWanted) {
		const ok = deps.installedReview.includes(row.id);
		items.push({
			id: `review:${row.id}`,
			label: row.name,
			group: 'Optional local models',
			state: ok ? 'configured' : 'missing',
			optional: true,
			detail: ok
				? 'Installed on this server. This page does not download weights.'
				: 'Not installed. Use the local OCR/review installer if you want this model.',
			next: ok
				? undefined
				: step('install_agent', `Install ${row.name} with the local OCR installer if you need it.`),
		});
	}

	const specialists = deps.rows.filter((row) => isTranslationSpecialist(row));
	for (const row of specialists) {
		const ok = deps.installedSpecialists.includes(row.id);
		items.push({
			id: `specialist:${row.id}`,
			label: row.name,
			group: 'Optional local models',
			state: ok ? 'configured' : 'missing',
			optional: true,
			detail: ok
				? 'Installed on this server. This page does not download weights.'
				: 'Not installed. Use the translation-model installer if you want this model.',
			next: ok
				? undefined
				: step('install_agent', `Install ${row.name} with the translation-model installer if you need it.`),
		});
	}

	items.push({
		id: 'proofreaders',
		label: 'Proofreading service',
		group: 'Optional',
		state: deps.proofreadServiceSet ? 'configured' : 'missing',
		optional: true,
		detail: deps.proofreadServiceSet
			? 'SCAN_PROOFREAD_SERVICE_URL is set. This page does not contact the service.'
			: 'Optional page-image proofread. Set SCAN_PROOFREAD_SERVICE_URL to enable it.',
		next: deps.proofreadServiceSet
			? undefined
			: step('configure_endpoint', 'Set SCAN_PROOFREAD_SERVICE_URL only if you want page-image proofread.'),
	});

	const remoteReady = (row: ModelRow) =>
		row.access === 'remote_http' &&
		!row.disabled &&
		Boolean((row.http?.baseUrl || '').trim()) &&
		Boolean(deps.env(row.http?.apiKeyEnv || 'OPENAI_API_KEY').trim());
	const cliReady = (row: ModelRow) =>
		row.access === 'cli' &&
		!row.disabled &&
		Boolean(deps.cli.find((tool) => tool.id === row.cliAdapter)?.found);
	const localChatReady = (row: ModelRow) =>
		row.access === 'local_http' && ['llamacpp', 'openai'].includes(row.runtime || '') && !row.disabled && (deps.probeRow ? localStates.get(row.id) === true : localOk);
	const reviewReady = (row: ModelRow) =>
		(isOcrSpecialist(row) || row.runtime === 'qwen3vl') && deps.installedReview.includes(row.id);
	const specialistReady = (row: ModelRow) =>
		isTranslationSpecialist(row) &&
		deps.installedSpecialists.includes(row.id);

	const ready = (row: ModelRow) =>
		remoteReady(row) || cliReady(row) || localChatReady(row) || reviewReady(row) || specialistReady(row);

	const translateReady = deps.rows.filter((row) => rowHasOperation(row, 'translate') && ready(row));
	const visionReady = deps.rows.filter(
		(row) => rowHasOperation(row, 'vision') && ready(row),
	);

	items.push({
		id: 'capability:translate',
		label: 'Translation',
		group: 'Task coverage',
		state: translateReady.length ? 'configured' : 'missing',
		detail: translateReady.length
			? `Ready models: ${translateReady.map((row) => row.name).join(', ')}.`
			: 'No translation model is ready. Configure an endpoint, set an API-key variable, or install an agent.',
		next: translateReady.length
			? undefined
			: step('select_model', 'Get at least one translation model ready, then select it on a chapter.'),
	});
	items.push({
		id: 'capability:vision',
		label: 'Transcription',
		group: 'Task coverage',
		state: visionReady.length ? 'configured' : 'missing',
		detail: visionReady.length
			? `Ready models: ${visionReady.map((row) => row.name).join(', ')}.`
			: 'No vision or OCR model is ready. Install a local OCR model, start the local chat endpoint, or add a remote/CLI vision model.',
		next: visionReady.length
			? undefined
			: step('select_model', 'Get a vision or OCR model ready, then select it for transcription.'),
	});

	const defaultTranslate = deps.rows.find((row) => row.id === QWEN_38_27B_ID);
	const defaultReview = deps.rows.find((row) => row.id === DEFAULT_REVIEW_MODEL_ID);
	if (defaultTranslate && !ready(defaultTranslate) && translateReady.length) {
		// Komatose defaults to the single ready translator when the shipped
		// default cannot translate, so only a real choice needs a warning.
		if (translateReady.length === 1) {
			items.push({
				id: 'default:translate',
				label: 'Default translate model',
				group: 'Task coverage',
				state: 'configured',
				detail: `Only ${translateReady[0].name} can translate right now, so it is the default translate model.`,
			});
		} else {
			items.push({
				id: 'default:translate',
				label: 'Default translate model',
				group: 'Task coverage',
				state: 'unavailable',
				detail: 'The default translate model is not ready. Another translation model is.',
				next: step(
					'select_model',
					`Select ${translateReady[0].name} (or another ready model) on a chapter instead of ${defaultTranslate.name}.`,
				),
			});
		}
	}
	// Review runs on general-purpose models (CLI, remote, or the local chat
	// endpoint). With exactly one ready, Komatose defaults to it — like
	// translation — so only a real choice between several needs a warning.
	const reviewAlternatives = translateReady.filter(
		(row) => row.access === 'cli' || row.access === 'remote_http' || localChatReady(row),
	);
	if (defaultReview && !ready(defaultReview) && reviewAlternatives.length) {
		if (reviewAlternatives.length === 1) {
			items.push({
				id: 'default:review',
				label: 'Default review model',
				group: 'Task coverage',
				state: 'configured',
				detail: `Only ${reviewAlternatives[0].name} can review right now, so it is the default review model.`,
			});
		} else {
			items.push({
				id: 'default:review',
				label: 'Default review model',
				group: 'Task coverage',
				state: 'unavailable',
				detail: `The default review model (${defaultReview.name}) is not ready.`,
				next: step('select_model', `Select ${reviewAlternatives[0].name} for review instead.`),
			});
		}
	}

	const required = items.filter((item) => !item.optional);
	const nextSteps: SetupNextStep[] = [];
	const seen = new Set<SetupAction>();
	for (const action of SETUP_ACTIONS) {
		const hit = required.find((item) => item.next?.action === action);
		if (hit?.next && !seen.has(action)) {
			seen.add(action);
			nextSteps.push(hit.next);
		}
	}
	const summary = {
		configured: items.filter((item) => item.state === 'configured').length,
		missing: items.filter((item) => item.state === 'missing').length,
		unavailable: items.filter((item) => item.state === 'unavailable').length,
	};
	return { items, summary, nextSteps };
}
