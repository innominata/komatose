import { modelPackage } from './modelPackages';
import { operatePackage } from './modelSupervisor';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { INSTALL_TARGETS, installTarget, type InstallTarget } from '../installCatalog';
import { translationModel, type TranslationModel } from '../translationModels';
import { CHAT_AND_CLI_OPERATIONS, type ModelRow } from '../modelRegistry';
import { ROLES } from '../types';
import { QWEN3_VL_ID, QWEN_38_27B_ID, QWEN_38_27B_LABEL } from '../qwenModels';
import { koharuInstalled } from './detect';
import { envVar } from './envFile';
import { IMAGE_EDIT_LIGHTNING_LORA } from '../imageEdit';
import { imageEditLorasDir, imageEditModelDir } from './gpuMode';
import { invalidateTorchProbe, torchVariantPref } from './computeDevices';
import { launchPreset } from './managedModelConfig';
import { findRegistryRow, listRegistryRows, removeOverlayRow, upsertRegistryRow } from './modelRegistryStore';
import { managedModelStatus } from './managedModels';
import { toHomeLaunch } from './homePath';
import { translationModelsDir } from './translationRuntime';
import { DATA_DIR, ROOT } from './paths';

/**
 * Resolves the whitelisted install command for one catalog target and runs it.
 * Only ids in `INSTALL_TARGETS` ever reach `spawn`, and the arguments are a
 * fixed array — user input is never part of the command line.
 */

export type InstallJobState = 'running' | 'done' | 'failed';

export type InstallJob = {
	targetId: string;
	/** Display form of the exact command, e.g. `.venv-review/bin/python scripts/…`. */
	command: string;
	state: InstallJobState;
	lines: string[];
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	error?: string;
};

export type InstallStatus = {
	id: string;
	installed: boolean;
	/** Why an environment or weights check says no; shown under the row. */
	detail?: string;
	/** True when `requires` is unmet — the UI hides Install until one is present. */
	blocked?: boolean;
	blocker?: string;
	command: string;
	/** What an uninstall would delete, for the confirmation dialog. */
	uninstallPaths?: string[];
	uninstallBlocked?: string;
	uninstallWarnings?: string[];
	alsoRemoves?: string[];
	job?: InstallJob;
};

type EnvSpec = { id: string; envVar: string; dir: string; label: string };

const ENV_SPECS: EnvSpec[] = [
	{ id: 'env-ocr', envVar: 'PADDLEOCR_PYTHON', dir: '.venv-ocr', label: '.venv-ocr' },
	{ id: 'env-review', envVar: 'SCAN_REVIEW_PYTHON', dir: '.venv-review', label: '.venv-review' },
	{ id: 'env-workflow', envVar: 'SCAN_WORKFLOW_PYTHON', dir: '.venv-workflow', label: '.venv-workflow' },
];

const ALL_ENV_IDS = ENV_SPECS.map((spec) => spec.id);

function existingExecutable(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isFile();
	} catch {
		return false;
	}
}

function envPythonPath(envId: string): string | undefined {
	const spec = ENV_SPECS.find((item) => item.id === envId);
	if (!spec) return undefined;
	const configured = envVar(spec.envVar);
	if (configured && existingExecutable(configured)) return configured;
	const venvPython = join(ROOT, spec.dir, 'bin/python');
	return existingExecutable(venvPython) ? venvPython : undefined;
}

export function environmentInstalled(envId: string): boolean {
	return Boolean(envPythonPath(envId));
}

/** First installed environment in preference order, else a PATH `python3`. */
function pythonFor(preferred: readonly string[]): string {
	for (const envId of preferred) {
		const found = envPythonPath(envId);
		if (found) return found;
	}
	return 'python3';
}

const sh = (value: string) => (/^[\w./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The exact command this target runs, as a copy-pasteable string. */
export function installCommand(target: InstallTarget): { command: string; bin: string; args: string[] } {
	const script = (name: string, args: string[] = []) => ['scripts/' + name, ...args];
	let bin = 'python3';
	let args: string[] = [];
	switch (target.id) {
		case 'env-ocr':
		case 'env-review':
		case 'env-workflow':
			bin = 'python3';
			// The PyTorch wheel is chosen per machine: CPU everywhere, CUDA or
			// ROCm where the operator (or auto-detection) says so.
			args = script('setup-python-env.py', ['--env', target.id.slice(4), '--torch', torchVariantPref()]);
			break;
		case 'qwen3.8-27b':
			bin = pythonFor(ALL_ENV_IDS);
			args = script('install-llm-model.py');
			break;
		case 'rtdetr':
		case 'ctd':
			bin = pythonFor(['env-workflow', 'env-ocr', 'env-review']);
			args = script('install-detect-models.py', ['--model', target.id]);
			break;
		case 'koharu':
			bin = pythonFor(['env-workflow', 'env-ocr', 'env-review']);
			args = script('install-koharu.py');
			break;
		case 'coo':
			bin = pythonFor(['env-workflow']);
			args = script('install-coo.py');
			break;
		case 'hayai-ocr-v2':
		case 'manga-ocr':
		case 'paddleocr-vl-1.6':
		case 'qwen3-vl-8b':
			bin = pythonFor(['env-review', 'env-ocr', 'env-workflow']);
			args = script('install-review-models.py', ['--model', target.id]);
			break;
		case 'cat-translate-7b-q4':
		case 'hy-mt2-manga-v5':
		case 'hy-mt2-7b-q4':
		case 'imsbee-ko-en-translator':
		case 'opus-mt-ja-en':
		case 'shisa-v2.1-qwen3-8b-q4':
		case 'sugoi-v4-ja-en':
		case 'translategemma-4b-q4':
		case 'translategemma-12b-q4':
			bin = pythonFor(['env-review', 'env-ocr', 'env-workflow']);
			args = script('install-translation-models.py', ['--model', target.id]);
			break;
		case 'qwen-image-edit-2511':
			bin = pythonFor(['env-workflow', 'env-ocr', 'env-review']);
			args = script('install-image-edit-model.py');
			break;
		case 'qwen-image-edit-2511-lightning':
			bin = pythonFor(['env-workflow', 'env-ocr', 'env-review']);
			args = script('install-image-edit-model.py', ['--lightning']);
			break;
		case 'big-lama':
		case 'aot':
		case 'lama-manga':
		case 'migan':
		case 'manga-inpainting':
			bin = pythonFor(['env-workflow', 'env-ocr', 'env-review']);
			args = script('install-clean-models.py', ['--model', target.id]);
			break;
		default:
			throw Object.assign(new Error(`No installer for ${target.id}`), { status: 400 });
	}
	const parts = [bin, ...args];
	return { command: parts.map(sh).join(' '), bin, args };
}

// ---------------------------------------------------------------- installed

function hfCacheHub(): string {
	const home = envVar('HF_HOME') || join(homedir(), '.cache/huggingface');
	return join(home, 'hub');
}

function hfCachePath(repo: string): string {
	return join(hfCacheHub(), `models--${repo.replace('/', '--')}`);
}

/** True when the Hugging Face cache holds `file` for `repo` (any snapshot). */
function hfCached(repo: string, file: string): boolean {
	const dir = join(hfCacheHub(), `models--${repo.replace('/', '--')}`);
	if (!existsSync(dir)) return false;
	try {
		return readdirSync(join(dir, 'snapshots')).some((snapshot) =>
			existsSync(join(dir, 'snapshots', snapshot, file)),
		);
	} catch {
		return false;
	}
}

function reviewDir(): string {
	return envVar('SCAN_REVIEW_MODELS_DIR') || join(DATA_DIR, 'models/review');
}

/** Weights marker + at least one model file, without requiring llama-server. */
function reviewWeightsInstalled(id: string): boolean {
	try {
		const marker = JSON.parse(readFileSync(join(reviewDir(), 'installed.json'), 'utf8')) as Record<string, unknown>;
		if (!marker[id]) return false;
		const dir = join(reviewDir(), id);
		return existsSync(dir) && readdirSync(dir).some((name) => {
			try {
				return statSync(join(dir, name)).isFile();
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

function translationInstalled(model: TranslationModel): boolean {
	if (!model.weights) return false;
	const dir = envVar('SCAN_TRANSLATION_MODELS_DIR') || join(DATA_DIR, 'models/translation');
	const folder = join(dir, model.id);
	const specs = [model.weights, ...(model.weights.extras || [])];
	return specs.every((spec) => {
		const path = join(folder, spec.filename);
		try {
			return statSync(path).isFile() && statSync(path).size === spec.bytes;
		} catch {
			return false;
		}
	});
}

function imageModelInstalled(id: string): boolean {
	const dir = imageEditModelDir(id);
	if (!existsSync(dir)) return false;
	if (existsSync(join(dir, 'installed.json'))) return true;
	try {
		return readdirSync(dir).some(
			(name) => name.toLowerCase().endsWith('.gguf') && statSync(join(dir, name)).size > 4,
		);
	} catch {
		return false;
	}
}

function llmChatInstalled(): boolean {
	const dir = envVar('SCAN_LLM_MODELS_DIR') || join(homedir(), 'models/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF');
	try {
		return readdirSync(dir).some(
			(name) => name.toLowerCase().endsWith('.gguf') && statSync(join(dir, name)).size > 4,
		);
	} catch {
		return false;
	}
}

function cooInstalled(): boolean {
	return existsSync(envVar('SCAN_COO_MODEL') || join(DATA_DIR, 'models/coo/dbnetpp-coo.pt'));
}

export function targetInstalled(target: InstallTarget): { installed: boolean; detail?: string } {
	switch (target.id) {
		case 'env-ocr':
		case 'env-review':
		case 'env-workflow': {
			const spec = ENV_SPECS.find((item) => item.id === target.id)!;
			const path = envPythonPath(target.id);
			return path
				? { installed: true, detail: path }
				: { installed: false, detail: `No ${spec.label} Python on this machine` };
		}
		case 'qwen3.8-27b':
			return llmChatInstalled()
				? { installed: true }
				: { installed: false, detail: 'No GGUF found in the model directory' };
		case 'rtdetr':
			return hfCached('ogkalu/comic-text-and-bubble-detector', 'model.safetensors') &&
				hfCached('ogkalu/comic-text-and-bubble-detector', 'detector.onnx')
				? { installed: true }
				: { installed: false, detail: 'Not in the Hugging Face cache' };
		case 'ctd':
			return ['yolo-v5.safetensors', 'unet.safetensors', 'dbnet.safetensors'].every(
				file => hfCached('mayocream/comic-text-detector', file)) &&
				existsSync(join(envVar('SCAN_CTD_SOURCE_DIR') || join(ROOT,
					'data/models/ctd-native-a9fca9d0e8ecec081d3cd817efb98f2f863e262c'), 'ctd/basemodel.py')) &&
				hfCached('mayocream/comic-text-detector-onnx', 'comic-text-detector.onnx')
				? { installed: true }
				: { installed: false, detail: 'Not in the Hugging Face cache' };
		case 'migan':
		case 'manga-inpainting': {
			const directory = join(envVar('SCAN_WORKFLOW_MODELS_DIR') || join(DATA_DIR, 'models/workflow'), target.id);
			const files = target.id === 'migan' ? ['migan_traced.pt'] : ['manga_inpaintor.jit', 'erika.jit'];
			const installed = [...files, 'LICENSE'].every(file => {
				try { return statSync(join(directory, file)).size > 0; } catch { return false; }
			});
			return { installed, detail: installed ? undefined : 'Weights or license notice missing; install this model' };
		}
		case 'big-lama':
			return hfCached('dreMaz/AnimeMangaInpainting', 'lama_large_512px.ckpt')
				? { installed: true }
				: { installed: false, detail: 'Not in the Hugging Face cache' };
		case 'aot':
			return hfCached('ogkalu/aot-inpainting', 'aot_traced.pt')
				? { installed: true }
				: { installed: false, detail: 'Not in the Hugging Face cache' };
		case 'lama-manga':
			return hfCached('mayocream/lama-manga', 'lama-manga.safetensors')
				? { installed: true }
				: { installed: false, detail: 'Not in the Hugging Face cache' };
		case 'koharu':
			return koharuInstalled()
				? { installed: true }
				: { installed: false, detail: 'Weights or Hi-SAM source missing' };
		case 'coo':
			return cooInstalled() ? { installed: true } : { installed: false, detail: 'Checkpoint not downloaded' };
		case 'hayai-ocr-v2':
		case 'manga-ocr':
		case 'paddleocr-vl-1.6':
		case 'qwen3-vl-8b':
			return reviewWeightsInstalled(target.id)
				? { installed: true }
				: { installed: false, detail: 'Weights not downloaded' };
		case 'qwen-image-edit-2511':
			return imageModelInstalled(target.id)
				? { installed: true }
				: { installed: false, detail: 'Weights not downloaded' };
		case 'qwen-image-edit-2511-lightning': {
			if (!imageModelInstalled('qwen-image-edit-2511'))
				return { installed: false, detail: 'Qwen-Image-Edit 2511 weights are not installed' };
			const lora = join(imageEditLorasDir(), IMAGE_EDIT_LIGHTNING_LORA);
			return existsSync(lora)
				? { installed: true }
				: { installed: false, detail: 'Lightning LoRA is not downloaded' };
		}
		default: {
			const model = translationModel(target.id);
			if (model) {
				return translationInstalled(model)
					? { installed: true }
					: { installed: false, detail: 'Weights not downloaded' };
			}
			return { installed: false, detail: 'Unknown target' };
		}
	}
}

function blockerFor(target: InstallTarget): string | undefined {
	if (!target.requires?.length) return undefined;
	const met = target.requires.filter((envId) => environmentInstalled(envId));
	if (met.length) return undefined;
	const labels = target.requires
		.map((envId) => ENV_SPECS.find((spec) => spec.id === envId)?.label || envId)
		.join(' or ');
	return `Requires ${labels} — install a runtime environment first`;
}

export function installStatus(target: InstallTarget): InstallStatus {
	const state = targetInstalled(target);
	const blocker = blockerFor(target);
	const { command } = installCommand(target);
	const uninstall = state.installed ? uninstallPlan(target.id) : undefined;
	return {
		id: target.id,
		installed: state.installed,
		detail: state.detail,
		blocked: Boolean(blocker),
		blocker,
		command,
		uninstallPaths: uninstall?.paths.map((item) => item.path),
		uninstallBlocked: uninstall?.blocked,
		uninstallWarnings: uninstall?.warnings,
		alsoRemoves: uninstall?.alsoRemoves,
		job: jobs().get(target.id),
	};
}

export function listInstallStatuses(): InstallStatus[] {
	return INSTALL_TARGETS.map((target) => installStatus(target));
}

// ---------------------------------------------------------------- job runner

type Store = { jobs: Map<string, InstallJob>; children: Map<string, ChildProcess> };
const global = globalThis as typeof globalThis & { __komatoseInstalls?: Store };
const store: Store = global.__komatoseInstalls ??= { jobs: new Map(), children: new Map() };
store.children ??= new Map();

const MAX_JOBS = 8;
const MAX_LINES = 400;
const MAX_LINE_CHARS = 2_000;
const JOB_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function jobs() {
	return store.jobs;
}

function pushLine(job: InstallJob, raw: string) {
	const line = raw.replace(/\s+$/, '').slice(0, MAX_LINE_CHARS);
	if (!line) return;
	job.lines.push(line);
	if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES);
}

const packageInstalls = new Map<string, AbortController>();

/** Run one configured installer. Throws 409 when that target is already running. */
export function startInstall(targetId: string): InstallJob {
  const pkg = modelPackage(targetId);
  if (pkg) {
    if (jobs().get(targetId)?.state === 'running') throw new Error('That install is already running');
    const controller = new AbortController();
    const job: InstallJob = { targetId, command: `Install ${pkg.manifest.name}`, state: 'running', lines: [], startedAt: Date.now() };
    jobs().set(targetId, job);
    packageInstalls.set(targetId, controller);
    void operatePackage(targetId, 'install', controller.signal, message => pushLine(job, message)).then(() => {
      job.state = 'done'; job.exitCode = 0;
    }, error => { job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); }).finally(() => {
      job.endedAt = Date.now(); packageInstalls.delete(targetId);
    });
    return job;
  }

	const target = installTarget(targetId);
	if (!target) throw Object.assign(new Error('Unknown install target'), { status: 404 });
	const existing = jobs().get(targetId);
	if (existing?.state === 'running')
		throw Object.assign(new Error('That install is already running'), { status: 409 });

	const { command, bin, args } = installCommand(target);
	const job: InstallJob = { targetId, command, state: 'running', lines: [], startedAt: Date.now() };
	jobs().set(targetId, job);

	const child = spawn(bin, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
	store.children.set(targetId, child);
	let buffer = '';
	let stderrTail = '';
	const settle = (state: InstallJobState, exitCode?: number | null, error?: string) => {
		if (job.state !== 'running') return;
		job.state = state;
		job.exitCode = exitCode ?? null;
		job.error = error;
		job.endedAt = Date.now();
	};
	const killTimer = setTimeout(() => {
		child.kill('SIGKILL');
		settle('failed', null, 'Install timed out after 4 hours');
	}, JOB_TIMEOUT_MS);
	killTimer.unref?.();

	let spawnError = '';
	child.on('error', (error) => {
		spawnError = error instanceof Error ? error.message : String(error);
	});
	const onData = (chunk: Buffer) => {
		buffer += chunk.toString();
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			pushLine(job, buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
		}
		if (buffer.length > MAX_LINE_CHARS) buffer = buffer.slice(-MAX_LINE_CHARS);
	};
	child.stdout?.on('data', onData);
	child.stderr?.on('data', (chunk: Buffer) => {
		stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
		onData(chunk);
	});
	child.on('close', (code) => {
		clearTimeout(killTimer);
		if (store.children.get(targetId) === child) store.children.delete(targetId);
		if (buffer.trim()) pushLine(job, buffer);
		if (spawnError) return settle('failed', null, spawnError);
		if (code === 0) settle('done', code);
		else settle('failed', code, stderrTail.trim().split('\n').slice(-1)[0] || `Exit code ${code}`);
	});

	// Keep the store bounded once installs stop being watched.
	if (jobs().size > MAX_JOBS) {
		for (const [key, value] of jobs()) {
			if (key !== targetId && value.state !== 'running') jobs().delete(key);
			if (jobs().size <= MAX_JOBS) break;
		}
	}
	return job;
}

/** Stop a running installer for this target. */
export function cancelInstall(targetId: string): InstallJob | undefined {
  packageInstalls.get(targetId)?.abort();
	const job = jobs().get(targetId);
	if (!job) return undefined;
	if (job.state === 'running') {
		const child = store.children.get(targetId);
		child?.kill('SIGTERM');
		setTimeout(() => {
			if (job.state === 'running') child?.kill('SIGKILL');
		}, 2_000).unref?.();
	}
	return job;
}

// ------------------------------------------------------------- install queue

/**
 * Dependency-aware install queue. Selecting a model whose environment is missing
 * no longer blocks: the environment is queued first and the model follows it.
 * One step runs at a time, matching what the installers expect of the machine.
 */
export type InstallQueueItem = {
	key: string;
	kind: 'env' | 'model';
	label: string;
	command: string;
	/** Target whose install needs this step; shown as "needed by …". */
	neededBy?: string;
	state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
	error?: string;
};

type QueueStore = { items: InstallQueueItem[]; timer?: NodeJS.Timeout };
const globalQueue = globalThis as typeof globalThis & { __komatoseInstallQueue?: QueueStore };
const queue: QueueStore = globalQueue.__komatoseInstallQueue ??= { items: [] };

function queueItemFor(id: string) {
	return queue.items.find((item) => item.key === id && item.state !== 'cancelled');
}

/** Steps for the wanted targets: environments first, duplicates collapsed. */
export function planInstallSteps(ids: string[]): { plan: InstallQueueItem[]; skipped: string[] } {
	const plan: InstallQueueItem[] = [];
	const skipped: string[] = [];
	const planned = new Set<string>();
	const add = (id: string, kind: 'env' | 'model', neededBy?: string) => {
		if (planned.has(id) || queueItemFor(id)) return;
		const target = installTarget(id);
		if (!target) return;
		if (targetInstalled(target).installed) {
			if (kind === 'model') skipped.push(id);
			return;
		}
		planned.add(id);
		const { command } = installCommand(target);
		plan.push({
			key: id,
			kind,
			label: kind === 'env' ? `${target.label}` : target.label,
			command,
			neededBy: neededBy ? installTarget(neededBy)?.label : undefined,
			state: 'queued',
		});
	};
	for (const id of ids) {
		const ahead = installTarget(id);
		for (const depId of ahead?.installsWith || []) {
			const dep = installTarget(depId);
			if (!dep) continue;
			for (const envId of dep.requires || []) add(envId, 'env', depId);
			add(depId, 'model', id);
		}
    const pkg = modelPackage(id);
    if (pkg) {
      if (!planned.has(id)) {
        planned.add(id);
        plan.push({ key: id, kind: pkg.manifest.kind === 'runtime' ? 'env' : 'model', label: pkg.manifest.name,
          command: `Install ${pkg.manifest.name} and dependencies`, state: 'queued' });
      }
      continue;
    }
		const target = installTarget(id);
		if (!target) continue;
		for (const envId of target.requires || []) add(envId, 'env', id);
		add(id, 'model');
	}
	return { plan, skipped };
}

/** Queue the steps and start the pump. Returns what will run. */
export function startInstallQueue(ids: string[]): { plan: InstallQueueItem[]; skipped: string[] } {
	const { plan, skipped } = planInstallSteps(ids);
	if (!plan.length) return { plan, skipped };
	queue.items.push(...plan);
	pumpQueue();
	return { plan, skipped };
}

export function installQueueStatus(): InstallQueueItem[] {
	return queue.items.map((item) => {
		const job = item.kind === 'model' || ENV_IDS.includes(item.key) ? jobs().get(item.key) : undefined;
		if (item.state === 'running' && job && job.state !== 'running')
			return { ...item, state: job.state === 'done' ? 'done' : 'failed', error: job.error };
		return item;
	});
}

export function clearFinishedInstalls() {
	queue.items = queue.items.filter((item) => item.state === 'queued' || item.state === 'running');
}

/** Cancel one step; anything that depended on it is cancelled with a reason. */
export function cancelInstallStep(key: string): InstallQueueItem | undefined {
	const item = queueItemFor(key);
	if (!item) return undefined;
	if (item.state === 'running') cancelInstall(key);
	item.state = 'cancelled';
	const target = installTarget(key);
	for (const other of queue.items) {
		if (other.state !== 'queued') continue;
		const otherTarget = installTarget(other.key);
		const needs = otherTarget?.requires || [];
		if ((target?.group === 'environment' && needs.includes(key)) || otherTarget?.installsWith?.includes(key)) {
			other.state = 'cancelled';
			other.error = `Needs ${target?.label ?? key}`;
		}
	}
	return item;
}

const ENV_IDS = ['env-ocr', 'env-review', 'env-workflow'];

function pumpQueue() {
	if (queue.timer) return;
	queue.timer = setInterval(() => {
		const running = queue.items.find((item) => item.state === 'running');
		if (running) {
			const job = jobs().get(running.key);
			if (job && job.state !== 'running') {
				running.state = job.state === 'done' ? 'done' : 'failed';
				running.error = job.error;
				if (running.state === 'done') afterInstallDone(running.key);
			}
			return;
		}
		const next = queue.items.find((item) => item.state === 'queued');
		if (!next) {
			clearInterval(queue.timer);
			queue.timer = undefined;
			return;
		}
		try {
			startInstall(next.key);
			next.state = 'running';
		} catch (error) {
			next.state = 'failed';
			next.error = error instanceof Error ? error.message : String(error);
		}
	}, 700);
	queue.timer.unref?.();
}

/** Weights on disk are half the job; the model must also be usable in the app. */
function afterInstallDone(targetId: string) {
	ensureInstalledModelRows(targetId);
}

/** The registry work an install completion performs. Exported so tests can run it. */
export function ensureInstalledModelRows(targetId: string) {
	if (targetId === 'env-review' || targetId === 'env-workflow')
		invalidateTorchProbe(targetId === 'env-review' ? 'env-review' : 'env-workflow');
	if (targetId === 'qwen3.8-27b') ensureChatRow();
	if (targetId === 'qwen3-vl-8b') ensureQwen3VlManaged();
}

const QWEN3_VL_CHAT_ID = `${QWEN3_VL_ID}-chat`;
const QWEN3_VL_CHAT_PORT = 18084;

/**
 * Installing a chat-capable model is the operator asking for a working chat
 * model: add the managed launch it needs, so Translate works without a second
 * configuration trip. Qwen 3.8 27B gets a managed row of its own; Qwen3-VL 8B
 * already has one entry as the app's reader, and one model is one entry — the
 * launch lands on that row so a single server serves its reads and its chat.
 */
function ensureChatRow() {
	try {
		const id = QWEN_38_27B_ID;
		if (findRegistryRow(id)) return;
		const preset = launchPreset('qwen38');
		upsertRegistryRow({
			id,
			name: QWEN_38_27B_LABEL,
			slug: 'qwen3.8-27b-q4',
			access: 'local_http',
			runtime: 'llamacpp',
			operations: [...CHAT_AND_CLI_OPERATIONS],
			roles: [...ROLES],
			http: { baseUrl: '', apiKeyEnv: 'LLAMASWAP_API_KEY' },
			managedLaunch: toHomeLaunch(preset),
			requestPreset: 'qwen-thinking',
			seeded: false,
			operationsLocked: false,
		} as ModelRow);
	} catch {
		/* The weights are installed either way; the row can be added by hand. */
	}
}

/**
 * Qwen3-VL is one model with two jobs — the review reader and the light chat
 * model — so it keeps its single seeded entry and gains the managed launch that
 * serves both. A twin “8B (chat)” row from an older install is folded in here
 * (its launch settings win) and dropped, so the model is listed once again.
 */
function ensureQwen3VlManaged() {
	try {
		const row = findRegistryRow(QWEN3_VL_ID);
		if (!row || row.managedLaunch) return;
		const legacy = findRegistryRow(QWEN3_VL_CHAT_ID);
		if (legacy) {
			// Drop the twin first: if it is running or busy, leave everything
			// alone and fold it in on a later install instead of splitting its port.
			try { removeOverlayRow(QWEN3_VL_CHAT_ID); }
			catch { return; }
		}
		const dir = join(reviewDir(), QWEN3_VL_ID);
		const launch = legacy?.managedLaunch ?? toHomeLaunch({
			preset: 'generic',
			executable: envVar('SCAN_REVIEW_LLAMA_SERVER') || launchPreset('generic').executable,
			modelPath: join(dir, 'Qwen3-VL-8B-Instruct-Q8_0.gguf'),
			projectorPath: join(dir, 'mmproj-F16.gguf'),
			templatePath: '',
			port: QWEN3_VL_CHAT_PORT,
			device: 'auto',
			contextSize: 16384,
			gpuLayers: 999,
			slots: 2,
			startOnBoot: true,
			extraArgs: [],
		});
		upsertRegistryRow({
			...row,
			managedLaunch: launch,
			http: { baseUrl: '', apiKeyEnv: 'LLAMASWAP_API_KEY' },
			requestPreset: 'generic',
			operations: [...CHAT_AND_CLI_OPERATIONS],
			operationsLocked: false,
		} as ModelRow);
	} catch {
		/* The weights are installed either way; the row can be configured by hand. */
	}
}

// ---------------------------------------------------------------- uninstall

export type UninstallPath = { path: string; note: string; kind: 'dir' | 'file' | 'cache' | 'venv' | 'symlink' | 'marker' };
export type UninstallPlan = {
	id: string;
	label: string;
	paths: UninstallPath[];
	warnings: string[];
	/** Non-empty when an uninstall must not run yet; shown instead of the button. */
	blocked?: string;
	/** Model entries whose rows go away with these weights. */
	alsoRemoves: string[];
};

const HF_REPOS: Record<string, string> = {
	rtdetr: 'ogkalu/comic-text-and-bubble-detector',
	ctd: 'mayocream/comic-text-detector',
	'big-lama': 'dreMaz/AnimeMangaInpainting',
	aot: 'ogkalu/aot-inpainting',
	'lama-manga': 'mayocream/lama-manga',
};

function kindOf(path: string): UninstallPath['kind'] {
	try {
		if (lstatSync(path).isSymbolicLink()) return 'symlink';
	} catch {
		return 'file';
	}
	return statSync(path).isDirectory() ? 'dir' : 'file';
}

function describePath(path: string, note: string): UninstallPath {
	const kind = kindOf(path);
	return {
		path,
		note: kind === 'symlink' ? `${note} (symlink — the linked files are kept)` : note,
		kind,
	};
}

function safeToDelete(path: string): boolean {
	const resolved = path.replace(/\/+$/, '');
	if (!resolved || resolved[0] !== '/') return false;
	const forbidden = new Set(['', '/', homedir(), ROOT, DATA_DIR, process.env.SCAN_ROOT || '']);
	return !forbidden.has(resolved);
}

/** Weights and files one target owns, mirroring exactly where its installer wrote. */
function uninstallPathsFor(targetId: string): { paths: UninstallPath[]; alsoRemoves: string[]; warnings: string[] } {
	const paths: UninstallPath[] = [];
	const alsoRemoves: string[] = [];
	const warnings: string[] = [];
	if (targetId.startsWith('env-')) {
		paths.push(describePath(join(ROOT, `.venv-${targetId.slice(4)}`), `Python environment ${targetId.slice(4)}`));
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'qwen3.8-27b') {
		const dir = envVar('SCAN_LLM_MODELS_DIR') || join(homedir(), 'models/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF');
		paths.push(describePath(dir, 'Chat model weights (GGUF + vision projector)'));
		const row = findRegistryRow(QWEN_38_27B_ID);
		if (row?.managedLaunch && String(row.managedLaunch.modelPath || '').startsWith(dir)) {
			alsoRemoves.push(row.name);
			warnings.push(`The managed entry “${row.name}” points at these weights and is removed with them.`);
		}
		return { paths, alsoRemoves, warnings };
	}
	const repo = HF_REPOS[targetId];
	if (repo) {
		paths.push(describePath(hfCachePath(repo), 'Downloaded weights in the Hugging Face cache'));
		if (targetId === 'ctd') {
			paths.push(describePath(hfCachePath('mayocream/comic-text-detector-onnx'), 'CPU ONNX fallback weights'));
			paths.push(describePath(envVar('SCAN_CTD_SOURCE_DIR') || join(ROOT,
				'data/models/ctd-native-a9fca9d0e8ecec081d3cd817efb98f2f863e262c'), 'Pinned CTD native architecture'));
		}
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'koharu') {
		const weights = envVar('SCAN_KOHARU_WEIGHTS') || join(ROOT, 'data/models/koharu-text-sam-ts-l/model.safetensors');
		paths.push(describePath(kindOf(weights) === 'dir' ? weights : dirname(weights), 'Koharu weights'));
		try {
			for (const name of readdirSync(join(ROOT, 'data/models'))) {
				if (name.startsWith('hi-sam-'))
					paths.push(describePath(join(ROOT, 'data/models', name), 'Hi-SAM source used by Koharu'));
			}
		} catch {
			/* no data/models directory */
		}
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'coo') {
		const file = envVar('SCAN_COO_MODEL') || join(DATA_DIR, 'models/coo/dbnetpp-coo.pt');
		paths.push(describePath(file, 'COO sound-effect checkpoint'));
		if (!envVar('SCAN_COO_MODEL') && existsSync(join(DATA_DIR, 'models/coo')))
			paths.push(describePath(join(DATA_DIR, 'models/coo'), 'Its model directory'));
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'migan' || targetId === 'manga-inpainting') {
		const directory = join(envVar('SCAN_WORKFLOW_MODELS_DIR') || join(DATA_DIR, 'models/workflow'), targetId);
		paths.push(describePath(directory, 'Its model weights and license notice'));
		const receipt = join(DATA_DIR, 'models/package-installations', `${targetId}.json`);
		if (existsSync(receipt)) paths.push(describePath(receipt, 'Its installation receipt'));
		return { paths, alsoRemoves, warnings };
	}
	const REVIEW_IDS = ['hayai-ocr-v2', 'manga-ocr', 'paddleocr-vl-1.6', 'qwen3-vl-8b'];
	if (REVIEW_IDS.includes(targetId)) {
		paths.push(describePath(join(reviewDir(), targetId), 'Model weights'));
		paths.push({ path: join(reviewDir(), 'installed.json'), note: `Its “${targetId}” entry in the install record`, kind: 'marker' });
		if (targetId === 'qwen3-vl-8b') {
			const merged = findRegistryRow(QWEN3_VL_ID);
			if (merged?.managedLaunch && String(merged.managedLaunch.modelPath || '').startsWith(join(reviewDir(), targetId)))
				warnings.push(`“${merged.name}” keeps its entry, but its managed server and chat jobs detach from these weights.`);
			const row = findRegistryRow(QWEN3_VL_CHAT_ID);
			if (row?.managedLaunch && String(row.managedLaunch.modelPath || '').startsWith(join(reviewDir(), targetId))) {
				alsoRemoves.push(row.name);
				warnings.push(`The managed entry “${row.name}” points at these weights and is removed with them.`);
			}
		}
		return { paths, alsoRemoves, warnings };
	}
	const translation = translationModel(targetId);
	if (translation) {
		paths.push(describePath(join(translationModelsDir(), targetId), 'Translator weights'));
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'qwen-image-edit-2511') {
		paths.push(describePath(imageEditModelDir(targetId), 'Image editor weights'));
		warnings.push('A running editor must be stopped first.');
		warnings.push('Qwen-Image-Edit 2511 Lightning uses these weights.');
		return { paths, alsoRemoves, warnings };
	}
	if (targetId === 'qwen-image-edit-2511-lightning') {
		paths.push(describePath(join(imageEditLorasDir(), IMAGE_EDIT_LIGHTNING_LORA), 'Lightning LoRA'));
		return { paths, alsoRemoves, warnings };
	}
	return { paths, alsoRemoves, warnings };
}

/** Everything an uninstall would delete, plus why it must not run yet. */
export function uninstallPlan(targetId: string): UninstallPlan {
	const target = installTarget(targetId);
	if (!target) throw Object.assign(new Error('Unknown install target'), { status: 404 });
	const { paths, alsoRemoves, warnings } = uninstallPathsFor(targetId);
	const plan: UninstallPlan = { id: targetId, label: target.label, paths, warnings, alsoRemoves };

	if (targetId.startsWith('env-')) {
		const dependents = INSTALL_TARGETS.filter(
			(item) => item.requires?.includes(targetId) && targetInstalled(item).installed,
		);
		if (dependents.length)
			plan.blocked = `Uninstall ${dependents.map((item) => item.label).join(', ')} first — they run in this environment.`;
		return plan;
	}
	// Models still running must stop before their weights go away.
	for (const row of listRegistryRows()) {
		if (!row.managedLaunch) continue;
		const uses = targetId === 'qwen3.8-27b'
			? row.id === QWEN_38_27B_ID
			: targetId === 'qwen3-vl-8b'
				? row.id === QWEN3_VL_CHAT_ID || row.id === QWEN3_VL_ID
				: false;
		if (!uses) continue;
		const state = managedRowState(row.id);
		if (state === 'running' || state === 'starting' || state === 'stopping')
			plan.blocked = `Stop ${row.name} first — it is ${state}.`;
	}
	return plan;
}

function managedRowState(id: string): string {
	try {
		const row = findRegistryRow(id);
		return row ? managedModelStatus(row).state : 'stopped';
	} catch {
		return 'stopped';
	}
}

function removeRowIfUninstalled(rowId: string, deletedRoot: string) {
	const row = findRegistryRow(rowId);
	if (!row?.managedLaunch) return;
	if (!String(row.managedLaunch.modelPath || '').startsWith(deletedRoot)) return;
	try {
		removeOverlayRow(rowId);
	} catch {
		/* already gone */
	}
}

/** A seeded entry survives its weights; the managed launch that serves them does not. */
function detachManagedIfUninstalled(rowId: string, deletedRoot: string) {
	const row = findRegistryRow(rowId);
	if (!row?.managedLaunch) return;
	if (!String(row.managedLaunch.modelPath || '').startsWith(deletedRoot)) return;
	try {
		// Only the launch goes away; the model stays task-agnostic with its
		// operations untouched — what it can do is the tests' business.
		upsertRegistryRow({
			...row,
			managedLaunch: null,
		} as ModelRow);
	} catch {
		/* leave it; the operator can detach the launch by hand */
	}
}

/** Delete the target's files. Throws 409 when something still needs them. */
export function uninstallTarget(targetId: string): UninstallPlan {
	const plan = uninstallPlan(targetId);
	if (plan.blocked) throw Object.assign(new Error(plan.blocked), { status: 409 });
	for (const item of plan.paths) {
		if (!safeToDelete(item.path))
			throw Object.assign(new Error(`Refusing to delete ${item.path}`), { status: 400 });
		try {
			if (kindOf(item.path) === 'symlink') unlinkSync(item.path);
			else if (item.kind === 'marker') {
				const marker = JSON.parse(readFileSync(item.path, 'utf8')) as Record<string, unknown>;
				delete marker[targetId];
				writeFileSync(item.path, JSON.stringify(marker, null, 2));
			} else rmSync(item.path, { recursive: true, force: true });
		} catch (error) {
			throw Object.assign(
				new Error(`Could not delete ${item.path}: ${error instanceof Error ? error.message : error}`),
				{ status: 500 },
			);
		}
	}
	const chatDir = envVar('SCAN_LLM_MODELS_DIR') || join(homedir(), 'models/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF');
	if (targetId === 'qwen3.8-27b') removeRowIfUninstalled(QWEN_38_27B_ID, chatDir);
	if (targetId === 'qwen3-vl-8b') {
		removeRowIfUninstalled(QWEN3_VL_CHAT_ID, join(reviewDir(), 'qwen3-vl-8b'));
		detachManagedIfUninstalled(QWEN3_VL_ID, join(reviewDir(), 'qwen3-vl-8b'));
	}
	if (targetId.startsWith('env-')) invalidateTorchProbe(targetId === 'env-ocr' ? undefined : `env-${targetId.slice(4)}`);
	return plan;
}
