import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { delimiter, join } from 'node:path';
import {
	assignTorchPdevs,
	ggmlBackend,
	gpuTitles,
	isAutoChoice,
	isCpuChoice,
	looksIntegrated,
	MIB,
	pciKey,
	type DeviceRuntime,
	type GgmlDevice,
	type GpuUsage,
	type HardwareSnapshot,
	type ResolvedDevice,
	type TorchEnvironment,
} from '../computeDevices';
import { llamaServerBin, llamaServerEnv, sdServerBin } from './gpuMode';
import { nvtopUsage, readRenderNodes } from './nvtopSnapshot';
import { ROOT } from './paths';

/**
 * What this machine can run models on, and which device each model should use.
 *
 * ggml programs (llama-server, sd-server) enumerate devices with
 * `llama-server --list-devices`, which works the same for Vulkan, CUDA, ROCm
 * and Metal builds. PyTorch workers enumerate through their own environment,
 * because a CPU wheel sees no GPU even on a GPU machine.
 */

type Store = {
	ggml?: { at: number; bin: string; devices: GgmlDevice[]; error?: string };
	torch: Map<string, TorchEnvironment>;
	torchPending: Map<string, Promise<TorchEnvironment>>;
	usage?: { at: number; value: GpuUsage[] };
};
const globalStore = globalThis as typeof globalThis & { __komatoseHardware?: Store };
const store: Store = (globalStore.__komatoseHardware ??= { torch: new Map(), torchPending: new Map() });

const GGML_TTL_MS = 15_000;
const TORCH_TTL_MS = 12 * 60 * 60_000;
const USAGE_TTL_MS = 3_000;

function dataDir() {
	return process.env.SCAN_DATA_DIR || join(process.env.SCAN_ROOT || process.cwd(), 'data');
}

function onPath(name: string): string | undefined {
	for (const dir of (process.env.PATH || '').split(delimiter)) {
		if (!dir) continue;
		const path = join(dir, name);
		if (existsSync(path)) return path;
	}
	return undefined;
}

function fileExists(path: string) {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ ggml

const LIST_LINE = /^\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;

/** Parses `llama-server --list-devices`; software rasterisers are dropped. */
export function parseGgmlDevices(text: string): GgmlDevice[] {
	const devices: GgmlDevice[] = [];
	for (const line of text.split('\n')) {
		const match = LIST_LINE.exec(line);
		if (!match) continue;
		const [, name, rawLabel, total, free] = match;
		if (/llvmpipe|lavapipe|swiftshader/i.test(rawLabel)) continue;
		const totalMiB = Number(total);
		devices.push({
			name,
			label: rawLabel.replace(/\s*\((?:RADV|NVIDIA|Intel)[^)]*\)\s*$/i, '').trim() || rawLabel,
			backend: ggmlBackend(name),
			totalMiB,
			freeMiB: Number(free),
			integrated: looksIntegrated(rawLabel, totalMiB),
		});
	}
	return devices;
}

/** RADV lists Vulkan0, Vulkan1, … in DRM render-node order, which is how the PCI address is known. */
function attachGgmlPdevs(devices: GgmlDevice[]): GgmlDevice[] {
	const renders = readRenderNodes().sort((a, b) => a.minor - b.minor);
	if (!renders.length || renders.length !== devices.length) return devices;
	return devices.map((device, index) => ({ ...device, pdev: pciKey(renders[index].pdev) || device.pdev }));
}

/** Cached, synchronous: launch paths need an answer before they spawn. */
export function ggmlDevices(maxAgeMs = GGML_TTL_MS): { bin: string; devices: GgmlDevice[]; error?: string } {
	const bin = llamaServerBin();
	const cached = store.ggml;
	if (cached && cached.bin === bin && Date.now() - cached.at < maxAgeMs) return cached;
	if (!fileExists(bin)) {
		store.ggml = { at: Date.now(), bin, devices: [], error: 'llama-server not found' };
		return store.ggml;
	}
	const result = spawnSync(bin, ['--list-devices'], {
		encoding: 'utf8',
		timeout: 15_000,
		env: llamaServerEnv(bin),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const text = `${result.stdout || ''}\n${result.stderr || ''}`;
	const devices = attachGgmlPdevs(parseGgmlDevices(text));
	store.ggml = {
		at: Date.now(),
		bin,
		devices,
		error: result.error ? result.error.message : devices.length ? undefined : 'llama-server listed no GPU devices',
	};
	return store.ggml;
}

// ----------------------------------------------------------------- torch

export const TORCH_ENVIRONMENTS = [
	{ env: 'env-review', label: '.venv-review', variable: 'SCAN_REVIEW_PYTHON', dir: '.venv-review' },
	{ env: 'env-workflow', label: '.venv-workflow', variable: 'SCAN_WORKFLOW_PYTHON', dir: '.venv-workflow' },
] as const;

export function torchPython(env: string): string | undefined {
	const spec = TORCH_ENVIRONMENTS.find((item) => item.env === env);
	if (!spec) return undefined;
	const configured = (process.env[spec.variable] || '').trim();
	if (configured && fileExists(configured)) return configured;
	const local = join(process.env.SCAN_ROOT || ROOT, spec.dir, 'bin/python');
	return fileExists(local) ? local : undefined;
}

const TORCH_PROBE = `
import json
try:
    import torch
except Exception as error:
    print(json.dumps({"missing": True, "error": str(error)}))
    raise SystemExit(0)
out = {"version": torch.__version__, "cuda": torch.version.cuda, "hip": getattr(torch.version, "hip", None), "devices": []}
try:
    for i in range(torch.cuda.device_count()):
        p = torch.cuda.get_device_properties(i)
        out["devices"].append({
            "index": i,
            "name": p.name,
            "memory": p.total_memory,
            "integrated": bool(getattr(p, "is_integrated", 0)),
            "arch": getattr(p, "gcnArchName", None) or f"sm_{p.major}{p.minor}",
            "domain": getattr(p, "pci_domain_id", None),
            "bus": getattr(p, "pci_bus_id", None),
            "slot": getattr(p, "pci_device_id", None),
        })
except Exception as error:
    out["error"] = str(error)
print(json.dumps(out))
`;

function torchCachePath() {
	return join(dataDir(), 'run', 'torch-devices.json');
}

function readTorchCache(): Record<string, TorchEnvironment> {
	try {
		return JSON.parse(readFileSync(torchCachePath(), 'utf8'));
	} catch {
		return {};
	}
}

function writeTorchCache(value: Record<string, TorchEnvironment>) {
	try {
		mkdirSync(join(dataDir(), 'run'), { recursive: true });
		const temp = `${torchCachePath()}.tmp`;
		writeFileSync(temp, JSON.stringify(value));
		renameSync(temp, torchCachePath());
	} catch {
		/* read-only data dir: keep the in-memory copy */
	}
}

/** Env without device masks, so the probe sees every GPU the wheel supports. */
function probeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID', PYTHONUNBUFFERED: '1' };
	delete env.CUDA_VISIBLE_DEVICES;
	delete env.HIP_VISIBLE_DEVICES;
	delete env.ROCR_VISIBLE_DEVICES;
	return env;
}

export function parseTorchProbe(env: string, path: string, stdout: string): TorchEnvironment {
	const base: TorchEnvironment = { env, path, backend: 'unknown', devices: [], at: Date.now() };
	const line = stdout.trim().split('\n').reverse().find((item) => item.trim().startsWith('{'));
	if (!line) return { ...base, error: 'The PyTorch probe printed nothing' };
	const raw = JSON.parse(line) as {
		missing?: boolean;
		error?: string;
		version?: string;
		cuda?: string | null;
		hip?: string | null;
		devices?: { index: number; name: string; memory: number; integrated: boolean; arch?: string; domain?: number; bus?: number; slot?: number }[];
	};
	if (raw.missing) return { ...base, backend: 'missing', error: raw.error };
	const backend = raw.hip ? 'rocm' : raw.cuda ? 'cuda' : 'cpu';
	const generic = (name: string) => /^(AMD Radeon Graphics|AMD Radeon GPU|GPU)$/i.test(name.trim());
	return {
		...base,
		backend,
		version: raw.version,
		error: raw.error,
		devices: (raw.devices || []).map((item) => {
			const totalMiB = Math.round(item.memory / MIB);
			const tail = [generic(item.name) && item.arch ? item.arch : '', item.bus != null && generic(item.name) ? `bus ${item.bus}` : '']
				.filter(Boolean)
				.join(', ');
			const integrated = item.integrated || looksIntegrated(item.name, totalMiB);
			return {
				name: `cuda:${item.index}`,
				index: item.index,
				label: tail ? `${item.name} (${tail})` : item.name,
				backend: backend === 'rocm' ? 'rocm' : 'cuda',
				totalMiB,
				integrated,
				pdev: item.bus == null ? undefined : pciKey({ domain: item.domain, bus: item.bus, device: item.slot }),
			};
		}),
	};
}

async function probeTorch(env: string): Promise<TorchEnvironment> {
	const path = torchPython(env);
	if (!path) return { env, path: '', backend: 'missing', devices: [], at: Date.now(), error: 'Environment not installed' };
	return new Promise((resolve) => {
		execFile(path, ['-c', TORCH_PROBE], { timeout: 120_000, env: probeEnv(), maxBuffer: 1 << 20 }, (error, stdout) => {
			try {
				const parsed = parseTorchProbe(env, path, String(stdout || ''));
				resolve(error && !parsed.devices.length && parsed.backend === 'unknown' ? { ...parsed, error: error.message } : parsed);
			} catch (e) {
				resolve({ env, path, backend: 'unknown', devices: [], at: Date.now(), error: e instanceof Error ? e.message : String(e) });
			}
		});
	});
}

/** Last known PyTorch view of one environment; refreshes in the background when stale. */
export function torchEnvironment(env: string, { refresh = false } = {}): TorchEnvironment | undefined {
	const path = torchPython(env);
	let known = store.torch.get(env);
	if (!known) {
		const disk = readTorchCache()[env];
		if (disk && disk.path === (path || '')) {
			known = disk;
			store.torch.set(env, disk);
		}
	}
	if (known && known.path !== (path || '')) known = undefined;
	const stale = !known || refresh || Date.now() - known.at > TORCH_TTL_MS;
	if (stale && !store.torchPending.has(env)) {
		const pending = probeTorch(env)
			.then((value) => {
				store.torch.set(env, value);
				writeTorchCache({ ...readTorchCache(), [env]: value });
				return value;
			})
			.finally(() => store.torchPending.delete(env));
		store.torchPending.set(env, pending);
	}
	return known;
}

/** Waits for the first probe of an environment, so a cold start does not settle for CPU. */
export async function ensureTorchProbe(env: string): Promise<TorchEnvironment | undefined> {
	const known = torchEnvironment(env);
	if (known) return known;
	return (await store.torchPending.get(env)) || store.torch.get(env);
}

export async function torchEnvironmentFresh(env: string): Promise<TorchEnvironment | undefined> {
	torchEnvironment(env, { refresh: true });
	return (await store.torchPending.get(env)) || store.torch.get(env);
}

/** Forget cached PyTorch probes (after an environment install or a GPU wheel swap). */
export function invalidateTorchProbe(env?: string) {
	if (env) store.torch.delete(env);
	else store.torch.clear();
	const disk = readTorchCache();
	if (env) delete disk[env];
	writeTorchCache(env ? disk : {});
}

// ----------------------------------------------------------------- usage

function nvidiaUsage(): GpuUsage[] {
	const bin = onPath('nvidia-smi');
	if (!bin) return [];
	const result = spawnSync(bin, ['--query-gpu=index,name,memory.total,memory.used', '--format=csv,noheader,nounits'], {
		encoding: 'utf8',
		timeout: 5_000,
	});
	if (result.status !== 0) return [];
	return String(result.stdout || '')
		.split('\n')
		.map((line) => line.split(',').map((part) => part.trim()))
		.filter((parts) => parts.length >= 4 && parts[1])
		.map(([, name, total, used]) => ({ name, totalMiB: Number(total), usedMiB: Number(used), source: 'nvidia-smi' as const }));
}

/**
 * Live memory: one snapshot from the nvtop this install built,
 * otherwise nvidia-smi, otherwise ggml's own free-memory report.
 */
export function gpuUsage(): GpuUsage[] {
	if (store.usage && Date.now() - store.usage.at < USAGE_TTL_MS) return store.usage.value;
	const nvtop = nvtopUsage(ggmlDevices(USAGE_TTL_MS * 2).devices);
	if (nvtop.length) {
		store.usage = { at: Date.now(), value: nvtop };
		return nvtop;
	}
	const nvidia = nvidiaUsage();
	const ggml = ggmlDevices(USAGE_TTL_MS * 2).devices.filter((device) => !device.integrated);
	const value: GpuUsage[] = ggml.map((device) => {
		const match = nvidia.find((row) => device.label.includes(row.name) || row.name.includes(device.label));
		return match
			? { ...match, name: device.name }
			: { name: device.name, totalMiB: device.totalMiB, usedMiB: Math.max(0, device.totalMiB - device.freeMiB), source: 'ggml' as const };
	});
	store.usage = { at: Date.now(), value: value.length ? value : nvidia };
	return store.usage.value;
}

export function hardwareSnapshot({ refresh = false } = {}): HardwareSnapshot {
	const ggml = ggmlDevices(refresh ? 0 : GGML_TTL_MS);
	if (refresh) store.usage = undefined;
	const torch = TORCH_ENVIRONMENTS.map(
		(spec) =>
			torchEnvironment(spec.env, { refresh }) || {
				env: spec.env,
				path: torchPython(spec.env) || '',
				backend: torchPython(spec.env) ? ('unknown' as const) : ('missing' as const),
				devices: [],
				at: 0,
				error: torchPython(spec.env) ? 'Checking…' : 'Environment not installed',
			},
	);
	const discrete = ggml.devices.find((device) => !device.integrated);
	const sd = sdServerBin();
	const namedTorch = torch.map((env) => ({ ...env, devices: assignTorchPdevs(env.devices, ggml.devices) }));
	return {
		cpu: { model: cpus()[0]?.model?.trim() || 'CPU', cores: cpus().length },
		ram: { totalMiB: Math.round(totalmem() / MIB), freeMiB: Math.round(freemem() / MIB) },
		llama: { bin: ggml.bin, found: fileExists(ggml.bin), backend: discrete?.backend || ggml.devices[0]?.backend, devices: ggml.devices, error: ggml.error },
		imageServer: { bin: sd, found: fileExists(sd) },
		torch: namedTorch,
		usage: gpuUsage(),
		nvidia: Boolean(onPath('nvidia-smi')),
		rocm: existsSync('/opt/rocm') || Boolean(onPath('rocminfo')),
		at: Date.now(),
	};
}

// ------------------------------------------------------------ preferences

function prefsPath() {
	return join(dataDir(), 'model-devices.json');
}

export type DevicePrefsFile = { version: 1; devices: Record<string, string>; torchVariant?: TorchVariant };
export type TorchVariant = 'auto' | 'cpu' | 'cuda' | 'rocm';

function readPrefsFile(): DevicePrefsFile {
	try {
		const parsed = JSON.parse(readFileSync(prefsPath(), 'utf8')) as DevicePrefsFile;
		return parsed && typeof parsed === 'object'
			? { version: 1, devices: parsed.devices || {}, torchVariant: parsed.torchVariant }
			: { version: 1, devices: {} };
	} catch {
		return { version: 1, devices: {} };
	}
}

export function readDevicePrefs(): Record<string, string> {
	return readPrefsFile().devices;
}

export function devicePref(key: string): string {
	return readDevicePrefs()[key] || 'auto';
}

/** Which PyTorch wheel the environment installers fetch. */
export function torchVariantPref(): TorchVariant {
	return readPrefsFile().torchVariant || 'auto';
}

const CHOICE = /^(auto|cpu|[A-Za-z]+\d+|cuda:\d+)$/;

function writePrefsFile(prefs: DevicePrefsFile) {
	mkdirSync(dataDir(), { recursive: true });
	const temp = `${prefsPath()}.tmp`;
	writeFileSync(temp, JSON.stringify({ ...prefs, version: 1 }, null, 2));
	renameSync(temp, prefsPath());
}

export function setTorchVariant(variant: TorchVariant): TorchVariant {
	const value: TorchVariant = ['auto', 'cpu', 'cuda', 'rocm'].includes(variant) ? variant : 'auto';
	writePrefsFile({ ...readPrefsFile(), torchVariant: value });
	return value;
}

export function setDevicePref(key: string, choice: string): Record<string, string> {
	const value = String(choice || '').trim();
	if (!/^[\w.:-]{1,80}$/.test(key)) throw Object.assign(new Error('Unknown model'), { status: 400 });
	if (!CHOICE.test(value)) throw Object.assign(new Error('Choose Auto, CPU or a listed device'), { status: 400 });
	const prefs = readPrefsFile();
	const next = { ...prefs.devices };
	if (value === 'auto') delete next[key];
	else next[key] = value;
	writePrefsFile({ ...prefs, devices: next });
	return next;
}

// ---------------------------------------------------------------- resolve

export type ResolveOptions = {
	/** PyTorch environment the model runs in. */
	env?: string;
	/** A device the host's environment already pins (SCAN_*_DEVICE); used for Auto. */
	legacy?: string;
};

/** Size of the weights on disk plus runtime overhead, as a VRAM estimate. */
export function estimateNeedMiB(paths: (string | undefined)[], overheadMiB = 768): number {
	let bytes = 0;
	for (const path of paths) {
		if (!path) continue;
		try {
			bytes += statSync(path).size;
		} catch {
			/* not installed yet */
		}
	}
	return Math.round((bytes * 1.1) / MIB) + overheadMiB;
}

function cpu(reason: string): ResolvedDevice {
	return { kind: 'cpu', label: 'CPU', reason };
}

/** PCI slot name when this process can see the card's address, otherwise the runtime id. */
function titled(name: string, card: string): string {
	const ggml = ggmlDevices().devices;
	const torch = TORCH_ENVIRONMENTS.flatMap((spec) => {
		const env = torchEnvironment(spec.env);
		return env ? [{ ...env, devices: assignTorchPdevs(env.devices, ggml) }] : [];
	});
	return gpuTitles({ llama: { devices: ggml }, torch }).get(name) || `${name} · ${card}`;
}

function resolveGgml(choice: string, needMiB: number, legacy?: string): ResolvedDevice {
	const { devices } = ggmlDevices();
	if (!isAutoChoice(choice)) {
		const known = devices.find((device) => device.name === choice);
		return {
			kind: 'gpu',
			runtime: 'llama',
			name: choice,
			backend: known?.backend || ggmlBackend(choice),
			label: known ? titled(known.name, known.label) : choice,
			reason: 'Chosen by hand',
		};
	}
	// A host pin only counts while that device exists: a CUDA machine must not
	// inherit this project's Vulkan numbering and launch onto nothing.
	if (legacy) {
		if (isCpuChoice(legacy)) return cpu('Pinned to CPU by the host configuration');
		const known = devices.find((device) => device.name === legacy);
		if (known)
			return { kind: 'gpu', runtime: 'llama', name: known.name, backend: known.backend, label: titled(known.name, known.label), reason: 'Host configuration' };
	}
	const discrete = devices.filter((device) => !device.integrated && device.totalMiB >= needMiB);
	if (!discrete.length)
		return cpu(devices.some((device) => !device.integrated) ? `No GPU has ${Math.ceil(needMiB / 1024)} GB` : 'No GPU found');
	const pick = [...discrete].sort((a, b) => b.freeMiB - a.freeMiB || b.totalMiB - a.totalMiB)[0];
	return {
		kind: 'gpu',
		runtime: 'llama',
		name: pick.name,
		backend: pick.backend,
		label: titled(pick.name, pick.label),
		reason: pick.freeMiB >= needMiB ? 'Most free memory' : 'Fits once other models unload',
	};
}

function resolveTorch(choice: string, needMiB: number, env: string, legacy?: string): ResolvedDevice {
	const info = torchEnvironment(env);
	const devices = info?.devices || [];
	const byIndex = (index: number, reason: string): ResolvedDevice => {
		const known = devices.find((device) => device.index === index);
		return {
			kind: 'gpu',
			runtime: 'torch',
			name: `cuda:${index}`,
			index,
			backend: known?.backend || (info?.backend === 'rocm' ? 'rocm' : 'cuda'),
			label: titled(`cuda:${index}`, known?.label || `GPU ${index}`),
			reason,
		};
	};
	const explicit = /^cuda:(\d+)$/.exec(choice);
	if (explicit) return byIndex(Number(explicit[1]), 'Chosen by hand');
	// Same guard as ggml: a pin to an index this wheel cannot see falls through.
	if (legacy && /^\d+$/.test(legacy) && devices.some((device) => device.index === Number(legacy)))
		return byIndex(Number(legacy), 'Host configuration');
	if (info && (info.backend === 'cpu' || info.backend === 'missing'))
		return cpu(info.backend === 'cpu' ? 'PyTorch here is a CPU build' : 'PyTorch is not installed');
	const discrete = devices.filter((device) => !device.integrated && device.totalMiB >= needMiB);
	if (!discrete.length) return cpu(info ? 'No PyTorch GPU has room' : 'Checking PyTorch devices');
	const pick = [...discrete].sort((a, b) => b.totalMiB - a.totalMiB || b.index - a.index)[0];
	return byIndex(pick.index, 'Largest GPU');
}

/** The device a model will actually start on, for its runtime. */
export function resolveDevice(runtime: DeviceRuntime, choice: string | undefined, needMiB: number, options: ResolveOptions = {}): ResolvedDevice {
	const value = (choice || 'auto').trim();
	if (isCpuChoice(value)) return cpu('Set to CPU');
	const mismatched = runtime === 'llama' ? /^cuda:\d+$/.test(value) : /^[A-Za-z]+\d+$/.test(value);
	const effective = mismatched ? 'auto' : value;
	return runtime === 'llama'
		? resolveGgml(effective, needMiB, options.legacy)
		: resolveTorch(effective, needMiB, options.env || 'env-review', options.legacy);
}

/** `-dev`/`-ngl` for llama-server; CPU keeps every layer off the GPU. */
export function llamaDeviceArgs(device: ResolvedDevice, gpuLayers = 999): string[] {
	return device.kind === 'gpu' ? ['-dev', device.name, '-ngl', String(gpuLayers)] : ['-dev', 'none', '-ngl', '0'];
}

/** Environment that pins a PyTorch child to one GPU, or hides every GPU for CPU. */
export function torchDeviceEnv(device: ResolvedDevice, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' };
	if (device.kind === 'cpu') return { ...next, CUDA_VISIBLE_DEVICES: '', HIP_VISIBLE_DEVICES: '' };
	const index = String(device.index ?? 0);
	if (device.backend === 'rocm') {
		next.HIP_VISIBLE_DEVICES = index;
		next.CUDA_VISIBLE_DEVICES = index;
	} else {
		next.CUDA_VISIBLE_DEVICES = index;
		delete next.HIP_VISIBLE_DEVICES;
	}
	return next;
}

/** User-facing status lines say GPU 1, not Vulkan1 or HIP 2. Launch ids are unchanged. */
export function presentGpuStatus<T extends { ocr: string; llm: string; cleaning: string }>(status: T): T {
	const titles = gpuTitles(hardwareSnapshot());
	const swap = (text: string) => text.replace(/\b(?:Vulkan|CUDA|ROCm)\d+\b|\bcuda:\d+\b|\bHIP \d+\b/g, (token) => {
		if (token.startsWith('HIP ')) return titles.get(`cuda:${token.slice(4)}`) || token;
		return titles.get(token) || token;
	});
	return { ...status, ocr: swap(status.ocr), llm: swap(status.llm), cleaning: swap(status.cleaning) };
}
