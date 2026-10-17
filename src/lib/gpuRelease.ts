/**
 * What the hardware page is allowed to take off a GPU.
 * Every Komatose model and worker can stop, including Qwen 3.8 27B.
 */

export type GpuStopKind = 'managed' | 'review' | 'editor' | 'worker' | 'pid';

export type GpuStop = { kind: GpuStopKind; id: string };

export type GpuServiceRef = {
	kind: Exclude<GpuStopKind, 'pid'>;
	id: string;
	label: string;
	slug?: string;
	name?: string;
	state?: string;
	pid?: number;
};

export type GpuWorkerId = 'cleaning-worker' | 'ocr-worker' | 'translation-worker';

export type GpuWorkerRow = {
	id: GpuWorkerId;
	label: string;
	running: boolean;
	pid?: number;
	detail?: string;
};

/** Running services. One stop per process. */
export function runningGpuStops(services: GpuServiceRef[]): GpuServiceRef[] {
	const seen = new Set<string>();
	const out: GpuServiceRef[] = [];
	for (const service of services) {
		if (service.state !== 'running' && service.state !== 'starting') continue;
		const key = service.pid ? `pid:${service.pid}` : `${service.kind}:${service.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(service);
	}
	return out;
}

export function collectGpuServices(data: {
	rows: { id: string; name: string; slug?: string; managedLaunch?: unknown; managed?: { state?: string; pid?: number } }[];
	reviewServers: { id: string; label: string; state: string; pid?: number }[];
	editors: { id: string; label: string; state: string; pid?: number }[];
	workers?: GpuWorkerRow[];
}): GpuServiceRef[] {
	const services: GpuServiceRef[] = [];
	for (const row of data.rows) {
		if (!row.managedLaunch) continue;
		const state = row.managed?.state;
		if (state !== 'running' && state !== 'starting') continue;
		services.push({ kind: 'managed', id: row.id, label: row.name, slug: row.slug, name: row.name, state, pid: row.managed?.pid });
	}
	for (const server of data.reviewServers) {
		if (server.state !== 'running' && server.state !== 'starting') continue;
		services.push({ kind: 'review', id: server.id, label: server.label, state: server.state, pid: server.pid });
	}
	for (const editor of data.editors) {
		if (editor.state !== 'running' && editor.state !== 'starting') continue;
		services.push({ kind: 'editor', id: editor.id, label: editor.label, state: editor.state, pid: editor.pid });
	}
	for (const worker of data.workers || []) {
		if (!worker.running) continue;
		services.push({ kind: 'worker', id: worker.id, label: worker.label, name: worker.label, state: 'running', pid: worker.pid });
	}
	return services;
}

/** Stop control for one line on a GPU card. */
export function residentControl(
	user: { pid?: number; label: string },
	services: GpuServiceRef[],
): { stop?: GpuStop } {
	if (user.label === 'Other' && !user.pid) return {};
	const byPid = user.pid ? services.find((service) => service.pid === user.pid) : undefined;
	if (byPid) return { stop: { kind: byPid.kind, id: byPid.id } };
	const byLabel = services.find((service) => service.label === user.label);
	if (byLabel) return { stop: { kind: byLabel.kind, id: byLabel.id } };
	if (user.label === 'Cleaning worker') return { stop: { kind: 'worker', id: 'cleaning-worker' } };
	if (user.label === 'OCR worker') return { stop: { kind: 'worker', id: 'ocr-worker' } };
	if (user.label === 'Translation worker') return { stop: { kind: 'worker', id: 'translation-worker' } };
	if (user.pid) return { stop: { kind: 'pid', id: String(user.pid) } };
	return {};
}

/** llama.cpp, the image editor, and this install's Python workers. */
export function ownGpuCommand(cmdline: string): boolean {
	return /komatose|llama-server|llama\.cpp|sd-server|stable-diffusion|\.venv-/.test(cmdline);
}

/** A pid from the hardware page may be signalled only when it belongs to Komatose. */
export function mayKillGpuProcess(pid: number, _label: string, cmdline: string, selfPid = 0): boolean {
	if (!pid || pid === selfPid) return false;
	return ownGpuCommand(cmdline);
}
