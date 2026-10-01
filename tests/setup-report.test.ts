import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CHAT_AND_CLI_OPERATIONS, SEED_ROWS, type ModelRow } from '../src/lib/modelRegistry';
import type { CliToolAdminStatus } from '../src/lib/server/cliToolStatus';
import type { SetupDeps } from '../src/lib/server/setupReport';

const root = await mkdtemp(join(tmpdir(), 'scan-setup-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
await mkdir(join(root, 'data'), { recursive: true });

// Imported after the env above: paths.ts snapshots SCAN_ROOT/DATABASE_URL at load.
const { buildSetupReport } = await import('../src/lib/server/setupReport');
const { requireManageUsers, requireUser } = await import('../src/lib/server/http');

/**
 * The chat model is a launch preset, not a seed: tests model the row an
 * operator adds in Setup → Local models. The report's default-translate and
 * default-review logic keys off this row existing.
 */
function passedJobs(operations: Array<'translate' | 'vision' | 'advisory'>): ModelRow['probes'] {
	return Object.fromEntries(operations.map((operation) => [operation, { operation, ok: true, at: 1 }]));
}

function chatRow(): ModelRow {
	return {
		id: 'qwen3.8-27b-q4',
		name: 'Qwen 3.8 27B',
		slug: 'qwen3.8-27b-q4',
		access: 'local_http',
		runtime: 'llamacpp',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		requestPreset: 'qwen-thinking',
		probes: passedJobs(['translate', 'vision']),
		seeded: false,
		operationsLocked: false,
	};
}

const CLI_FOUND =
	'CLI executable found; authentication and model availability are checked by the CLI when run';

function cli(id: CliToolAdminStatus['id'], found: boolean, extra: Partial<CliToolAdminStatus> = {}): CliToolAdminStatus {
	const label = id === 'grok' ? 'Grok' : id === 'codex' ? 'Codex' : 'Cursor';
	return {
		id,
		label,
		found,
		source: found ? 'automatic' : 'automatic',
		environmentOverride: false,
		saved: null,
		message: found ? CLI_FOUND : `${label} CLI not found.`,
		...extra,
	};
}

function missingAgents(): CliToolAdminStatus[] {
	return [cli('grok', false), cli('codex', false), cli('cursor', false)];
}

function remote(overrides: Partial<ModelRow> = {}): ModelRow {
	return {
		id: 'work-gpt4o',
		name: 'Work GPT-4o',
		slug: 'gpt-4o',
		access: 'remote_http',
		runtime: 'openai',
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		http: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
		probes: passedJobs(['translate']),
		seeded: false,
		operationsLocked: false,
		...overrides,
	};
}

/** A CLI row the way discovery/Add creates one. */
function cliRow(id: string, slug: string, cliAdapter: ModelRow['cliAdapter'], name = id): ModelRow {
	return {
		id,
		name,
		slug,
		access: 'cli',
		cliAdapter,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		probes: passedJobs(['translate']),
		seeded: false,
		operationsLocked: true,
	};
}

function deps(partial: Partial<SetupDeps> = {}): SetupDeps {
	const probed: string[] = [];
	const base: SetupDeps = {
		rows: [...SEED_ROWS, chatRow()],
		cli: missingAgents(),
		env: () => '',
		localBaseUrl: '',
		probeLocal: async (url) => {
			probed.push(url);
			return { ok: false };
		},
		installedReview: [],
		installedSpecialists: [],
		proofreadServiceSet: false,
	};
	const next = { ...base, ...partial };
	(next as SetupDeps & { probed: string[] }).probed = probed;
	if (!partial.probeLocal) {
		next.probeLocal = async (url) => {
			probed.push(url);
			return { ok: false };
		};
	} else {
		const inner = partial.probeLocal;
		next.probeLocal = async (url) => {
			probed.push(url);
			return inner(url);
		};
	}
	return Object.assign(next, { probed });
}

test('fresh install reports missing endpoint, agents, and task coverage', async () => {
	const report = await buildSetupReport(deps());
	assert.equal(report.items.find((item) => item.id === 'endpoint:local')?.state, 'missing');
	assert.equal(report.items.find((item) => item.id === 'cli:grok')?.state, 'missing');
	assert.equal(report.items.find((item) => item.id === 'capability:translate')?.state, 'missing');
	assert.equal(report.items.find((item) => item.id === 'capability:vision')?.state, 'missing');
	assert.equal(report.nextSteps[0]?.action, 'configure_endpoint');
	assert.ok(report.nextSteps.some((step) => step.action === 'install_agent'));
	assert.ok(report.summary.missing >= 3);
	// No review-capable model exists yet, so there is no review default to claim.
	assert.equal(report.items.find((item) => item.id === 'default:review'), undefined);
});

test('simulated local /models marks the endpoint ready and does not call chat completions', async () => {
	const setup = deps({
		localBaseUrl: 'http://127.0.0.1:19876/v1',
		probeLocal: async () => ({ ok: true, status: 200 }),
	});
	const report = await buildSetupReport(setup);
	assert.deepEqual((setup as SetupDeps & { probed: string[] }).probed, [
		'http://127.0.0.1:19876/v1/models',
	]);
	assert.equal(report.items.find((item) => item.id === 'endpoint:local')?.state, 'configured');
	assert.equal(report.items.find((item) => item.id === 'capability:translate')?.state, 'configured');
	assert.equal(report.items.find((item) => item.id === 'capability:vision')?.state, 'configured');
	assert.ok(report.items.find((item) => item.id === 'capability:translate')?.detail.includes('Qwen'));
});

test('unreachable simulated endpoint is unavailable, not treated as missing', async () => {
	const report = await buildSetupReport(
		deps({
			localBaseUrl: 'http://127.0.0.1:19876/v1',
			probeLocal: async () => ({ ok: false, status: 503 }),
		}),
	);
	const endpoint = report.items.find((item) => item.id === 'endpoint:local')!;
	assert.equal(endpoint.state, 'unavailable');
	assert.match(endpoint.detail, /503/);
	assert.equal(endpoint.next?.action, 'configure_endpoint');
});

test('remote row without a key asks for the env var; a set key is configured', async () => {
	const rows = [...SEED_ROWS, remote()];
	const missing = await buildSetupReport(deps({ rows, env: () => '' }));
	const item = missing.items.find((row) => row.id === 'remote:work-gpt4o')!;
	assert.equal(item.state, 'missing');
	assert.equal(item.next?.action, 'set_api_key');
	assert.match(item.detail, /OPENAI_API_KEY/);
	assert.doesNotMatch(item.detail, /sk-/);

	const ready = await buildSetupReport(
		deps({
			rows,
			env: (name) => (name === 'OPENAI_API_KEY' ? 'sk-test-not-used-for-inference' : ''),
		}),
	);
	assert.equal(ready.items.find((row) => row.id === 'remote:work-gpt4o')?.state, 'configured');
	assert.equal(ready.items.find((item) => item.id === 'capability:translate')?.state, 'configured');
});

test('a found CLI agent needs an added model row before it covers translation', async () => {
	// Discovering the binary is not the same as having a model: CLI rows are added,
	// not seeded, so translation stays unconfigured until a row exists.
	const found = await buildSetupReport(
		deps({
			cli: [cli('grok', true), cli('codex', false), cli('cursor', false)],
		}),
	);
	assert.equal(found.items.find((item) => item.id === 'cli:grok')?.state, 'configured');
	assert.equal(found.items.find((item) => item.id === 'capability:translate')?.state, 'missing');

	// Adding the discovered row is what makes the capability available.
	const withRow = await buildSetupReport(
		deps({
			cli: [cli('grok', true), cli('codex', false), cli('cursor', false)],
			rows: [...SEED_ROWS, chatRow(), cliRow('grok-4.6', 'grok-4.6', 'grok', 'Grok 4.6')],
		}),
	);
	assert.equal(withRow.items.find((item) => item.id === 'capability:translate')?.state, 'configured');
	// With the chat model down and exactly one ready translator, Komatose
	// defaults to it: the report says so instead of asking for a manual pick.
	const onlyOne = withRow.items.find((item) => item.id === 'default:translate');
	assert.equal(onlyOne?.state, 'configured');
	assert.match(onlyOne?.detail ?? '', /Grok 4\.6/);
	assert.equal(onlyOne?.next, undefined);
	// Review follows the same rule: exactly one review-capable model and it is
	// the default review model — not a warning telling the user to pick it.
	const onlyReviewer = withRow.items.find((item) => item.id === 'default:review');
	assert.equal(onlyReviewer?.state, 'configured');
	assert.match(onlyReviewer?.detail ?? '', /Grok 4\.6/);
	assert.equal(onlyReviewer?.next, undefined);

	const bad = await buildSetupReport(
		deps({
			cli: [
				cli('grok', false, {
					source: 'saved_setting',
					message: 'The saved Grok location was not found.',
				}),
				cli('codex', false),
				cli('cursor', false),
			],
		}),
	);
	assert.equal(bad.items.find((item) => item.id === 'cli:grok')?.state, 'unavailable');
	assert.equal(bad.items.find((item) => item.id === 'cli:grok')?.next?.action, 'install_agent');
});

test('with two ready translators and a dead default the report asks for a choice', async () => {
	const report = await buildSetupReport(
		deps({
			cli: [cli('grok', true), cli('codex', true), cli('cursor', false)],
			rows: [
				...SEED_ROWS,
				chatRow(),
				cliRow('grok-4.6', 'grok-4.6', 'grok', 'Grok 4.6'),
				cliRow('gpt-5.4', 'gpt-5.4', 'codex', 'GPT-5.4'),
			],
		}),
	);
	const item = report.items.find((row) => row.id === 'default:translate');
	assert.equal(item?.state, 'unavailable');
	assert.equal(item?.next?.action, 'select_model');
	assert.match(item?.next?.text ?? '', /Grok 4\.6|GPT-5\.4/);
	// With a real choice between review models, review keeps its warning too.
	const review = report.items.find((row) => row.id === 'default:review');
	assert.equal(review?.state, 'unavailable');
	assert.equal(review?.next?.action, 'select_model');
	assert.match(review?.next?.text ?? '', /Grok 4\.6|GPT-5\.4/);
});

test('setup checks stay free: no inference, catalog refresh or login modules', async () => {
	const reportSrc = await readFile(new URL('../src/lib/server/setupReport.ts', import.meta.url), 'utf8');
	const liveSrc = await readFile(new URL('../src/lib/server/setupLive.ts', import.meta.url), 'utf8');
	const apiSrc = await readFile(new URL('../src/routes/api/admin/setup/+server.ts', import.meta.url), 'utf8');
	for (const src of [reportSrc, liveSrc, apiSrc]) {
		assert.doesNotMatch(src, /modelProbe|probeModelRow|refreshLiveCatalog|proofreadServiceAvailable|proofreadWithService|chat\/completions/);
	}
	assert.throws(() => requireUser(null), /Unauthorized/);
	assert.throws(
		() => requireManageUsers({ id: 'u1', username: 'pat', role: 'translator' }),
		/Forbidden/,
	);
	requireManageUsers({ id: 'a1', username: 'root', role: 'admin' });
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});
