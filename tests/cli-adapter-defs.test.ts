import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
	CLI_ADAPTER_DEFS,
	cliAdapterDef,
	isCliAdapterDefId,
	isProductionCliAdapterId,
	PRODUCTION_CLI_ADAPTER_IDS,
} from '../src/lib/cliAdapterDefs';
import { CLI_ADAPTER_IDS, isCliAdapterId } from '../src/lib/modelRegistry';
import { CLI_PROVIDER_IDS, PROVIDER_CATALOG, PROVIDER_IDS, isCliProvider, providerById } from '../src/lib/providerCatalog';

const root = await mkdtemp(join(tmpdir(), 'scan-adapter-defs-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/scan.db');
await mkdir(join(root, 'data'), { recursive: true });

after(async () => {
	await rm(root, { recursive: true, force: true });
});

const NAME_CHECK = /=== ['"]example['"]|== ['"]example['"]/;

test('production lists are derived from adapter definitions and omit example', () => {
	assert.equal(cliAdapterDef('example')?.production, false);
	assert.equal(cliAdapterDef('example')?.operations.includes('advisory'), true);
	assert.equal(isCliAdapterDefId('example'), true);
	assert.equal(isProductionCliAdapterId('example'), false);
	assert.equal(isCliAdapterId('example'), false);
	assert.deepEqual([...PRODUCTION_CLI_ADAPTER_IDS], ['grok', 'codex', 'cursor']);
	assert.deepEqual([...CLI_ADAPTER_IDS], ['grok', 'codex', 'cursor']);
	assert.deepEqual([...PROVIDER_IDS], ['qwen', 'grok', 'codex', 'cursor', 'proofreader-a', 'proofreader-b']);
	assert.deepEqual([...CLI_PROVIDER_IDS], ['grok', 'codex', 'cursor']);
	assert.equal(PROVIDER_CATALOG.length, 6);
	assert.equal(providerById('example'), undefined);
	assert.equal(isCliProvider('example'), false);
	assert.equal(providerById('grok')?.label, cliAdapterDef('grok')?.catalogLabel);
	assert.equal('operations' in providerById('codex')!, false);
	assert.equal('operations' in providerById('grok')!, false);
});

test('example discovery uses definition metadata with no extra provider-name check', async () => {
	const { discoverCli, executablePath, OVERRIDE_VARS, CLI_COMMAND, CLI_LABEL } = await import(
		'../src/lib/server/cliDiscovery'
	);
	const { validateCliToolId, CliToolsConfigError } = await import('../src/lib/server/cliToolSettings');
	const { listCliToolAdminStatus } = await import('../src/lib/server/cliToolStatus');
	const { buildSetupReport } = await import('../src/lib/server/setupReport');

	assert.deepEqual([...OVERRIDE_VARS.example], [...cliAdapterDef('example')!.discovery.overrideVars]);
	assert.equal(CLI_COMMAND.example, 'example-cli');
	assert.equal(CLI_LABEL.example, 'Example');

	const bin = join(root, 'example-cli');
	await writeFile(bin, `#!${process.execPath}\n`, { mode: 0o755 });
	await chmod(bin, 0o755);
	const previous = process.env.EXAMPLE_BIN;
	process.env.EXAMPLE_BIN = bin;
	try {
		const found = discoverCli('example');
		assert.equal(found.status, 'found', found.reason);
		assert.equal(executablePath(found), bin);
		assert.equal(found.source, 'override');
	} finally {
		if (previous === undefined) delete process.env.EXAMPLE_BIN;
		else process.env.EXAMPLE_BIN = previous;
	}

	assert.throws(() => validateCliToolId('example'), CliToolsConfigError);
	const admin = listCliToolAdminStatus();
	assert.deepEqual(
		admin.map((item) => item.id),
		['grok', 'codex', 'cursor'],
	);

	const report = await buildSetupReport({
		rows: [],
		cli: admin,
		env: () => '',
		localBaseUrl: '',
		probeLocal: async () => ({ ok: false }),
		installedReview: [],
		installedSpecialists: [],
		proofreadServiceSet: false,
	});
	assert.equal(
		report.items.some((item) => item.id === 'cli:example' || /example/i.test(item.label)),
		false,
	);

	const { isCliEngine } = await import('../src/lib/server/cliTranslate');
	assert.equal(isCliEngine('example'), false);
	assert.equal(isCliEngine('grok'), true);
});

test('derived modules have no extra example provider-name checks', () => {
	const files = [
		'src/lib/server/cliDiscovery.ts',
		'src/lib/server/cliToolSettings.ts',
		'src/lib/server/cliToolStatus.ts',
		'src/lib/server/setupReport.ts',
		'src/lib/providerCatalog.ts',
		'src/lib/modelRegistry.ts',
		'src/lib/server/engineReadiness.ts',
		'src/lib/server/registryPicker.ts',
		'src/lib/server/modelCatalogs.ts',
		'src/lib/server/cliTranslate.ts',
	];
	for (const file of files) {
		const text = readFileSync(join(process.cwd(), file), 'utf8');
		assert.doesNotMatch(text, NAME_CHECK, file);
	}
});
