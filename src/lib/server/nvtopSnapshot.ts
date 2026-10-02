import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MIB, type GgmlDevice, type GpuUsage } from '../computeDevices';
import { collectResidents, type GpuProcessSample } from '../gpuResidents';
import { ownedNvtopPath, ownedNvtopReady } from './nvtopBuild';

/**
 * One `nvtop -s` snapshot for every card.
 *
 * Stock nvtop 3.3.2 omits the PCI address and hides GTT, so two 7900 XTXs are
 * indistinguishable and a text encoder parked in system RAM disappears.
 * Komatose runs the binary it builds under data/tools/nvtop. SCAN_NVTOP overrides it.
 */

type SnapshotProcess = { pid?: string | number; cmdline?: string | null; gpu_mem_bytes_alloc?: string | null; gpu_gtt_bytes?: string | null };
type SnapshotDevice = {
	device_name?: string;
	pdev?: string | null;
	integrated?: boolean;
	mem_total?: string;
	mem_used?: string;
	processes?: SnapshotProcess[];
};

export type RenderNode = { minor: number; pdev: string };

/** SCAN_NVTOP when it points at a file, otherwise the binary this install built. */
export function nvtopBin(): string | undefined {
	const configured = (process.env.SCAN_NVTOP || '').trim();
	if (configured && existsSync(configured)) return configured;
	return ownedNvtopReady() ? ownedNvtopPath() : undefined;
}

function bytes(value: unknown): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseNvtopSnapshot(text: string): SnapshotDevice[] {
	const start = text.indexOf('[');
	if (start < 0) return [];
	try {
		const parsed = JSON.parse(text.slice(start)) as SnapshotDevice[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/** RADV's Vulkan0, Vulkan1, … follow DRM render-node order. The PCI address joins that to nvtop. */
export function vulkanNamesByPdev(renders: RenderNode[], devices: { name: string }[]): Map<string, string> {
	const map = new Map<string, string>();
	const ordered = [...renders].sort((a, b) => a.minor - b.minor);
	if (ordered.length && ordered.length === devices.length)
		ordered.forEach((node, index) => map.set(node.pdev.toLowerCase(), devices[index].name));
	return map;
}

export function readRenderNodes(): RenderNode[] {
	const root = '/sys/class/drm';
	try {
		return readdirSync(root).flatMap((name) => {
			const minor = /^renderD(\d+)$/.exec(name);
			if (!minor) return [];
			try {
				const pdev = realpathSync(join(root, name, 'device')).split('/').pop() || '';
				return pdev ? [{ minor: Number(minor[1]), pdev }] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function readSnapshot(): SnapshotDevice[] {
	const bin = nvtopBin();
	if (!bin) return [];
	const result = spawnSync(bin, ['-s', '-C'], { encoding: 'utf8', timeout: 8_000 });
	if (result.status !== 0) return [];
	return parseNvtopSnapshot(String(result.stdout || ''));
}

function processesOf(device: SnapshotDevice): GpuProcessSample[] {
	return (device.processes || []).map((proc) => ({
		pid: Number(proc.pid) || 0,
		cmdline: proc.cmdline || '',
		vramBytes: bytes(proc.gpu_mem_bytes_alloc),
		gttBytes: bytes(proc.gpu_gtt_bytes),
	}));
}

/** Per-card VRAM plus the processes on it. Empty when nvtop is missing or has no PCI address. */
export function nvtopUsage(devices: GgmlDevice[]): GpuUsage[] {
	const snap = readSnapshot();
	if (!snap.length || !snap.some((device) => device.pdev)) return [];
	const names = vulkanNamesByPdev(readRenderNodes(), devices);
	const rows: GpuUsage[] = [];
	for (const device of snap) {
		const pdev = (device.pdev || '').toLowerCase();
		const name = names.get(pdev);
		if (!name || rows.some((row) => row.name === name)) continue;
		const known = devices.find((item) => item.name === name);
		rows.push({
			name,
			totalMiB: Math.round(bytes(device.mem_total) / MIB),
			usedMiB: Math.round(bytes(device.mem_used) / MIB),
			source: 'nvtop',
			pdev: device.pdev || undefined,
			integrated: Boolean(device.integrated || known?.integrated),
			residents: collectResidents(processesOf(device)),
		});
	}
	rows.sort((a, b) => Number(Boolean(a.integrated)) - Number(Boolean(b.integrated)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
	return rows;
}
