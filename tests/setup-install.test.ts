import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	INSTALL_GROUPS,
	INSTALL_TARGETS,
	formatDisk,
	installTarget,
	installTargetsForGroup,
} from '../src/lib/installCatalog';
import { CHAT_AND_CLI_OPERATIONS, type ModelRow } from '../src/lib/modelRegistry';

// Isolate before modelInstall → paths snapshots SCAN_ROOT/HOME at load.
const root = await mkdtemp(join(tmpdir(), 'scan-install-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
process.env.HOME = join(root, 'home');
delete process.env.PADDLEOCR_PYTHON;
delete process.env.SCAN_REVIEW_PYTHON;
delete process.env.SCAN_WORKFLOW_PYTHON;
delete process.env.SCAN_TRANSLATION_PYTHON;
delete process.env.SCAN_REVIEW_MODELS_DIR;
delete process.env.SCAN_TRANSLATION_MODELS_DIR;
delete process.env.SCAN_IMAGE_MODELS_DIR;
delete process.env.SCAN_LLM_MODELS_DIR;
delete process.env.SCAN_COO_MODEL;
delete process.env.SCAN_KOHARU_DIR;
delete process.env.SCAN_KOHARU_WEIGHTS;
delete process.env.SCAN_KOHARU_HISAM_ROOT;
delete process.env.HF_HOME;
await mkdir(join(root, 'data'), { recursive: true });
await mkdir(join(root, 'home'), { recursive: true });

const {
	environmentInstalled,
	ensureInstalledModelRows,
	installCommand,
	installStatus,
	listInstallStatuses,
	startInstall,
	targetInstalled,
	uninstallPlan,
	uninstallTarget,
} = await import('../src/lib/server/modelInstall');

const ENV_IDS = ['env-ocr', 'env-review', 'env-workflow'];

after(() => {
	// Temp dirs are left for the OS cleaner; jobs never started here.
});

test('catalog ids are unique, grouped, and sized for decisions', () => {
	const ids = INSTALL_TARGETS.map((target) => target.id);
	assert.equal(new Set(ids).size, ids.length, 'duplicate install target id');
	const groupIds = new Set<string>(INSTALL_GROUPS.map((group) => group.id));
	for (const target of INSTALL_TARGETS) {
		assert.ok(groupIds.has(target.group), `${target.id} has unknown group ${target.group}`);
		assert.ok(target.label.length > 0, `${target.id} needs a label`);
		assert.ok(target.summary.length > 0, `${target.id} needs a summary`);
		assert.ok(target.diskBytes > 0, `${target.id} needs a disk size`);
		assert.ok(target.memoryBytes >= 0, `${target.id} memory cannot be negative`);
		for (const dep of target.requires || []) assert.ok(ENV_IDS.includes(dep), `${target.id} requires ${dep}`);
	}
	// The models Komatose ships configs for must all be listed.
	for (const id of [
		'qwen3.8-27b',
		'rtdetr',
		'ctd',
		'koharu',
		'coo',
		'hayai-ocr-v2',
		'manga-ocr',
		'paddleocr-vl-1.6',
		'qwen3-vl-8b',
		'cat-translate-7b-q4',
		'hy-mt2-manga-v5',
		'hy-mt2-7b-q4',
		'imsbee-ko-en-translator',
		'opus-mt-ja-en',
		'shisa-v2.1-qwen3-8b-q4',
		'sugoi-v4-ja-en',
		'translategemma-4b-q4',
		'translategemma-12b-q4',
		'qwen-image-2.1',
		'qwen-image-edit-2511',
		'big-lama',
		'aot',
		'lama-manga',
	]) {
		assert.ok(installTarget(id), `${id} missing from the install catalog`);
	}
	for (const group of INSTALL_GROUPS) {
		assert.ok(installTargetsForGroup(group.id).length > 0, `${group.id} group is empty`);
	}
	assert.equal(formatDisk(0), '—');
	assert.match(formatDisk(172_000_000), /MB$/);
	assert.match(formatDisk(13_051_163_488), /GB$/);
});

test('every command is a whitelisted script with fixed arguments', () => {
	for (const target of INSTALL_TARGETS) {
		const { command, bin, args } = installCommand(target);
		assert.ok(args[0]?.startsWith('scripts/'), `${target.id} must run a repo script: ${args[0]}`);
		assert.match(bin, /^(python3|\/)/, `${target.id} interpreter must be python3 or an absolute path`);
		for (const arg of args) assert.match(arg, /^[\w./:@=-]+$/, `${target.id} argument ${arg}`);
		// Display form is the same fixed parts joined for copy-paste.
		assert.ok(command.includes(args[0]), `${target.id} command display mismatch`);
	}
	assert.ok(installCommand(installTarget('qwen3.8-27b')!).command.includes('install-llm-model.py'));
	assert.ok(
		installCommand(installTarget('qwen-image-edit-2511')!).command.includes('install-image-edit-model.py'),
	);
	assert.ok(
		installCommand(installTarget('rtdetr')!).command.includes('install-detect-models.py --model rtdetr'),
	);
	assert.ok(
		installCommand(installTarget('big-lama')!).command.includes('install-clean-models.py --model big-lama'),
	);
	const shisa = installTarget('shisa-v2.1-qwen3-8b-q4')!;
	assert.match(shisa.summary, /Qwen3/);
	assert.equal(shisa.diskBytes, 5_027_784_736);
	assert.equal(installTarget('shisa-v2-llama3.1-8b-q4'), undefined);
});

test('Sugoi installer uses uv pip because uv venvs have no pip module', () => {
	const src = readFileSync(fileURLToPath(new URL('../scripts/install-translation-models.py', import.meta.url)), 'utf8');
	assert.match(src, /shutil\.which\('uv'\)/);
	assert.match(src, /\[uv, 'pip', 'install'/);
	assert.match(src, /ensurepip/);
	assert.match(src, /sentencepiece==0\.2\.1/);
	assert.match(src, /ensure_sugoi_deps/);
});

test('unknown ids never reach spawn', () => {
	assert.throws(() => installCommand({ ...(installTarget('rtdetr')!), id: 'x; rm -rf ~' }), /No installer/);
	const attempts = ['rtdetr; reboot', '../../scripts/install-koharu.py', 'rtdetr --force all', ''];
	for (const attempt of attempts) {
		assert.throws(() => startInstall(attempt), (e: Error & { status?: number }) => e.status === 404);
	}
});

test('fresh machine: nothing installed, environment requirements block dependent installs', () => {
	assert.equal(environmentInstalled('env-ocr'), false);
	assert.equal(environmentInstalled('env-review'), false);
	assert.equal(environmentInstalled('env-workflow'), false);

	const env = listInstallStatuses().filter((item) => item.id.startsWith('env-'));
	assert.equal(env.length, 3);
	for (const item of env) {
		assert.equal(item.installed, false, `${item.id} should be missing on a fresh root`);
		assert.equal(item.blocked, false, `${item.id} cannot be blocked by itself`);
	}

	// Dependent installs refuse until their environment exists, and say why.
	const detect = installStatus(installTarget('rtdetr')!);
	assert.equal(detect.installed, false);
	assert.equal(detect.blocked, true);
	assert.match(detect.blocker || '', /\.venv-ocr/);

	const review = installStatus(installTarget('qwen3-vl-8b')!);
	assert.equal(review.blocked, true);
	assert.match(review.blocker || '', /\.venv-review/);

	// No prerequisites: always allowed, and the command is a plain python script.
	const chat = installStatus(installTarget('qwen3.8-27b')!);
	assert.equal(chat.blocked, false);
	assert.ok(chat.command.includes('scripts/install-llm-model.py'));
	const translation = installStatus(installTarget('hy-mt2-manga-v5')!);
	assert.equal(translation.blocked, false);

	// Weights checks read an empty HOME/cache, so everything reports missing.
	for (const item of listInstallStatuses()) {
		assert.ok(item.command.includes('scripts/'), `${item.id} has no command`);
		if (!item.id.startsWith('env-')) assert.equal(item.installed, false, `${item.id} unexpectedly installed`);
	}
});

test('targetInstalled resolves ids by kind without touching the network', () => {
	for (const target of INSTALL_TARGETS) {
		const state = targetInstalled(target);
		assert.equal(typeof state.installed, 'boolean');
		if (!state.installed) assert.ok(state.detail, `${target.id} should explain why it is missing`);
	}
});

test('uninstall plans name the files each installer wrote, and never a dangerous path', () => {
	const forbidden = new Set(['', '/', root, join(root, 'data'), join(root, 'home')]);
	for (const target of INSTALL_TARGETS) {
		const plan = uninstallPlan(target.id);
		assert.equal(plan.id, target.id);
		assert.ok(plan.paths.length > 0, `${target.id} has nothing to delete`);
		for (const item of plan.paths) {
			assert.ok(item.path.startsWith('/'), `${target.id} path is not absolute`);
			assert.ok(!forbidden.has(item.path.replace(/\/+$/, '')), `${target.id} would delete ${item.path}`);
			assert.ok(item.note.length > 0, `${target.id} path needs a note`);
		}
		assert.equal(plan.blocked, undefined, `${target.id} unexpectedly blocked`);
	}
	assert.ok(uninstallPlan('rtdetr').paths[0].path.includes('models--ogkalu--comic-text-and-bubble-detector'));
	assert.ok(uninstallPlan('env-review').paths[0].path.endsWith('.venv-review'));
	assert.ok(uninstallPlan('hayai-ocr-v2').paths.some((item) => item.kind === 'marker'));
	assert.ok(uninstallPlan('qwen3-vl-8b').paths.some((item) => item.path.includes('models/review/qwen3-vl-8b')));
	assert.ok(uninstallPlan('qwen-image-2.1').paths[0].path.includes('models/image'));
});

test('uninstalling an environment waits for the models that run in it', async () => {
	const dir = join(root, 'data/models/review/hayai-ocr-v2');
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, 'model.safetensors'), 'x');
	await writeFile(join(root, 'data/models/review/installed.json'), JSON.stringify({ 'hayai-ocr-v2': true }));
	assert.equal(targetInstalled(installTarget('hayai-ocr-v2')!).installed, true);

	const blocked = uninstallPlan('env-review');
	assert.match(blocked.blocked || '', /Hayai OCR v2/);
	assert.throws(() => uninstallTarget('env-review'), /Uninstall Hayai OCR v2 first/);

	// Deleting the model itself rewrites the install record instead of leaving a lie.
	const plan = uninstallTarget('hayai-ocr-v2');
	assert.ok(plan.paths.some((item) => item.kind === 'marker'));
	assert.equal(existsSync(dir), false);
	const marker = JSON.parse(await readFile(join(root, 'data/models/review/installed.json'), 'utf8'));
	assert.equal(marker['hayai-ocr-v2'], undefined);

	// With its only tenant gone, the environment can be removed.
	assert.equal(uninstallPlan('env-review').blocked, undefined);
});

test('uninstall unlinks a symlinked environment without touching what it points at', async () => {
	const real = join(root, 'keep-venv');
	await mkdir(join(real, 'bin'), { recursive: true });
	await writeFile(join(real, 'bin/python'), 'x');
	await symlink(real, join(root, '.venv-ocr'));

	const plan = uninstallTarget('env-ocr');
	assert.equal(plan.paths[0].kind, 'symlink');
	assert.equal(existsSync(join(root, '.venv-ocr')), false);
	assert.equal(existsSync(join(real, 'bin/python')), true, 'the linked environment must survive');
});

test('a model directory pointed at the filesystem root is refused, not deleted', () => {
	process.env.SCAN_LLM_MODELS_DIR = '/';
	try {
		assert.ok(uninstallPlan('qwen3.8-27b').paths.some((item) => item.path === '/'));
		assert.throws(() => uninstallTarget('qwen3.8-27b'), /Refusing to delete/);
	} finally {
		delete process.env.SCAN_LLM_MODELS_DIR;
	}
});

test('Qwen3-VL 8B installs as one entry: the managed launch lands on the seeded reader row', async () => {
	ensureInstalledModelRows('qwen3-vl-8b');
	const store = await import('../src/lib/server/modelRegistryStore');
	const merged = store.findRegistryRow('qwen3-vl-8b');
	assert.ok(merged?.managedLaunch, 'the one Qwen3-VL entry gains the managed launch');
	assert.match(String(merged?.managedLaunch?.modelPath), /models\/review\/qwen3-vl-8b\//);
	assert.ok(merged?.operations.includes('translate'), 'its chat jobs join its reader jobs');
	assert.equal(store.findRegistryRow('qwen3-vl-8b-chat'), undefined, 'no twin “8B (chat)” row is created');
	const { listReviewServerStatuses } = await import('../src/lib/server/localReview');
	const listed = await listReviewServerStatuses();
	assert.ok(!listed.some((item) => item.id === 'qwen3-vl-8b'), 'the model is listed once, as its managed row');
});

test('an older twin “8B (chat)” row is folded into the one Qwen3-VL entry', async () => {
	const store = await import('../src/lib/server/modelRegistryStore');
	// Rebuild a pre-merge install: the seeded reader row plus its managed twin.
	store.upsertRegistryRow({ ...store.findRegistryRow('qwen3-vl-8b')!, managedLaunch: null } as ModelRow);
	store.upsertRegistryRow({
		id: 'qwen3-vl-8b-chat',
		name: 'Qwen3-VL 8B (chat)',
		slug: 'qwen3-vl-8b',
		access: 'local_http',
		runtime: 'llamacpp',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		http: { baseUrl: '', apiKeyEnv: 'LLAMASWAP_API_KEY' },
		managedLaunch: {
			preset: 'generic',
			executable: '/usr/bin/llama-server',
			modelPath: join(root, 'data/models/review/qwen3-vl-8b/Qwen3-VL-8B-Instruct-Q8_0.gguf'),
			projectorPath: join(root, 'data/models/review/qwen3-vl-8b/mmproj-F16.gguf'),
			port: 18084,
			device: 'cpu',
			contextSize: 16384,
			gpuLayers: 0,
			slots: 1,
			startOnBoot: false,
			extraArgs: [],
		},
		requestPreset: 'generic',
		seeded: false,
		operationsLocked: false,
	} as ModelRow);

	ensureInstalledModelRows('qwen3-vl-8b');

	assert.equal(store.findRegistryRow('qwen3-vl-8b-chat'), undefined, 'the twin is dropped');
	const merged = store.findRegistryRow('qwen3-vl-8b');
	assert.equal(merged?.managedLaunch?.device, 'cpu', 'its launch settings are kept');
	assert.equal(merged?.managedLaunch?.port, 18084);
	assert.equal(merged?.managedLaunch?.slots, 1);
});

test('uninstalling Qwen3-VL 8B detaches its managed launch and keeps the reader entry', async () => {
	ensureInstalledModelRows('qwen3-vl-8b');
	const store = await import('../src/lib/server/modelRegistryStore');
	assert.ok(store.findRegistryRow('qwen3-vl-8b')?.managedLaunch);
	const review = join(root, 'data/models/review');
	await mkdir(review, { recursive: true });
	await writeFile(join(review, 'installed.json'), JSON.stringify({ 'qwen3-vl-8b': true }));

	const plan = uninstallTarget('qwen3-vl-8b');

	assert.ok(plan.warnings.some((item) => item.includes('detach')), 'the plan says the entry is kept');
	assert.equal(store.findRegistryRow('qwen3-vl-8b')?.managedLaunch ?? null, null, 'the launch goes with its weights');
	assert.ok(store.findRegistryRow('qwen3-vl-8b'), 'the seeded entry survives its weights');
	assert.deepEqual(
		[...(store.findRegistryRow('qwen3-vl-8b')?.operations ?? [])].sort(),
		[...CHAT_AND_CLI_OPERATIONS].sort(),
		'only the launch goes: the entry stays task-agnostic',
	);
});
