import { writable, get } from 'svelte/store';
import {
	CHAT_AND_CLI_OPERATIONS,
	accessGroup,
	rowHasOperation,
	type ModelRow,
	type ProbeSample,
} from '$lib/modelRegistry';
import type { ProviderOperation } from '$lib/providerCatalog';
import { INSTALL_TARGETS, type InstallTarget } from '$lib/installCatalog';
import type { GpuUsage, HardwareSnapshot, ResolvedDevice } from '$lib/computeDevices';
import type { DetectorDefaults } from '$lib/detectorSetup';

/**
 * Shared state for the Admin → Models area. One snapshot endpoint feeds every
 * page; helpers below are the mockup's derived views (job coverage, attention
 * list, per-model status) computed against real data.
 */

export type PublicRow = ModelRow & {
  readiness?: { available: boolean; reason?: string };
  service?: { state: string; active: number; error?: string };
  packageOperation?: { action: string; state: string; messages: string[]; error?: string };
	group: string;
	probes?: Partial<Record<ProviderOperation, ProbeSample & { medianMs?: number }>>;
	managed?: { id: string; state: string; device?: string; deviceChoice?: string; port?: number; activeUses?: number; pendingChanges?: boolean; error?: string };
};

export type InstallQueueItem = {
	key: string;
	kind: 'env' | 'model';
	label: string;
	command: string;
	neededBy?: string;
	state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
	error?: string;
};

export type InstallStatusRow = {
	id: string;
	installed: boolean;
	detail?: string;
	blocked?: boolean;
	blocker?: string;
	command: string;
	job?: { state: string; lines: string[]; exitCode?: number | null; error?: string };
};

export type ReviewServerRow = {
	id: string;
	label: string;
	installed: boolean;
	state: string;
	port?: number;
	pid?: number;
	device?: string;
	deviceChoice?: string;
	served?: string;
	error?: string;
	busy?: boolean;
};

export type ImageEditRow = {
	id: string;
	label: string;
	installed: boolean;
	state: string;
	device: string;
	deviceChoice?: string;
	port: number;
	pid?: number;
	error?: string;
	displaced: string[];
	evicted: string[];
	foreign: { pid: number; label: string }[];
	models: { id: string; label: string; method: string; installed: boolean; quant?: string; active: boolean }[];
	busy?: boolean;
};

export type CliToolRow = {
	id: string;
	label: string;
	found: boolean;
	path?: string;
	source: string;
	message: string;
	environmentVar?: string;
	environmentOverride?: boolean;
};

export type HubData = {
	hardware: HardwareSnapshot;
	usage: GpuUsage[];
	catalogs: Record<string, { adapter: string; at: number; models: { id: string; label: string }[] } | null>;
	rows: PublicRow[];
	cliTools: CliToolRow[];
	installs: InstallStatusRow[];
	queue: InstallQueueItem[];
	torchVariant: 'auto' | 'cpu' | 'cuda' | 'rocm';
	managed: { id: string; state: string; device?: string; deviceChoice?: string; port?: number; activeUses?: number; pendingChanges?: boolean; error?: string }[];
	reviewServers: ReviewServerRow[];
	/** One record per editor model; each runs its own service. */
	editors: ImageEditRow[];
	environments: { id: string; label: string; installed: boolean }[];
	/** Per-model device choices as saved (`cleaning-worker`, `qwen-image-2.1`, …). */
	devicePrefs?: Record<string, string>;
	/** Komatose owns the GPUs; `source` says whether `.env` pins it. */
	gpuMode?: { komatose: boolean; source: 'env' | 'setting' | 'default' };
	/** The cleaning worker's saved choice and where `auto` lands right now. */
	cleaningWorker?: { choice: string; resolved: ResolvedDevice };
	defaults: Record<string, string>;
	/** The text detector setup chapters use unless they pick their own. */
	detector?: DetectorDefaults;
	report: {
		items: {
			id: string;
			label: string;
			group: string;
			state: 'configured' | 'missing' | 'unavailable';
			optional?: boolean;
			detail: string;
			next?: { action: string; text: string; href: string };
		}[];
		summary: { configured: number; missing: number; unavailable: number };
		nextSteps: { action: string; text: string; href: string }[];
	};
};

export const hub = writable<HubData | null>(null);
export const hubError = writable<string>('');
export const hubBusy = writable<string>('');

export type Toast = { id: number; text: string; tone: 'ok' | 'warn' | 'bad' };
export const toasts = writable<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'ok') {
	const id = ++toastSeq;
	toasts.update((list) => [...list, { id, text, tone }]);
	setTimeout(() => toasts.update((list) => list.filter((item) => item.id !== id)), 4200);
}

/** Which overlay is open; every page and dialog shares this. */
export const ui = writable<{ drawerId: string | null; addOpen: boolean; addStep: string; addPreset: string; uninstallId: string | null }>({
	drawerId: null,
	addOpen: false,
	addStep: 'choose',
	addPreset: 'qwen38',
	uninstallId: null,
});
export function openDrawer(id: string | null) {
	ui.update((state) => ({ ...state, drawerId: id }));
}
export function openAdd(step = 'choose') {
	ui.update((state) => ({ ...state, addOpen: true, addStep: step }));
}
export function openUninstall(id: string | null) {
	ui.update((state) => ({ ...state, uninstallId: id }));
}

export async function refreshHub(): Promise<void> {
	try {
		const res = await fetch('/api/admin/model-hub');
		const json = await res.json();
		if (!res.ok || json.ok === false) throw new Error(json.error || 'Could not load model data');
		hub.set(json as HubData);
		hubError.set('');
	} catch (e) {
		hubError.set(e instanceof Error ? e.message : String(e));
	}
}

export async function hubPost(body: Record<string, unknown>): Promise<HubData | null> {
	const res = await fetch('/api/admin/model-hub', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	if (!res.ok || json.ok === false) throw new Error(json.error || 'Request failed');
	if (json.rows) hub.update((cur) => (cur ? { ...cur, rows: json.rows, managed: json.managed || cur.managed } : cur));
	if (json.defaults) hub.update((cur) => (cur ? { ...cur, defaults: json.defaults } : cur));
	if (json.torchVariant) hub.update((cur) => (cur ? { ...cur, torchVariant: json.torchVariant } : cur));
	if (json.hardware) hub.update((cur) => (cur ? { ...cur, hardware: json.hardware, usage: json.usage || cur.usage } : cur));
	if (json.devicePrefs || json.gpuMode || json.cleaningWorker)
		hub.update((cur) =>
			cur
				? {
						...cur,
						devicePrefs: json.devicePrefs || cur.devicePrefs,
						gpuMode: json.gpuMode || cur.gpuMode,
						cleaningWorker: json.cleaningWorker || cur.cleaningWorker,
					}
				: cur,
		);
	return get(hub);
}

// ------------------------------------------------------------------ lookups

export function rowById(data: HubData | null, id: string): PublicRow | undefined {
	return data?.rows.find((row) => row.id === id);
}

export function installFor(data: HubData | null, id: string): InstallStatusRow | undefined {
	return data?.installs.find((item) => item.id === id);
}

export function queueFor(data: HubData | null, id: string): InstallQueueItem | undefined {
	return data?.queue.find((item) => item.key === id && (item.state === 'queued' || item.state === 'running'));
}

export type ModelStatus = {
	key: 'ready' | 'missing' | 'installing' | 'attention' | 'optional';
	tone: 'ok' | 'idle' | 'busy' | 'warn' | 'bad';
	label: string;
	detail?: string;
	running?: boolean;
	dot?: 'ok' | 'idle' | 'busy' | 'warn' | 'bad';
};

export function modelStatus(data: HubData | null, row: PublicRow): ModelStatus {
  if (row.packageOperation?.state === 'running') return { key: 'installing', tone: 'busy', label: `${row.packageOperation.action}…` };
  if (row.packageOperation?.state === 'failed') return { key: 'attention', tone: 'bad', label: 'Package operation failed', detail: row.packageOperation.error };
  if (row.readiness) {
    if (!row.readiness.available) return { key: 'missing', tone: 'idle', label: 'Unavailable', detail: row.readiness.reason };
    const running = row.service?.state === 'running' || row.managed?.state === 'running';
    return { key: 'ready', tone: row.disabled ? 'idle' : 'ok', label: running ? 'Running' : 'Ready', running };
  }
	const queued = queueFor(data, row.id);
	if (queued)
		return { key: 'installing', tone: 'busy', label: queued.state === 'running' ? 'Installing…' : 'Queued to install' };
	const install = installFor(data, row.id);
	if (install?.job?.state === 'running') return { key: 'installing', tone: 'busy', label: 'Installing…' };
	if (install && !install.installed) {
		if (install.job?.state === 'failed')
			return { key: 'attention', tone: 'bad', label: 'Install failed', detail: install.job.error || 'The installer exited with an error.' };
		return { key: 'missing', tone: 'idle', label: 'Not installed', detail: install.detail };
	}
	if (row.access === 'remote_http') {
		const item = data?.report.items.find((it) => it.id === `remote:${row.id}`);
		if (item?.state === 'missing')
			return { key: 'attention', tone: 'warn', label: item.detail, detail: item.detail };
		if (row.disabled) return { key: 'ready', tone: 'idle', dot: 'idle', label: 'Ready · hidden from users' };
		return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Ready · billed per call' };
	}
	if (row.access === 'cli') {
		const tool = data?.cliTools.find((item) => item.id === row.cliAdapter);
		if (!tool?.found)
			return {
				key: 'attention',
				tone: tool && tool.source !== 'automatic' ? 'bad' : 'warn',
				label: `${tool?.label || row.cliAdapter} not found`,
				detail: tool?.message,
			};
		if (row.disabled) return { key: 'ready', tone: 'idle', dot: 'idle', label: 'Ready · hidden from users' };
		return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Ready · runs per call' };
	}
	if (row.access === 'proofreader') {
		const configured = Boolean(data?.report.items.find((it) => it.id === 'proofreaders')?.state === 'configured');
		return configured
			? { key: 'ready', tone: 'ok', dot: 'ok', label: 'Configured' }
			: { key: 'optional', tone: 'idle', label: 'Not configured · optional', detail: 'Set SCAN_PROOFREAD_SERVICE_URL to enable page-image proofread.' };
	}
	// Local models: managed rows load on demand; specialist weights must exist.
	if (row.managedLaunch) {
		const state = row.managed?.state || 'stopped';
		if (state === 'running') return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Running', running: true };
		if (state === 'starting' || state === 'stopping') return { key: 'ready', tone: 'busy', label: state === 'starting' ? 'Starting…' : 'Stopping…', running: true };
		if (state === 'error')
			return { key: 'attention', tone: 'bad', label: 'Failed to start', detail: row.managed?.error };
		return { key: 'ready', tone: 'ok', dot: 'idle', label: 'Ready · loads on demand' };
	}
	const review = data?.reviewServers.find((item) => item.id === row.id);
	if (review) {
		if (review.state === 'running') return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Running', running: true };
		if (review.state === 'starting' || review.state === 'stopping') return { key: 'ready', tone: 'busy', label: review.state, running: true };
		if (review.state === 'error') return { key: 'attention', tone: 'bad', label: 'Failed to start', detail: review.error };
		return { key: 'ready', tone: 'ok', dot: 'idle', label: 'Ready · loads on demand' };
	}
	if (row.disabled) return { key: 'ready', tone: 'idle', dot: 'idle', label: 'Ready · hidden from users' };
	return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Installed' };
}

export function usable(data: HubData | null, row: PublicRow): boolean {
	return modelStatus(data, row).key === 'ready';
}

export function readyRowsForOp(data: HubData | null, op: ProviderOperation): PublicRow[] {
	// Ready for a task = installed and its Jobs-panel test passed.
	return (data?.rows || []).filter((row) => usable(data, row) && !row.disabled && rowHasOperation(row, op));
}

// ------------------------------------------------------------------- tasks

export type AdminTask = {
	id: 'detect' | 'transcribe' | 'translate' | 'describe' | 'review' | 'proofread' | 'mask' | 'clean';
	label: string;
	stage: 'Translate' | 'Review' | 'Clean';
	icon: string;
	required?: boolean;
	op?: ProviderOperation;
};

export const ADMIN_TASKS: AdminTask[] = [
	{ id: 'detect', label: 'Detect text', stage: 'Translate', icon: 'bi-bounding-box', required: true },
	{ id: 'transcribe', label: 'Transcribe', stage: 'Translate', icon: 'bi-fonts', required: true, op: 'vision' },
	{ id: 'translate', label: 'Translate', stage: 'Translate', icon: 'bi-translate', required: true, op: 'translate' },
	{ id: 'describe', label: 'Scene notes', stage: 'Translate', icon: 'bi-card-text', op: 'describe' },
	{ id: 'review', label: 'AI review', stage: 'Review', icon: 'bi-people', op: 'advisory' },
	{ id: 'proofread', label: 'Proofread', stage: 'Review', icon: 'bi-spellcheck', op: 'proofreadEnglish' },
	{ id: 'mask', label: 'Text masks', stage: 'Clean', icon: 'bi-brush', required: true },
	{ id: 'clean', label: 'Clean artwork', stage: 'Clean', icon: 'bi-magic' },
];

export type Coverage = {
	tone: 'ok' | 'warn' | 'bad' | 'idle';
	label: string;
	def?: PublicRow;
	defLabel?: string;
	others: string[];
	text?: string;
	note?: string;
};

const nameOf = (rows: PublicRow[]) => rows.map((row) => row.name);

function fallbackNotice(data: HubData | null, op: ProviderOperation): { wanted?: PublicRow; fallback?: PublicRow } {
	const ready = readyRowsForOp(data, op);
	const wantedId = data?.defaults[op];
	const wanted = wantedId ? rowById(data || null, wantedId) : undefined;
	if (wanted && ready.length && !ready.includes(wanted)) return { wanted, fallback: ready[0] };
	return {};
}

export function coverageFor(data: HubData | null, task: AdminTask): Coverage {
	const installed = (id: string) => installFor(data, id)?.installed === true;
	const reviewInstalled = (id: string) =>
		data?.reviewServers.find((item) => item.id === id)?.installed === true || installed(id);
	const none: Coverage = { tone: 'idle', label: 'Not set up', others: [] };

	switch (task.id) {
		case 'detect': {
			if (installed('rtdetr') || installed('ctd'))
				return { tone: 'ok', label: 'Ready', defLabel: installed('rtdetr') ? 'RT-DETR' : 'Comic Text Detector', others: [] };
			return { tone: 'warn', label: 'Basic only', others: [], text: 'Only the built-in heuristic detector, which cannot see borderless text.' };
		}
		case 'mask': {
			const have = ['ctd', 'koharu'].filter(installed);
			if (have.length) return { tone: 'ok', label: 'Ready', defLabel: have.includes('ctd') ? 'Comic Text Detector' : 'Koharu', others: [] };
			return { tone: 'warn', label: 'Brush only', others: [], text: 'Masks are painted by hand.' };
		}
		case 'clean': {
			const editors = (data?.editors || []).filter((m) => m.installed);
			const fill = ['lama-manga', 'big-lama', 'aot'].filter(installed);
			if (editors.length)
				return { tone: 'ok', label: 'Ready', defLabel: editors[0].label, others: editors.slice(1).map((m) => m.label), note: fill.length ? `Fill methods: ${fill.length} installed.` : undefined };
			if (fill.length) return { tone: 'warn', label: 'Fill only', defLabel: 'Inpainting fill', others: [], text: 'Detailed art under lettering can’t be redrawn.' };
			return { tone: 'warn', label: 'Built-ins only', others: [], text: 'Flat fill and Telea only.' };
		}
		case 'transcribe': {
			const councilIds = ['hayai-ocr-v2', 'paddleocr-vl-1.6'];
			const council = councilIds.filter(reviewInstalled).map((id) => rowById(data, id)).filter((r): r is PublicRow => Boolean(r));
			const vision = readyRowsForOp(data, 'vision').filter((row) => !councilIds.includes(row.id));
			if (council.length === 2)
				return { tone: 'ok', label: 'Ready', defLabel: council.map((r) => r.name).join(' + '), others: nameOf(vision) };
			if (council.length === 1)
				return { tone: 'warn', label: 'Half council', defLabel: council[0].name, others: nameOf(vision), text: 'Disagreements can’t be caught with one reader.' };
			if (vision.length) return { tone: 'warn', label: 'Fallback', def: vision[0], others: nameOf(vision.slice(1)), text: 'No OCR council; transcription falls back to an image model.' };
			return { tone: 'bad', label: 'Blocked', others: [], text: 'Nothing can read source text yet.' };
		}
		default: {
			if (!task.op) return none;
			const ready = readyRowsForOp(data, task.op);
			if (!ready.length)
				return {
					tone: task.required ? 'bad' : 'idle',
					label: task.required ? 'Blocked' : 'Not set up',
					others: [],
					text: task.required ? `No model can ${task.label.toLowerCase()}.` : undefined,
				};
			const stored = data?.defaults[task.op];
			const wanted = stored ? rowById(data || null, stored) : undefined;
			if (wanted && !ready.includes(wanted))
				return {
					tone: 'warn',
					label: 'Using fallback',
					def: ready[0],
					others: nameOf(ready.filter((r) => r !== ready[0])),
					text: `${wanted.name} is unavailable, so ${ready[0].name} runs instead.`,
				};
			return {
				tone: 'ok',
				label: 'Ready',
				def: wanted || ready[0],
				others: nameOf(ready.filter((r) => r !== (wanted || ready[0]))),
			};
		}
	}
}

export type Attention = {
	tone: 'warn' | 'bad';
	icon: string;
	title: string;
	text: string;
	actions: { label: string; action: string; id?: string; adapter?: string }[];
};

export function attentionList(data: HubData | null): Attention[] {
	const out: Attention[] = [];
	if (!data) return out;
	const seenKeys = new Set<string>();
	const seenCli = new Set<string>();
	for (const row of data.rows) {
		const status = modelStatus(data, row);
		if (status.key !== 'attention') continue;
		if (row.access === 'remote_http') {
			const keyVar = row.http?.apiKeyEnv || 'OPENAI_API_KEY';
			if (seenKeys.has(keyVar)) continue;
			seenKeys.add(keyVar);
			const affected = data.rows.filter((r) => r.access === 'remote_http' && (r.http?.apiKeyEnv || 'OPENAI_API_KEY') === keyVar);
			out.push({
				tone: 'warn',
				icon: 'bi-key',
				title: `${keyVar} is not set`,
				text: `${affected.map((r) => r.name).join(', ')} can’t run until the key is in .env.`,
				actions: [{ label: 'Show me how', action: 'fix-key', id: row.id }, { label: 'Hide model', action: 'hide', id: row.id }],
			});
		} else if (row.access === 'cli') {
			const adapter = row.cliAdapter || '';
			if (seenCli.has(adapter)) continue;
			seenCli.add(adapter);
			const affected = data.rows.filter((r) => r.cliAdapter === adapter);
			out.push({
				tone: status.tone === 'bad' ? 'bad' : 'warn',
				icon: 'bi-terminal-x',
				title: status.label,
				text: `${status.detail || ''} ${affected.length} model${affected.length === 1 ? '' : 's'} depend on it.`,
				actions: [{ label: 'Fix location', action: 'fix-cli', adapter }],
			});
		} else if (status.label === 'Install failed') {
			out.push({
				tone: 'bad',
				icon: 'bi-x-octagon',
				title: `${row.name} failed to install`,
				text: status.detail || '',
				actions: [{ label: 'Retry install', action: 'install', id: row.id }, { label: 'View log', action: 'view-log', id: row.id }],
			});
		} else {
			out.push({
				tone: status.tone === 'bad' ? 'bad' : 'warn',
				icon: 'bi-exclamation-triangle',
				title: `${row.name}: ${status.label}`,
				text: status.detail || '',
				actions: status.detail?.includes('.env') ? [{ label: 'Show me how', action: 'fix-key', id: row.id }] : [],
			});
		}
	}
	return out;
}

// ------------------------------------------------------------ plan & install

export type PlanStep = { id: string; kind: 'env' | 'model'; label: string; diskBytes: number; command: string; neededBy?: string };

/** Client-side mirror of the server plan, for dialog previews before starting. */
export function planSteps(data: HubData | null, ids: string[]): PlanStep[] {
	const out: PlanStep[] = [];
	const seen = new Set<string>();
	const add = (id: string, kind: 'env' | 'model', neededBy?: string) => {
		if (seen.has(id) || queueFor(data, id)) return;
		seen.add(id);
		if (kind === 'env') {
			const env = data?.environments.find((item) => item.id === id);
			if (!env || env.installed) return;
			const target = INSTALL_TARGETS.find((item) => item.id === id);
			if (!target) return;
			out.push({ id, kind, label: target.label, diskBytes: target.diskBytes, command: '', neededBy });
			return;
		}
		const target = INSTALL_TARGETS.find((item) => item.id === id);
		if (!target || installFor(data, id)?.installed) return;
		out.push({ id, kind, label: target.label, diskBytes: target.diskBytes, command: installFor(data, id)?.command || '' });
	};
	for (const id of ids) {
		const target = INSTALL_TARGETS.find((item) => item.id === id);
		if (!target) continue;
		for (const envId of target.requires || []) add(envId, 'env', target.label);
		add(id, 'model');
	}
	// Commands come from the server snapshot when available.
	for (const step of out)
		if (!step.command) step.command = step.kind === 'env' ? `python3 scripts/setup-python-env.py --env ${step.id.slice(4)}` : installFor(data, step.id)?.command || '';
	return out;
}

// ------------------------------------------------------------- devices

export type DeviceUser = { label: string; kind: 'chat' | 'ocr' | 'edit' | 'foreign'; detail?: string };
export type DeviceRow = {
	name: string;
	label: string;
	totalMiB: number;
	usedMiB: number;
	integrated: boolean;
	users: DeviceUser[];
};

/** One row per GPU the machine reports, with what is resident on it right now. */
export function deviceRows(data: HubData | null): DeviceRow[] {
	if (!data) return [];
	const ggml = data.hardware.llama.devices;
	const usersByDevice = new Map<string, DeviceUser[]>();
	const add = (device: string | undefined, user: DeviceUser) => {
		if (!device) return;
		const list = usersByDevice.get(device) || [];
		list.push(user);
		usersByDevice.set(device, list);
	};
	for (const row of data.rows) {
		if (!row.managedLaunch || row.managed?.state !== 'running') continue;
		add(row.managed.device || row.managedLaunch.device, {
			label: row.name,
			kind: 'chat',
			detail: row.managed.port ? `port ${row.managed.port}` : undefined,
		});
	}
	for (const server of data.reviewServers) {
		if (server.state !== 'running') continue;
		add(server.device?.split(' ')[0], { label: server.label, kind: 'ocr', detail: server.port ? `port ${server.port}` : undefined });
	}
	for (const editor of data.editors) {
		if (editor.state !== 'running') continue;
		add(editor.device.split(' ')[0], { label: editor.label, kind: 'edit', detail: `port ${editor.port}` });
	}

	const rows: DeviceRow[] = [];
	const seen = new Set<string>();
	for (const usage of data.usage) {
		const known = ggml.find((device) => device.name === usage.name);
		seen.add(usage.name);
		rows.push({
			name: usage.name,
			label: known?.label || usage.name,
			totalMiB: usage.totalMiB,
			usedMiB: usage.usedMiB,
			integrated: known?.integrated ?? false,
			users: usersByDevice.get(usage.name) || [],
		});
	}
	for (const device of ggml) {
		if (seen.has(device.name)) continue;
		rows.push({
			name: device.name,
			label: device.label,
			totalMiB: device.totalMiB,
			usedMiB: Math.max(0, device.totalMiB - device.freeMiB),
			integrated: device.integrated,
			users: usersByDevice.get(device.name) || [],
		});
	}
	return rows;
}

// ------------------------------------------------------------ list entries

export const OP_TASK: Partial<Record<ProviderOperation, AdminTask['id']>> = {
	vision: 'transcribe',
	translate: 'translate',
	describe: 'describe',
	compactNotes: 'describe',
	advisory: 'review',
	chapterReview: 'review',
	alternatives: 'review',
	proofreadEnglish: 'proofread',
	pageImageProofread: 'proofread',
	cleaning: 'clean',
};

const TARGET_TASKS: Record<string, AdminTask['id'][]> = {
	'qwen3.8-27b': ['translate', 'describe', 'review', 'proofread'],
	rtdetr: ['detect'],
	ctd: ['detect', 'mask'],
	koharu: ['detect', 'mask'],
	coo: ['detect'],
	'hayai-ocr-v2': ['transcribe', 'review'],
	'manga-ocr': ['transcribe'],
	'paddleocr-vl-1.6': ['transcribe', 'review'],
	'qwen3-vl-8b': ['transcribe', 'describe', 'review'],
	'cat-translate-7b-q4': ['translate'],
	'hy-mt2-manga-v5': ['translate'],
	'hy-mt2-7b-q4': ['translate'],
	'imsbee-ko-en-translator': ['translate'],
	'opus-mt-ja-en': ['translate'],
	'shisa-v2.1-qwen3-8b-q4': ['translate'],
	'sugoi-v4-ja-en': ['translate'],
	'translategemma-4b-q4': ['translate'],
	'translategemma-12b-q4': ['translate'],
	'qwen-image-2.1': ['clean'],
	'qwen-image-edit-2511': ['clean'],
	'big-lama': ['clean'],
	aot: ['clean'],
	'lama-manga': ['clean'],
};

export type ListEntry = {
	id: string;
	name: string;
	sub: string;
	source: 'local' | 'remote' | 'cli' | 'service';
	sourceLabel: string;
	tasks: AdminTask['id'][];
	row?: PublicRow;
	target?: InstallTarget;
	installed?: boolean;
	pickable: boolean;
};

/** Registry rows first, then installable models that have no row of their own. */
export function listEntries(data: HubData | null): ListEntry[] {
	const out: ListEntry[] = [];
	if (!data) return out;
	for (const row of data.rows) {
		// The task chips are test results, not a claim about the model: only
		// tasks whose test passed are shown.
		const tasks = [
			...new Set(
				CHAT_AND_CLI_OPERATIONS.filter(op => rowHasOperation(row, op))
					.map(op => OP_TASK[op])
					.filter((task): task is AdminTask['id'] => Boolean(task)),
			),
		];
		out.push({
			id: row.id,
			name: row.name,
			sub: row.slug && row.slug !== row.id ? row.slug : row.id,
			source: row.access === 'remote_http' ? 'remote' : row.access === 'cli' ? 'cli' : row.access === 'proofreader' ? 'service' : 'local',
			sourceLabel:
				row.access === 'remote_http'
					? `Remote · ${row.http?.baseUrl || ''}`
					: row.access === 'cli'
						? `CLI · ${row.cliAdapter}`
						: row.access === 'proofreader'
							? 'External service'
							: row.managedLaunch
								? 'Local · managed'
								: 'Local',
			tasks,
			row,
			pickable: row.access !== 'proofreader',
		});
	}
	const rowIds = new Set(data.rows.map((row) => row.id));
	// A target is superseded once its managed chat row exists (the installer creates it).
	const superseded = new Set(data.rows.filter((row) => row.managedLaunch).map((row) => row.slug));
	for (const target of INSTALL_TARGETS) {
		if (target.id.startsWith('env-') || rowIds.has(target.id)) continue;
		if (target.id === 'qwen3.8-27b' && superseded.has('qwen3.8-27b-q4')) continue;
		if (target.id === 'qwen3-vl-8b' && superseded.has('qwen3-vl-8b')) continue;
		const install = installFor(data, target.id);
		out.push({
			id: target.id,
			name: target.label,
			sub: target.summary,
			source: 'local',
			sourceLabel: 'Local · installable',
			tasks: TARGET_TASKS[target.id] || [],
			target,
			installed: install?.installed,
			pickable: false,
		});
	}
	return out;
}

export function entryStatus(data: HubData | null, entry: ListEntry): ModelStatus {
	if (entry.row) return modelStatus(data, entry.row);
	const queued = queueFor(data, entry.id);
	if (queued) return { key: 'installing', tone: 'busy', label: queued.state === 'running' ? 'Installing…' : 'Queued to install' };
	const install = installFor(data, entry.id);
	if (install?.job?.state === 'running') return { key: 'installing', tone: 'busy', label: 'Installing…' };
	if (install?.job?.state === 'failed')
		return { key: 'attention', tone: 'bad', label: 'Install failed', detail: install.job.error };
	if (install?.installed) {
		if (entry.id.startsWith('qwen-image')) {
			const editor = data?.editors.find((item) => item.id === entry.id);
			if (editor?.state === 'running') return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Loaded', running: true };
			if (editor?.state === 'starting' || editor?.state === 'stopping')
				return { key: 'ready', tone: 'busy', label: editor.state === 'starting' ? 'Starting…' : 'Stopping…', running: true };
			if (editor?.state === 'error') return { key: 'attention', tone: 'bad', label: 'Failed to start', detail: editor.error };
			return { key: 'ready', tone: 'ok', dot: 'idle', label: 'Installed · loads on demand' };
		}
		return { key: 'ready', tone: 'ok', dot: 'ok', label: 'Installed' };
	}
	return { key: 'missing', tone: 'idle', label: 'Not installed', detail: install?.detail };
}

export async function apiPost(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	// A probe that did not pass answers `ok: false` with its reason on `sample`.
	if (!res.ok || json.ok === false) throw new Error(json.error || json.sample?.reason || 'Request failed');
	return json;
}

export const TASK_BY_ID = Object.fromEntries(ADMIN_TASKS.map((task) => [task.id, task]));
export { accessGroup, CHAT_AND_CLI_OPERATIONS };
export type { InstallTarget, ResolvedDevice };
