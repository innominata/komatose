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
};

export type TorchDevice = {
	/** `cuda:0` style id; PyTorch uses it for CUDA and ROCm alike. */
	name: string;
	index: number;
	label: string;
	backend: 'cuda' | 'rocm';
	totalMiB: number;
	integrated: boolean;
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

export type GpuUsage = { name: string; totalMiB: number; usedMiB: number; source: 'nvidia-smi' | 'sysfs' | 'ggml' };

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

/** Options a device picker offers for one runtime. */
export function deviceOptions(runtime: DeviceRuntime, hw: HardwareSnapshot | null, env = 'env-review') {
	const options: { value: string; label: string; detail?: string; integrated?: boolean }[] = [
		{ value: 'auto', label: 'Auto', detail: 'Best GPU that fits, else CPU' },
		{ value: 'cpu', label: 'CPU', detail: 'Never use a GPU' },
	];
	if (!hw) return options;
	if (runtime === 'llama') {
		for (const device of hw.llama.devices)
			options.push({
				value: device.name,
				label: `${device.name} · ${device.label}`,
				detail: `${BACKEND_LABEL[device.backend]} · ${formatMiB(device.totalMiB)}${device.integrated ? ' · integrated' : ''}`,
				integrated: device.integrated,
			});
	} else {
		const torch = hw.torch.find((item) => item.env === env) || hw.torch[0];
		for (const device of torch?.devices || [])
			options.push({
				value: device.name,
				label: `GPU ${device.index} · ${device.label}`,
				detail: `${BACKEND_LABEL[device.backend]} · ${formatMiB(device.totalMiB)}${device.integrated ? ' · integrated' : ''}`,
				integrated: device.integrated,
			});
	}
	return options;
}
