import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { MIB, pciKey, type GgmlDevice, type GpuUsage } from '../computeDevices';
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

export type RenderNode = { minor: number; pdev: string; totalMiB?: number; usedMiB?: number };

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

/** Cards with less dedicated memory than this are an APU's carve-out, not a discrete GPU. */
const CARVE_OUT_MIB = 4096;

type VulkanDevice = { name: string; integrated?: boolean; totalMiB?: number; freeMiB?: number };

/**
 * Which render node each Vulkan device is. Vulkan numbering does not follow
 * render-node order (RADV can list the iGPU first), so cards are paired by
 * integrated vs discrete, then size, then how much memory each is using,
 * which is what tells two identical cards apart.
 */
export function vulkanNamesByPdev(renders: RenderNode[], devices: VulkanDevice[]): Map<string, string> {
	const map = new Map<string, string>();
	if (!renders.length || renders.length !== devices.length) return map;
	const ordered = [...renders].sort((a, b) => a.minor - b.minor);
	const carveOut = (node: RenderNode) => node.totalMiB != null && node.totalMiB < CARVE_OUT_MIB;
	const integrated = (device: VulkanDevice) => Boolean(device.integrated);
	const measured = ordered.every((node) => node.totalMiB != null) && devices.every((device) => device.totalMiB != null);
	if (!measured) {
		ordered.forEach((node, index) => map.set(node.pdev.toLowerCase(), devices[index].name));
		return map;
	}
	const used = (value: number | undefined) => value ?? 0;
	const left = [...devices];
	for (const node of ordered) {
		const pool = left.filter((device) => integrated(device) === carveOut(node));
		const candidates = pool.length ? pool : left;
		const similar = candidates.filter((device) => Math.abs((device.totalMiB || 0) - (node.totalMiB || 0)) <= (node.totalMiB || 0) * 0.1);
		const pick = (similar.length && !carveOut(node) ? similar : candidates).sort(
			(a, b) =>
				Math.abs(used((a.totalMiB || 0) - (a.freeMiB ?? 0)) - used(node.usedMiB)) -
				Math.abs(used((b.totalMiB || 0) - (b.freeMiB ?? 0)) - used(node.usedMiB)),
		)[0];
		map.set(node.pdev.toLowerCase(), pick.name);
		left.splice(left.indexOf(pick), 1);
	}
	return map;
}

function sysfsMiB(path: string): number | undefined {
	try {
		const value = Number(readFileSync(path, 'utf8').trim());
		return Number.isFinite(value) && value > 0 ? Math.round(value / MIB) : undefined;
	} catch {
		return undefined;
	}
}

export function readRenderNodes(): RenderNode[] {
	const root = '/sys/class/drm';
	try {
		return readdirSync(root).flatMap((name) => {
			const minor = /^renderD(\d+)$/.exec(name);
			if (!minor) return [];
			try {
				const device = join(root, name, 'device');
				const pdev = realpathSync(device).split('/').pop() || '';
				if (!pdev) return [];
				// amdgpu reports dedicated memory here; other drivers leave both undefined.
				return [{ minor: Number(minor[1]), pdev, totalMiB: sysfsMiB(join(device, 'mem_info_vram_total')), usedMiB: sysfsMiB(join(device, 'mem_info_vram_used')) }];
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
	const names = devices.every((device) => device.pdev)
		? new Map(devices.map((device) => [device.pdev!, device.name]))
		: vulkanNamesByPdev(readRenderNodes(), devices);
	const rows: GpuUsage[] = [];
	for (const device of snap) {
		const name = names.get(pciKey(device.pdev)) || names.get((device.pdev || '').toLowerCase());
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
