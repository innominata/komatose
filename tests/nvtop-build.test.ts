import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	NVTOP_COMMIT,
	NVTOP_VERSION,
	detectPackageManager,
	installCommands,
	needsBuildPackages,
	packagesFor,
	privilegePrefix,
	upgradedPackages,
	type ToolProbe,
} from '../src/lib/server/nvtopBuild';

const has = (...names: string[]) => (name: string) => names.includes(name);

test('the package manager is the first one this machine actually has', () => {
	assert.equal(detectPackageManager(has('apt-get', 'pacman'))?.id, 'apt');
	assert.equal(detectPackageManager(has('dnf5'))?.bin, 'dnf5');
	assert.equal(detectPackageManager(has('xbps-install'))?.id, 'xbps');
	assert.equal(detectPackageManager(has('curl')), null);
});

test('each package manager installs a compiler, cmake, and the nvtop libraries', () => {
	assert.ok(packagesFor('dnf').includes('ncurses-devel'));
	assert.ok(packagesFor('dnf').includes('systemd-devel'));
	assert.ok(packagesFor('apt').includes('libncurses-dev'));
	assert.ok(packagesFor('apt').includes('libudev-dev'));
	assert.ok(packagesFor('pacman').includes('libdrm'));
	assert.ok(packagesFor('zypper').includes('libdrm-devel'));
	assert.ok(packagesFor('apk').includes('eudev-dev'));
	assert.ok(packagesFor('xbps').includes('eudev-libudev-devel'));

	const apt = installCommands({ id: 'apt', bin: 'apt-get' });
	assert.deepEqual(apt[0], ['apt-get', 'update']);
	assert.equal(apt[1][0], 'apt-get');
	assert.ok(apt[1].includes('libdrm-dev'));

	const dnf = installCommands({ id: 'dnf', bin: 'dnf5' });
	assert.equal(dnf.length, 1);
	assert.equal(dnf[0][0], 'dnf5');
	assert.ok(dnf[0].includes('--setopt=skip_if_unavailable=true'));
	assert.ok(dnf[0].includes('-y'));
});

test('a header install that would upgrade existing packages is named, not applied', () => {
	const dnf = `Upgrading:
 systemd                           x86_64 259.9-1.fc44 nobara-updates  12.8 MiB
   replacing systemd               x86_64 258.7-1.fc43 nobara          12.7 MiB
 systemd-libs                      x86_64 259.9-1.fc44 nobara-updates   2.4 MiB
   replacing systemd-libs          x86_64 258.7-1.fc43 nobara           2.3 MiB
Installing:
 systemd-devel                     x86_64 259.9-1.fc44 nobara-updates 613.7 KiB
Transaction Summary:`;
	assert.deepEqual(upgradedPackages(dnf), ['systemd', 'systemd-libs']);
	assert.deepEqual(upgradedPackages('Installing:\n cmake\nTransaction Summary:'), []);
	assert.deepEqual(
		upgradedPackages('The following packages will be upgraded:\n  libsystemd0 systemd\nThe following NEW packages will be installed:\n  libudev-dev\n'),
		['libsystemd0', 'systemd'],
	);
});

test('package installs escalate with sudo or doas, and stay direct for root', () => {
	assert.deepEqual(privilegePrefix({ root: true, sudo: true, doas: true }), []);
	assert.deepEqual(privilegePrefix({ root: false, sudo: true, doas: true }), ['sudo', '-n']);
	assert.deepEqual(privilegePrefix({ root: false, sudo: false, doas: true }), ['doas', '-n']);
	assert.equal(privilegePrefix({ root: false, sudo: false, doas: false }), null);
});

test('build packages are skipped once the compiler and libraries are present', () => {
	const ready: ToolProbe = {
		command: () => true,
		pkgConfig: () => true,
	};
	assert.equal(needsBuildPackages(ready), false);
	assert.equal(needsBuildPackages({ ...ready, command: (name) => name !== 'cmake' }), true);
	assert.equal(needsBuildPackages({ ...ready, pkgConfig: (modules) => !modules.includes('libdrm') }), true);
	assert.equal(needsBuildPackages({ command: (name) => name !== 'g++', pkgConfig: () => true }), false);
	assert.equal(needsBuildPackages({ command: (name) => name !== 'g++' && name !== 'c++', pkgConfig: () => true }), true);
});

test('snapshots use the nvtop this install built, unless SCAN_NVTOP points at a file', async () => {
	const { nvtopBin } = await import('../src/lib/server/nvtopSnapshot');
	const { ownedNvtopPath } = await import('../src/lib/server/nvtopBuild');
	const dir = mkdtempSync(join(tmpdir(), 'nvtop-build-'));
	const previousData = process.env.SCAN_DATA_DIR;
	const previousOverride = process.env.SCAN_NVTOP;
	process.env.SCAN_DATA_DIR = dir;
	delete process.env.SCAN_NVTOP;
	try {
		assert.equal(nvtopBin(), undefined);
		const bin = ownedNvtopPath();
		mkdirSync(join(bin, '..'), { recursive: true });
		writeFileSync(bin, '');
		assert.equal(nvtopBin(), undefined);
		writeFileSync(join(dir, 'tools/nvtop/installed.json'), JSON.stringify({ version: NVTOP_VERSION, commit: NVTOP_COMMIT, patched: true }));
		assert.equal(nvtopBin(), bin);
		const custom = join(dir, 'custom-nvtop');
		writeFileSync(custom, '');
		process.env.SCAN_NVTOP = custom;
		assert.equal(nvtopBin(), custom);
		process.env.SCAN_NVTOP = join(dir, 'missing');
		assert.equal(nvtopBin(), bin);
	} finally {
		if (previousData === undefined) delete process.env.SCAN_DATA_DIR;
		else process.env.SCAN_DATA_DIR = previousData;
		if (previousOverride === undefined) delete process.env.SCAN_NVTOP;
		else process.env.SCAN_NVTOP = previousOverride;
		rmSync(dir, { recursive: true, force: true });
	}
});
