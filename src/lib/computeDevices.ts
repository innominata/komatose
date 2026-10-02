/**
 * Browser-safe device vocabulary shared by the hardware probe and the admin UI.
 *
 * A device choice is stored per model as one string:
 *   'auto'          pick the best GPU that fits, else CPU
 *   'cpu'           never use a GPU
 *   'Vulkan1', 'CUDA0', 'ROCm0', …   a ggml device (llama.cpp, stable-diffusion.cpp)
 *   'cuda:0', …     a PyTorch device (CUDA or ROCm builds both use this name)
 */

export type GpuBackend = 'cuda' | 'rocm' | 'vulkan' | 'metal' | 'sycl' | 'other';

/** Which process family runs a model; each enumerates devices its own way. */
export type DeviceRuntime = 'llama' | 'torch';

export type DeviceChoice = 'auto' | 'cpu' | string;

export type GgmlDevice = {
	/** ggml name passed to `-dev` / `--backend`, e.g. `Vulkan1`, `CUDA0`. */
	name: string;
	label: string;
	backend: GpuBackend;
	totalMiB: number;
	freeMiB: number;
	integrated: boolean;
	/** Canonical PCI address `0000:03:00`, shared with the PyTorch device for this card. */
	pdev?: string;
};

export type TorchDevice = {
	/** `cuda:0` style id; PyTorch uses it for CUDA and ROCm alike. */
	name: string;
	index: number;
	label: string;
	backend: 'cuda' | 'rocm';
	totalMiB: number;
	integrated: boolean;
	/** Canonical PCI address `0000:03:00`, shared with the ggml device for this card. */
	pdev?: string;
};

export type TorchEnvironment = {
	env: string;
	path: string;
	/** What the installed PyTorch wheel was built for. */
	backend: 'cuda' | 'rocm' | 'cpu' | 'missing' | 'unknown';
	version?: string;
	devices: TorchDevice[];
	error?: string;
	at: number;
};

export type GpuResident = {
	pid: number;
	label: string;
	detail?: string;
	kind: 'chat' | 'ocr' | 'edit' | 'venv' | 'other';
	vramMiB: number;
	/** System RAM this process has mapped on the GPU. Not part of the VRAM bar on a discrete card. */
	gttMiB: number;
};

export type GpuUsage = {
	name: string;
	totalMiB: number;
	usedMiB: number;
	source: 'nvidia-smi' | 'sysfs' | 'ggml' | 'nvtop';
	/** PCI address, when the snapshot came from the patched nvtop. */
	pdev?: string;
	integrated?: boolean;
	residents?: GpuResident[];
};

export type HardwareSnapshot = {
	cpu: { model: string; cores: number };
	ram: { totalMiB: number; freeMiB: number };
	llama: { bin: string; found: boolean; backend?: GpuBackend; devices: GgmlDevice[]; error?: string };
	imageServer: { bin: string; found: boolean };
	torch: TorchEnvironment[];
	usage: GpuUsage[];
	nvidia: boolean;
	rocm: boolean;
	at: number;
};

export type ResolvedDevice =
	| { kind: 'cpu'; label: string; reason: string }
	| { kind: 'gpu'; runtime: DeviceRuntime; name: string; index?: number; backend: GpuBackend; label: string; reason: string };

export const MIB = 1024 * 1024;

export function formatMiB(mib: number): string {
	if (!Number.isFinite(mib) || mib <= 0) return '—';
	const gb = mib / 1024;
	return gb >= 10 ? `${Math.round(gb)} GB` : gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(mib)} MB`;
}

// "Radeon Graphics" alone is not a signal: ROCm PyTorch names discrete RDNA cards that way.
const INTEGRATED_NAME =
	/\b(processor|igpu|apu|raphael|mendocino|phoenix|rembrandt|renoir|cezanne|lucienne|strix|hawk point|uhd|iris|vega \d+|llvmpipe|lavapipe|swiftshader)\b/i;

/** iGPUs and software rasterisers report system RAM as VRAM; never auto-pick them. */
export function looksIntegrated(name: string, totalMiB = 0): boolean {
	return INTEGRATED_NAME.test(name) || (totalMiB > 0 && totalMiB < 2048);
}

export function ggmlBackend(name: string): GpuBackend {
	const prefix = name.replace(/\d+$/, '').toLowerCase();
	if (prefix === 'vulkan') return 'vulkan';
	if (prefix === 'cuda') return 'cuda';
	if (prefix === 'rocm' || prefix === 'hip') return 'rocm';
	if (prefix === 'metal' || prefix === 'mtl') return 'metal';
	if (prefix === 'sycl') return 'sycl';
	return 'other';
}

export const BACKEND_LABEL: Record<GpuBackend | 'cpu', string> = {
	cuda: 'CUDA',
	rocm: 'ROCm',
	vulkan: 'Vulkan',
	metal: 'Metal',
	sycl: 'SYCL',
	other: 'GPU',
	cpu: 'CPU',
};

export function isCpuChoice(choice: string | undefined): boolean {
	const value = (choice || '').trim().toLowerCase();
	return value === 'cpu' || value === 'none';
}

export function isAutoChoice(choice: string | undefined): boolean {
	const value = (choice || '').trim().toLowerCase();
	return !value || value === 'auto';
}

/**
 * One card, one address. A lspci string (`0000:03:00.0`) and PyTorch's decimal
 * domain/bus/device (`bus` 3) both become `0000:03:00`.
 */
export function pciKey(value: string | { domain?: number; bus?: number; device?: number } | null | undefined): string {
	if (value == null || value === '') return '';
	if (typeof value === 'string') {
		const match = /^(?:([0-9a-f]{1,4}):)?([0-9a-f]{2}):([0-9a-f]{2})(?:\.[0-9a-f])?$/i.exec(value.trim());
		if (!match) return '';
		return `${(match[1] || '0000').padStart(4, '0').toLowerCase()}:${match[2].toLowerCase()}:${match[3].toLowerCase()}`;
	}
	const hex = (n: number, width: number) => (n >>> 0).toString(16).padStart(width, '0');
	return `${hex(value.domain ?? 0, 4)}:${hex(value.bus ?? 0, 2)}:${hex(value.device ?? 0, 2)}`;
}

/** GPU 1 is the lowest PCI address present, GPU 2 the next, including the iGPU. */
export function gpuNumbers(keys: Iterable<string>): Map<string, number> {
	const unique = [...new Set([...keys].map((key) => pciKey(key)).filter(Boolean))].sort();
	return new Map(unique.map((key, index) => [key, index + 1]));
}

/** Runtime id (`Vulkan1`, `cuda:2`) → the PCI-ordered name (`GPU 1`). */
export function gpuTitles(hw: { llama: { devices: { name: string; pdev?: string }[] }; torch: { devices: { name: string; pdev?: string }[] }[] } | null): Map<string, string> {
	const map = new Map<string, string>();
	if (!hw) return map;
	const rows: { id: string; key: string }[] = [];
	for (const device of hw.llama.devices) if (device.pdev) rows.push({ id: device.name, key: device.pdev });
	for (const env of hw.torch) for (const device of env.devices) if (device.pdev) rows.push({ id: device.name, key: device.pdev });
	const numbers = gpuNumbers(rows.map((row) => row.key));
	for (const row of rows) {
		const slot = numbers.get(pciKey(row.key));
		if (slot) map.set(row.id, `GPU ${slot}`);
	}
	return map;
}

/** Show a stored runtime id or an older "Vulkan1 · …" label as its PCI name. */
export function shownDevice(hw: Parameters<typeof gpuTitles>[0], value: string | undefined): string {
	const raw = (value || '').trim();
	if (!raw) return '';
	const titles = gpuTitles(hw);
	if (titles.has(raw)) return titles.get(raw)!;
	const token = raw.split('·')[0].trim();
	if (titles.has(token)) return titles.get(token)!;
	const named = /^GPU \d+/.exec(token);
	if (named) return named[0];
	return token;
}

/** Drop the bus number once the card has a GPU slot; it was only there to tell two 7900s apart. */
export function cardLabel(label: string): string {
	return label.replace(/,\s*bus \d+/gi, '').replace(/\s*\(\s*\)/g, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Cached PyTorch probes only mention `bus 3`. Match that to a card we already
 * know by PCI address, and pair a leftover iGPU with the leftover integrated card.
 */
export function assignTorchPdevs(devices: TorchDevice[], cards: { pdev?: string; integrated?: boolean }[]): TorchDevice[] {
	const known = cards.flatMap((card) => {
		const key = pciKey(card.pdev);
		return key ? [{ pdev: key, integrated: Boolean(card.integrated) }] : [];
	});
	const used = new Set<string>();
	const keyed = devices.map((device) => {
		const own = pciKey(device.pdev);
		if (own) {
			used.add(own);
			return { ...device, pdev: own };
		}
		const bus = /\bbus (\d+)\b/.exec(device.label);
		if (!bus) return device;
		const key = pciKey({ bus: Number(bus[1]) });
		if (!known.some((card) => card.pdev === key) || used.has(key)) return device;
		used.add(key);
		return { ...device, pdev: key };
	});
	return keyed.map((device) => {
		if (device.pdev) return device;
		const left = known.filter((card) => !used.has(card.pdev) && card.integrated === device.integrated);
		if (left.length !== 1) return device;
		used.add(left[0].pdev);
		return { ...device, pdev: left[0].pdev };
	});
}

/** Options a device picker offers for one runtime. */
export function deviceOptions(runtime: DeviceRuntime, hw: HardwareSnapshot | null, env = 'env-review') {
	const options: { value: string; label: string; detail?: string; integrated?: boolean }[] = [
		{ value: 'auto', label: 'Auto', detail: 'Best GPU that fits, else CPU' },
		{ value: 'cpu', label: 'CPU', detail: 'Never use a GPU' },
	];
	if (!hw) return options;
	const titles = gpuTitles(hw);
	const push = (device: { name: string; label: string; totalMiB: number; integrated: boolean }) => {
		options.push({
			value: device.name,
			label: titles.get(device.name) || device.name,
			detail: `${cardLabel(device.label)} · ${formatMiB(device.totalMiB)}${device.integrated ? ' · integrated' : ''}`,
			integrated: device.integrated,
		});
	};
	if (runtime === 'llama') {
		for (const device of hw.llama.devices) push(device);
	} else {
		const torch = hw.torch.find((item) => item.env === env) || hw.torch[0];
		for (const device of torch?.devices || []) push(device);
	}
	const slot = (label: string) => Number(/^GPU (\d+)$/.exec(label)?.[1] || 999);
	return [...options.slice(0, 2), ...options.slice(2).sort((a, b) => slot(a.label) - slot(b.label) || a.label.localeCompare(b.label))];
}
