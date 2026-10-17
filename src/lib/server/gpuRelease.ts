import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { imageEditModelOf } from '../imageEdit';
import {
	mayKillGpuProcess,
	runningGpuStops,
	type GpuServiceRef,
	type GpuStopKind,
	type GpuWorkerRow,
} from '../gpuRelease';
import { gpuUsage } from './computeDevices';
import { imageEditStatuses, operateImageEditServer, waitImageEditOperation } from './imageEdit';
import { listReviewServerStatuses, operateReviewServer, waitReviewOperation } from './localReview';
import { retireWorkflowWorker, workflowWorkerStatus } from './localWorker';
import { managedModelStatus, operateManagedModel, waitManagedOperation } from './managedModels';
import { findRegistryRow, listRegistryRows } from './modelRegistryStore';
import { ocrWorkerStatus, retireOcrWorker } from './ocr';
import { stopTranslationRuntime, translationWorkerStatus } from './translationRuntime';

export type GpuReleaseResult = { stopped: string[]; errors: string[] };

export function gpuWorkerRows(): GpuWorkerRow[] {
	const cleaning = workflowWorkerStatus();
	const ocr = ocrWorkerStatus();
	const translation = translationWorkerStatus();
	return [
		{ id: 'cleaning-worker', label: 'Cleaning worker', running: cleaning.running, pid: cleaning.pid },
		{ id: 'ocr-worker', label: 'OCR worker', running: ocr.running, pid: ocr.pid },
		{ id: 'translation-worker', label: 'Translation worker', running: translation.running, pid: translation.pid, detail: translation.detail },
	];
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readCmd(pid: number): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
	} catch {
		return '';
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function killIfAlive(pid: number, label: string): Promise<'killed' | 'gone' | 'foreign'> {
	if (!pid || pid === process.pid) return 'foreign';
	const cmdline = readCmd(pid);
	if (!cmdline) return 'gone';
	if (!mayKillGpuProcess(pid, label, cmdline, process.pid)) return 'foreign';
	try {
		process.kill(pid, 'SIGTERM');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
		throw error;
	}
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (!alive(pid)) return 'killed';
		await delay(100);
	}
	try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
	return 'killed';
}

async function liveServices(): Promise<GpuServiceRef[]> {
	const services: GpuServiceRef[] = [];
	for (const row of listRegistryRows()) {
		if (!row.managedLaunch) continue;
		const status = managedModelStatus(row);
		if (status.state !== 'running' && status.state !== 'starting') continue;
		services.push({ kind: 'managed', id: row.id, label: row.name, slug: row.slug, name: row.name, state: status.state, pid: status.pid });
	}
	for (const server of await listReviewServerStatuses()) {
		if (server.state !== 'running' && server.state !== 'starting') continue;
		services.push({ kind: 'review', id: server.id, label: server.label, state: server.state, pid: server.pid });
	}
	for (const editor of imageEditStatuses()) {
		if (editor.state !== 'running' && editor.state !== 'starting') continue;
		services.push({ kind: 'editor', id: editor.id, label: editor.label, state: editor.state, pid: editor.pid });
	}
	for (const worker of gpuWorkerRows()) {
		if (!worker.running) continue;
		services.push({ kind: 'worker', id: worker.id, label: worker.label, state: 'running', pid: worker.pid });
	}
	return services;
}

async function stopTracked(service: GpuServiceRef): Promise<boolean> {
	if (service.kind === 'managed') {
		const row = findRegistryRow(service.id);
		if (!row) throw new Error('Model not found');
		operateManagedModel(row.id, 'stop');
		await waitManagedOperation(row.id);
		const after = managedModelStatus(row);
		if (after.state === 'error') throw new Error(after.error || `${row.name} did not stop`);
		return true;
	}
	if (service.kind === 'review') {
		operateReviewServer(service.id, 'stop');
		await waitReviewOperation(service.id);
		const after = (await listReviewServerStatuses()).find((server) => server.id === service.id);
		if (after?.state === 'error') throw new Error(after.error || `${service.label} did not stop`);
		return true;
	}
	if (service.kind === 'editor') {
		const id = imageEditModelOf(service.id).id;
		operateImageEditServer('stop', id);
		await waitImageEditOperation(id);
		const after = imageEditStatuses().find((editor) => editor.id === id);
		if (after?.state === 'error') throw new Error(after.error || `${service.label} did not stop`);
		return true;
	}
	if (service.id === 'cleaning-worker') {
		if (!workflowWorkerStatus().running) return false;
		await retireWorkflowWorker();
		return true;
	}
	if (service.id === 'ocr-worker') {
		if (!ocrWorkerStatus().running) return false;
		await retireOcrWorker();
		return true;
	}
	if (service.id === 'translation-worker') {
		if (!translationWorkerStatus().running) return false;
		await stopTranslationRuntime();
		return true;
	}
	throw Object.assign(new Error('Unknown model'), { status: 400 });
}

/** Stop one resident. A leftover process is signalled after the service stop. */
export async function stopOneGpu(body: { kind?: string; id?: string; pid?: unknown; label?: string }): Promise<GpuReleaseResult> {
	const kind = String(body.kind || '') as GpuStopKind;
	const id = String(body.id || '').trim();
	const label = String(body.label || id || 'process').trim() || 'process';
	const pid = Number(body.pid);
	const hasPid = Number.isInteger(pid) && pid > 0;
	if (!['managed', 'review', 'editor', 'worker', 'pid'].includes(kind))
		throw Object.assign(new Error('Unknown model'), { status: 400 });
	const stopped = new Set<string>();
	const errors: string[] = [];
	if (kind !== 'pid') {
		try {
			if (await stopTracked({ kind, id, label, state: 'running', pid: hasPid ? pid : undefined })) stopped.add(label);
		} catch (error) {
			if ((error as { status?: number }).status === 400) throw error;
			errors.push(`${label}: ${messageOf(error)}`);
		}
	} else if (!hasPid) {
		throw Object.assign(new Error('Missing process'), { status: 400 });
	}
	if (hasPid) {
		const result = await killIfAlive(pid, label);
		if (result === 'killed') {
			stopped.add(label);
			errors.length = 0;
		} else if (result === 'foreign' && !stopped.size)
			errors.push(`${label}: that process is not a Komatose model`);
	}
	return { stopped: [...stopped], errors };
}

/** Stop every Komatose model and worker still on a GPU. */
export async function stopOtherGpuModels(): Promise<GpuReleaseResult> {
	const before = await liveServices();
	const stopped = new Set<string>();
	const errors: string[] = [];
	for (const service of runningGpuStops(before)) {
		try {
			if (await stopTracked(service)) stopped.add(service.label);
		} catch (error) {
			if ((error as { status?: number }).status === 400) continue;
			errors.push(`${service.label}: ${messageOf(error)}`);
		}
	}
	for (const device of gpuUsage()) {
		for (const resident of device.residents || []) {
			if (!resident.pid) continue;
			try {
				const result = await killIfAlive(resident.pid, resident.label);
				if (result === 'killed') {
					stopped.add(resident.label);
					const prefix = `${resident.label}:`;
					for (let i = errors.length - 1; i >= 0; i--) if (errors[i].startsWith(prefix)) errors.splice(i, 1);
				}
			} catch (error) {
				errors.push(`${resident.label}: ${messageOf(error)}`);
			}
		}
	}
	return { stopped: [...stopped], errors };
}
