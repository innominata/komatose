import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import type { NvtopStatus } from '../nvtopStatus';
import { ROOT } from './paths';

/**
 * Komatose builds its own nvtop under data/tools/nvtop and runs that binary
 * by path. A distro nvtop on PATH is never consulted.
 *
 * The patch matches commit ed4a572, which still reports itself as 3.3.2.
 * The 3.3.2 release tag is an older tree and rejects the patch, so the
 * tarball and its checksum are pinned to that commit.
 */
export const NVTOP_VERSION = '3.3.2';
export const NVTOP_COMMIT = 'ed4a572ea7a2eeb8ab16e7ef94ff87dbf3785969';
export const NVTOP_SHA256 = '45891345d5e6dbb98a2d0270070e6b28d2d7d517d1f2f34191b5df4d34a42993';
const NVTOP_URL = `https://github.com/Syllo/nvtop/archive/${NVTOP_COMMIT}.tar.gz`;

export type PackageManagerId = 'dnf' | 'apt' | 'pacman' | 'zypper' | 'apk' | 'xbps';

export type PackageManager = { id: PackageManagerId; bin: string };

const PACKAGES: Record<PackageManagerId, string[]> = {
	dnf: ['cmake', 'gcc', 'gcc-c++', 'make', 'pkgconf-pkg-config', 'patch', 'ncurses-devel', 'libdrm-devel', 'systemd-devel'],
	apt: ['cmake', 'g++', 'make', 'pkg-config', 'patch', 'libncurses-dev', 'libdrm-dev', 'libudev-dev'],
	pacman: ['cmake', 'gcc', 'make', 'pkgconf', 'patch', 'ncurses', 'libdrm', 'systemd'],
	zypper: ['cmake', 'gcc-c++', 'make', 'pkg-config', 'patch', 'ncurses-devel', 'libdrm-devel', 'systemd-devel'],
	apk: ['cmake', 'g++', 'make', 'pkgconf', 'patch', 'ncurses-dev', 'libdrm-dev', 'eudev-dev'],
	xbps: ['cmake', 'gcc', 'make', 'pkg-config', 'patch', 'ncurses-devel', 'libdrm-devel', 'eudev-libudev-devel'],
};

export type ToolProbe = {
	command(name: string): boolean;
	/** True when any one of the pkg-config modules is installed. */
	pkgConfig(modules: string[]): boolean;
};

export function nvtopToolDir(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'tools', 'nvtop');
}

export function ownedNvtopPath(): string {
	return join(nvtopToolDir(), 'bin', 'nvtop');
}

function markerPath(): string {
	return join(nvtopToolDir(), 'installed.json');
}

export function ownedNvtopReady(): boolean {
	if (!existsSync(ownedNvtopPath())) return false;
	try {
		const marker = JSON.parse(readFileSync(markerPath(), 'utf8')) as { version?: string; patched?: boolean };
		return marker.version === NVTOP_VERSION && marker.commit === NVTOP_COMMIT && marker.patched === true;
	} catch {
		return false;
	}
}

/** First supported package manager, in the order a desktop Linux install usually has one. */
export function detectPackageManager(has: (name: string) => boolean): PackageManager | null {
	const found: [string, PackageManager][] = [
		['dnf', { id: 'dnf', bin: 'dnf' }],
		['dnf5', { id: 'dnf', bin: 'dnf5' }],
		['apt-get', { id: 'apt', bin: 'apt-get' }],
		['pacman', { id: 'pacman', bin: 'pacman' }],
		['zypper', { id: 'zypper', bin: 'zypper' }],
		['apk', { id: 'apk', bin: 'apk' }],
		['xbps-install', { id: 'xbps', bin: 'xbps-install' }],
	];
	return found.find(([name]) => has(name))?.[1] ?? null;
}

export function packagesFor(id: PackageManagerId): string[] {
	return [...PACKAGES[id]];
}

/**
 * Package names a dry-run says would be upgraded. Installing nvtop's headers must
 * not quietly move systemd or anything else already on the machine.
 */
export function upgradedPackages(text: string): string[] {
	const dnf = text.match(/^Upgrading:\n([\s\S]*?)(?:\n[A-Z][A-Za-z ]+:|\nTransaction Summary:)/m);
	if (dnf) {
		const names = new Set<string>();
		for (const line of dnf[1].split('\n')) {
			const name = /^\s*(?!replacing\b)(\S+)/.exec(line)?.[1];
			if (name) names.add(name);
		}
		return [...names];
	}
	const apt = text.match(/The following packages will be upgraded:\n([\s\S]*?)\n(?:The following|Inst |Conf |\d+ upgraded)/);
	if (!apt) return [];
	return apt[1].split(/\s+/).map((name) => name.trim()).filter(Boolean);
}

/** Commands that install the build dependencies. apt and pacman refresh their index first. */
export function installCommands(manager: PackageManager): string[][] {
	const pkgs = packagesFor(manager.id);
	switch (manager.id) {
		case 'dnf':
			return [[manager.bin, '--setopt=skip_if_unavailable=true', 'install', '-y', ...pkgs]];
		case 'apt':
			return [[manager.bin, 'update'], [manager.bin, 'install', '-y', ...pkgs]];
		case 'pacman':
			return [[manager.bin, '-Sy', '--noconfirm'], [manager.bin, '-S', '--noconfirm', '--needed', ...pkgs]];
		case 'zypper':
			return [[manager.bin, '--non-interactive', 'install', ...pkgs]];
		case 'apk':
			return [[manager.bin, 'add', ...pkgs]];
		case 'xbps':
			return [[manager.bin, '-Sy', ...pkgs]];
	}
}

export function privilegePrefix(opts: { root: boolean; sudo: boolean; doas: boolean }): string[] | null {
	if (opts.root) return [];
	if (opts.sudo) return ['sudo', '-n'];
	if (opts.doas) return ['doas', '-n'];
	return null;
}

/** True when a compiler, cmake, and the libraries nvtop's AMD/Intel/NVIDIA build needs are missing. */
export function needsBuildPackages(probe: ToolProbe): boolean {
	const compiler = probe.command('g++') || probe.command('c++');
	const curses = probe.pkgConfig(['ncursesw', 'ncurses']);
	const device = probe.pkgConfig(['libsystemd', 'libudev']);
	return !(
		probe.command('cmake') &&
		probe.command('make') &&
		probe.command('pkg-config') &&
		probe.command('patch') &&
		compiler &&
		probe.pkgConfig(['libdrm']) &&
		curses &&
		device
	);
}

const job: { state: 'idle' | 'running' | 'failed'; lines: string[]; error: string } = {
	state: 'idle',
	lines: [],
	error: '',
};

function log(line: string) {
	const text = line.replace(/\s+$/, '');
	if (!text) return;
	job.lines.push(text);
	if (job.lines.length > 200) job.lines.splice(0, job.lines.length - 200);
}

export function nvtopStatus(): NvtopStatus {
	const configured = (process.env.SCAN_NVTOP || '').trim();
	const override = Boolean(configured && existsSync(configured));
	const ready = ownedNvtopReady();
	const state = job.state === 'running' ? 'running' : job.state === 'failed' ? 'failed' : ready ? 'ready' : 'missing';
	return {
		state,
		ready,
		override,
		path: override ? configured : ready ? ownedNvtopPath() : '',
		error: job.state === 'failed' ? job.error : '',
		lines: job.lines.slice(-40),
		version: NVTOP_VERSION,
	};
}

/** Starts a build unless one is already running. Returns immediately. */
export function startNvtopBuild(): NvtopStatus {
	if (job.state === 'running') return nvtopStatus();
	job.state = 'running';
	job.lines = [];
	job.error = '';
	void runBuild().then(
		() => {
			job.state = 'idle';
		},
		(error: unknown) => {
			job.state = 'failed';
			job.error = error instanceof Error ? error.message : String(error);
			log(job.error);
		},
	);
	return nvtopStatus();
}

function systemProbe(): ToolProbe {
	return {
		command(name) {
			const result = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
			return result.status === 0 && Boolean(result.stdout.trim());
		},
		pkgConfig(modules) {
			return modules.some((name) => spawnSync('pkg-config', ['--exists', name]).status === 0);
		},
	};
}

function canEscalate(): { root: boolean; sudo: boolean; doas: boolean } {
	const root = typeof process.getuid === 'function' && process.getuid() === 0;
	const sudo = spawnSync('sudo', ['-n', 'true'], { encoding: 'utf8' }).status === 0;
	const doas = spawnSync('doas', ['-n', 'true'], { encoding: 'utf8' }).status === 0;
	return { root, sudo, doas };
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
	return capture(cmd, args, cwd).then((result) => {
		if (result.code !== 0) throw new Error(`${cmd} exited ${result.code ?? 'unknown'}`);
	});
}

function capture(cmd: string, args: string[], cwd?: string): Promise<{ code: number | null; text: string }> {
	return new Promise((resolve, reject) => {
		log(`$ ${cmd} ${args.join(' ')}`);
		const child = spawn(cmd, args, { cwd, env: process.env });
		let text = '';
		const take = (buf: Buffer) => {
			text += buf.toString();
			for (const line of buf.toString().split('\n')) log(line);
		};
		child.stdout?.on('data', take);
		child.stderr?.on('data', take);
		child.on('error', (error) => reject(error));
		child.on('close', (code) => resolve({ code, text }));
	});
}

async function installPackages() {
	if (!needsBuildPackages(systemProbe())) {
		log('Build tools are already installed.');
		return;
	}
	const manager = detectPackageManager((name) => systemProbe().command(name));
	if (!manager) {
		throw new Error(
			'No supported package manager found (dnf, apt, pacman, zypper, apk, or xbps). Install a C++ compiler, CMake, make, pkg-config, patch, and the ncurses, libdrm, and libudev development packages, then press Build nvtop again.',
		);
	}
	const prefix = privilegePrefix(canEscalate());
	const commands = installCommands(manager);
	const shown = commands.map((argv) => `sudo ${argv.join(' ')}`).join(' && ');
	if (!prefix) {
		throw new Error(`Installing build packages needs administrator permission. Run this, then press Build nvtop again:\n${shown}`);
	}
	const upgrades = await previewUpgrades(manager, prefix);
	if (upgrades.length) {
		throw new Error(
			`Installing the nvtop build headers would also upgrade ${upgrades.join(', ')}. Komatose leaves installed packages alone. Run this if those updates are acceptable, then press Build nvtop again:\n${shown}`,
		);
	}
	log(`Installing build packages with ${manager.bin}.`);
	try {
		for (const argv of commands) await run(prefix.length ? prefix[0] : argv[0], prefix.length ? [...prefix.slice(1), ...argv] : argv.slice(1));
	} catch (error) {
		const detail = `${error instanceof Error ? error.message : String(error)}\n${job.lines.slice(-15).join('\n')}`;
		if (/password is required|a terminal is required|not permitted|not allowed|Authentication/i.test(detail)) {
			const shown = commands.map((argv) => `sudo ${argv.join(' ')}`).join(' && ');
			throw new Error(`Installing build packages needs administrator permission. Run this, then press Build nvtop again:\n${shown}`);
		}
		throw new Error(`Could not install build packages with ${manager.bin}. ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function previewUpgrades(manager: PackageManager, prefix: string[]): Promise<string[]> {
	if (manager.id !== 'dnf' && manager.id !== 'apt') return [];
	const pkgs = packagesFor(manager.id);
	const argv = manager.id === 'dnf'
		? [manager.bin, '--setopt=skip_if_unavailable=true', 'install', '-y', '--assumeno', ...pkgs]
		: [manager.bin, 'install', '-s', '-y', ...pkgs];
	const cmd = prefix.length ? prefix[0] : argv[0];
	const args = prefix.length ? [...prefix.slice(1), ...argv] : argv.slice(1);
	log('Checking whether the headers can be installed without upgrading packages.');
	const result = await capture(cmd, args);
	const upgrades = upgradedPackages(result.text);
	if (upgrades.length) return upgrades;
	// dnf --assumeno exits 1 after a successful preview. Any other failure is real.
	if (result.code !== 0 && !/Operation aborted|abort/i.test(result.text)) {
		throw new Error(`Could not check build packages with ${manager.bin} (exit ${result.code ?? 'unknown'}).`);
	}
	return [];
}

async function downloadArchive(dest: string) {
	if (existsSync(dest)) {
		const have = createHash('sha256').update(readFileSync(dest)).digest('hex');
		if (have === NVTOP_SHA256) return;
		log('Cached nvtop tarball did not match the pinned checksum. Downloading it again.');
	}
	log(`Downloading nvtop ${NVTOP_VERSION} (${NVTOP_COMMIT.slice(0, 7)}).`);
	const response = await fetch(NVTOP_URL);
	if (!response.ok) throw new Error(`Could not download nvtop ${NVTOP_VERSION} (HTTP ${response.status}).`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const hash = createHash('sha256').update(bytes).digest('hex');
	if (hash !== NVTOP_SHA256) throw new Error(`nvtop ${NVTOP_VERSION} download did not match the expected checksum.`);
	mkdirSync(dirname(dest), { recursive: true });
	writeFileSync(dest, bytes);
}

function patchFile(): string {
	return join(ROOT, 'scripts', 'patches', 'nvtop-snapshot-pdev-gtt.patch');
}

async function buildTree() {
	const root = nvtopToolDir();
	const src = join(root, 'src');
	const build = join(root, 'build');
	const archive = join(root, 'cache', `nvtop-${NVTOP_COMMIT}.tar.gz`);
	mkdirSync(join(root, 'cache'), { recursive: true });
	await downloadArchive(archive);
	rmSync(src, { recursive: true, force: true });
	rmSync(build, { recursive: true, force: true });
	mkdirSync(src, { recursive: true });
	log('Unpacking nvtop and applying the snapshot patch.');
	await run('tar', ['-xzf', archive, '-C', src, '--strip-components=1']);
	await run('patch', ['-p1', '--forward', '--batch', `--input=${patchFile()}`], src);
	const jobs = String(Math.max(1, availableParallelism()));
	log('Configuring the build for AMD, Intel, and NVIDIA.');
	await run('cmake', [
		'-S', src,
		'-B', build,
		`-DCMAKE_INSTALL_PREFIX=${root}`,
		'-DCMAKE_BUILD_TYPE=Release',
		'-DNVIDIA_SUPPORT=ON',
		'-DAMDGPU_SUPPORT=ON',
		'-DINTEL_SUPPORT=ON',
		'-DMSM_SUPPORT=OFF',
		'-DPANFROST_SUPPORT=OFF',
		'-DPANTHOR_SUPPORT=OFF',
		'-DASCEND_SUPPORT=OFF',
		'-DV3D_SUPPORT=OFF',
		'-DTPU_SUPPORT=OFF',
		'-DROCKCHIP_SUPPORT=OFF',
		'-DMETAX_SUPPORT=OFF',
		'-DENFLAME_SUPPORT=OFF',
		'-DAPPLE_SUPPORT=OFF',
	]);
	await run('cmake', ['--build', build, '--parallel', jobs]);
	await run('cmake', ['--install', build]);
}

function acceptBinary(bin: string) {
	rmSync(markerPath(), { force: true });
	const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 8_000 });
	if (version.status !== 0 || !String(version.stdout || '').includes(NVTOP_VERSION)) {
		throw new Error(`The built nvtop did not report version ${NVTOP_VERSION}.`);
	}
	const snap = spawnSync(bin, ['-s', '-C'], { encoding: 'utf8', timeout: 8_000 });
	if (snap.status !== 0) throw new Error('The built nvtop could not take a snapshot.');
	const text = String(snap.stdout || '');
	if (text.includes('"device_name"') && !text.includes('"pdev"')) {
		throw new Error('The built nvtop snapshot has no PCI address. The patch did not apply.');
	}
	writeFileSync(markerPath(), JSON.stringify({ version: NVTOP_VERSION, commit: NVTOP_COMMIT, patched: true, at: new Date().toISOString() }));
	log(`Installed ${bin}`);
}

async function runBuild() {
	log(`Building nvtop ${NVTOP_VERSION} into ${nvtopToolDir()}.`);
	await installPackages();
	await buildTree();
	const bin = ownedNvtopPath();
	if (!existsSync(bin)) throw new Error('The build finished without producing bin/nvtop.');
	acceptBinary(bin);
}
