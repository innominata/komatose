import { formatMiB, MIB, type GpuResident } from './computeDevices';

/** Ignore footprints smaller than this. A few megabytes is a driver handshake, not a loaded model. */
const MIN_MIB = 128;

export type GpuCommandInfo = {
	label: string;
	detail?: string;
	kind: GpuResident['kind'];
	/** One of our servers or virtualenvs, as opposed to the desktop. */
	own: boolean;
};

const SCRIPT_LABELS: Record<string, string> = {
	'hayai_review.py': 'Hayai OCR',
	'manga_ocr_review.py': 'Manga OCR',
	'workflow.py': 'Cleaning worker',
	'worker.py': 'OCR worker',
};

function arg(cmdline: string, flags: string[]): string | undefined {
	const parts = cmdline.split(/\s+/);
	for (let i = 0; i < parts.length - 1; i++) if (flags.includes(parts[i])) return parts[i + 1];
	return undefined;
}

/**
 * A short name for a process. The command line is never returned: it carries API keys.
 */
export function describeGpuCommand(cmdline: string): GpuCommandInfo {
	const venv = cmdline.match(/\.venv-([A-Za-z0-9_-]+)/);
	if (venv) {
		const script = cmdline.match(/\/([A-Za-z0-9_.-]+\.py)\b/)?.[1];
		const friendly = script ? SCRIPT_LABELS[script] || script.replace(/\.py$/, '').replace(/_/g, ' ') : '';
		return { label: friendly || `.venv-${venv[1]}`, detail: `.venv-${venv[1]}`, kind: 'venv', own: true };
	}
	if (/(^|\/)sd-server(\s|$)/.test(cmdline)) {
		return { label: /qwen-image-edit/i.test(cmdline) ? 'Qwen-Image-Edit' : 'Image editor', kind: 'edit', own: true };
	}
	if (/(^|\/)llama-server(\s|$)/.test(cmdline)) {
		const alias = arg(cmdline, ['-a', '--alias']);
		const model = arg(cmdline, ['-m', '--model']);
		const file = model?.split('/').pop()?.replace(/\.gguf$/i, '');
		return { label: alias || file || 'llama-server', kind: 'chat', own: true };
	}
	const exe = cmdline.split(/\s+/)[0]?.split('/').pop() || 'process';
	const own = /komatose|stable-diffusion\.cpp|llama\.cpp/.test(cmdline);
	return { label: exe, kind: own ? 'chat' : 'other', own };
}

export type GpuProcessSample = { pid: number; cmdline: string; vramBytes: number; gttBytes: number };

/** One line per Komatose process that is actually holding memory, plus a single Other line. */
export function collectResidents(processes: GpuProcessSample[]): GpuResident[] {
	const shown: GpuResident[] = [];
	let otherVram = 0;
	let otherGtt = 0;
	for (const proc of processes) {
		const info = describeGpuCommand(proc.cmdline || '');
		const vramMiB = Math.round((proc.vramBytes || 0) / MIB);
		const gttMiB = Math.round((proc.gttBytes || 0) / MIB);
		if (info.own && (vramMiB >= MIN_MIB || gttMiB >= MIN_MIB))
			shown.push({ pid: proc.pid, label: info.label, detail: info.detail, kind: info.kind, vramMiB, gttMiB });
		else {
			otherVram += vramMiB;
			otherGtt += gttMiB;
		}
	}
	if (otherVram >= MIN_MIB || otherGtt >= MIN_MIB)
		shown.push({ pid: 0, label: 'Other', kind: 'other', vramMiB: otherVram, gttMiB: otherGtt });
	shown.sort((a, b) => b.vramMiB + b.gttMiB - (a.vramMiB + a.gttMiB));
	return shown;
}

export type KnownProcess = { pid: number; label: string; kind: GpuResident['kind'] };

/** Prefer the service's display name when we already know which pid it is. */
export function nameResidents(residents: GpuResident[], known: KnownProcess[]): GpuResident[] {
	return residents.map((resident) => {
		if (!resident.pid) return resident;
		const matches = known.filter((item) => item.pid === resident.pid);
		if (!matches.length) return resident;
		const labels = new Set(matches.map((item) => item.label));
		return {
			...resident,
			label: labels.size === 1 ? matches[0].label : 'Qwen-Image-Edit',
			kind: resident.kind === 'venv' ? 'venv' : matches[0].kind,
		};
	});
}

/** Right-hand side of a card line. GTT is system RAM the GPU is holding, not VRAM. */
export function formatResidentMemory(resident: { vramMiB?: number; gttMiB?: number }): string {
	const bits: string[] = [];
	if ((resident.vramMiB || 0) >= MIN_MIB) bits.push(formatMiB(resident.vramMiB!));
	if ((resident.gttMiB || 0) >= MIN_MIB) bits.push(`${formatMiB(resident.gttMiB!)} system`);
	return bits.join(' · ');
}
