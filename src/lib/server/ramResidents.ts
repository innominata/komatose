import { readdirSync, readFileSync } from 'node:fs';
import type { RamResident } from '../computeDevices';
import { describeGpuCommand, FOREIGN_MIN_MIB, foreignLabel } from '../gpuResidents';

/**
 * Who is holding system memory: Komatose's own servers and workers, any large
 * process it did not start (a model server of your own), and Other for the rest.
 */

const OWN_MIN_MIB = 256;
const TTL_MS = 5_000;

const globalStore = globalThis as typeof globalThis & { __komatoseRam?: { at: number; value: RamResident[] } };

/** PSS splits shared pages between the processes mapping them, so the lines add up. */
function pssMiB(pid: string): number {
	try {
		const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
		const pss = /^Pss:\s+(\d+) kB/m.exec(rollup);
		if (pss) return Number(pss[1]) / 1024;
	} catch {
		/* another user's process, or it just exited */
	}
	try {
		const status = readFileSync(`/proc/${pid}/status`, 'utf8');
		const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
		return rss ? Number(rss[1]) / 1024 : 0;
	} catch {
		return 0;
	}
}

function cmdline(pid: string): string {
	try {
		return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').replace(/\0/g, ' ');
	} catch {
		return '';
	}
}

export function ramResidents(): RamResident[] {
	const cached = globalStore.__komatoseRam;
	if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
	let pids: string[] = [];
	try {
		pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name));
	} catch {
		return [];
	}
	const shown: RamResident[] = [];
	let other = 0;
	for (const pid of pids) {
		const ramMiB = pssMiB(pid);
		if (ramMiB < 1) continue;
		const command = cmdline(pid);
		const info = describeGpuCommand(command);
		// The app itself is a node process under this checkout.
		const own = info.own || command.includes(process.cwd());
		// A bare interpreter name is the app or a short-lived helper, not a model.
		const bare = !info.own || /^(node|python[\d.]*|bun|tsx)$/.test(info.label);
		if (own && ramMiB >= OWN_MIN_MIB)
			shown.push({ pid: Number(pid), label: bare ? 'Komatose' : info.label, detail: bare ? info.label : info.detail, kind: bare ? 'venv' : info.kind, ramMiB: Math.round(ramMiB) });
		else if (!own && ramMiB >= FOREIGN_MIN_MIB)
			shown.push({ pid: Number(pid), label: foreignLabel(info.label), detail: info.detail, kind: 'foreign', ramMiB: Math.round(ramMiB) });
		else other += ramMiB;
	}
	shown.sort((a, b) => b.ramMiB - a.ramMiB);
	if (other >= 1) shown.push({ pid: 0, label: 'Other', kind: 'other', ramMiB: Math.round(other) });
	globalStore.__komatoseRam = { at: Date.now(), value: shown };
	return shown;
}
