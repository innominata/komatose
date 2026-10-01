import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CliAdapterRegistry } from '../src/lib/server/cliAdapters/registry';
import { createCodexAdapter } from '../src/lib/server/cliAdapters/codex';
import { createGrokAdapter } from '../src/lib/server/cliAdapters/grok';
import { createCursorAdapter } from '../src/lib/server/cliAdapters/cursor';
import { createExampleAdapter } from '../src/lib/server/cliAdapters/example';
import type { AdvisoryRequest, CliAdapter, Command, CommandResult, CommandRuntime } from '../src/lib/server/cliAdapters/types';

const request: AdvisoryRequest = {
	system: 'Review',
	prompt: 'Question',
	images: [],
	schema: { type: 'object' },
};

const OK = '{"answer":"ok"}';

type RunMode = 'ok' | 'malformed' | 'nonzero' | 'hang' | 'timeout';

function commandRuntime(mode: RunMode, onRun: () => void): CommandRuntime {
	return {
		parse: JSON.parse,
		async run(command: Command): Promise<CommandResult> {
			onRun();
			if (mode === 'hang') {
				return new Promise((_, reject) => {
					const timer = setTimeout(() => reject(new Error('CLI timed out')), 40);
					command.abort?.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							reject(new Error('Cancelled'));
						},
						{ once: true },
					);
				});
			}
			if (mode === 'timeout') throw new Error(`${command.bin} timed out`);
			if (mode === 'nonzero') return { code: 1, stdout: '', stderr: 'boom' };
			if (mode === 'malformed') return { code: 0, stdout: 'not-json', stderr: '' };
			return { code: 0, stdout: OK, stderr: '' };
		},
	};
}

const baseOptions = {
	executable: (): string | null => '/fake/agent',
	defaultModel: () => 'default-model',
	listModels: async () => [{ id: 'default-model', label: 'Default' }],
};

function spySibling(calls: { n: number }): CliAdapter {
	return {
		id: 'other',
		label: 'Other',
		supportsImages: true,
		executable: () => '/fake/other',
		defaultModel: () => 'other-model',
		listModels: async () => [],
		advisory: async () => {
			calls.n += 1;
			return { switched: true };
		},
	};
}

/** Reusable contract: every CliAdapter, including a new factory, must pass these cases. */
export function runCliAdapterContract(
	name: string,
	create: (runtime: CommandRuntime, options?: Partial<typeof baseOptions>) => CliAdapter,
	opts: { supportsImages: boolean; cursor?: boolean } = { supportsImages: true },
) {
	function adapterFor(mode: RunMode, onRun: () => void, options?: Partial<typeof baseOptions>) {
		if (opts.cursor) {
			return createCursorAdapter(
				{ ...baseOptions, ...options },
				{
					parse: JSON.parse,
					async prompt({ abort }) {
						onRun();
						if (mode === 'hang') {
							return new Promise((_, reject) => {
								const timer = setTimeout(() => reject(new Error('CLI timed out')), 40);
								abort?.addEventListener(
									'abort',
									() => {
										clearTimeout(timer);
										reject(new Error('Cancelled'));
									},
									{ once: true },
								);
							});
						}
						if (mode === 'timeout') throw new Error('cursor-agent timed out');
						if (mode === 'nonzero') throw new Error('cursor exited 1: boom');
						if (mode === 'malformed') return 'not-json';
						return OK;
					},
				},
			);
		}
		return create(commandRuntime(mode, onRun), options);
	}

	test(`${name}: valid id, default model, and advisory output`, async () => {
		let runs = 0;
		const adapter = adapterFor('ok', () => {
			runs += 1;
		});
		assert.match(adapter.id, /^[a-z][a-z0-9-]*$/);
		assert.equal(adapter.supportsImages, opts.supportsImages);
		const registry = new CliAdapterRegistry([adapter]);
		assert.equal(registry.has(adapter.id), true);
		assert.equal(registry.has('missing'), false);
		assert.deepEqual(await registry.advisory(adapter.id, request), { answer: 'ok' });
		assert.deepEqual(await registry.advisory(adapter.id, { ...request, model: 'chosen' }), { answer: 'ok' });
		assert.equal(runs, 2);
	});

	test(`${name}: unavailable program fails clearly and does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		let runs = 0;
		const adapter = adapterFor(
			'ok',
			() => {
				runs += 1;
			},
			{ executable: () => null },
		);
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory(adapter.id, request), /not found/);
		assert.equal(runs, 0);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: cancellation fails clearly and does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		let runs = 0;
		const adapter = adapterFor('ok', () => {
			runs += 1;
		});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory(adapter.id, { ...request, abort: AbortSignal.abort() }), /abort|Cancel/i);
		assert.equal(runs, 0);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: hang respects abort timeout and does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		const adapter = adapterFor('hang', () => {});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(
			registry.advisory(adapter.id, { ...request, abort: AbortSignal.timeout(20) }),
			/timed out|Cancel/i,
		);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: timeout error fails clearly and does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		const adapter = adapterFor('timeout', () => {});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory(adapter.id, request), /timed out/);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: malformed output fails clearly and does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		const adapter = adapterFor('malformed', () => {});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory(adapter.id, request), /JSON|Unexpected token|not-json/i);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: nonzero exit does not switch providers`, async () => {
		const siblingCalls = { n: 0 };
		const adapter = adapterFor('nonzero', () => {});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory(adapter.id, request), /exited 1|boom/);
		assert.equal(siblingCalls.n, 0);
	});

	test(`${name}: unknown adapter id does not fall through to another provider`, async () => {
		const siblingCalls = { n: 0 };
		const adapter = adapterFor('ok', () => {});
		const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
		await assert.rejects(registry.advisory('chatgpt', request), /Unknown CLI adapter/);
		assert.equal(siblingCalls.n, 0);
	});

	if (!opts.supportsImages) {
		test(`${name}: image requests fail without running or switching`, async () => {
			const siblingCalls = { n: 0 };
			let runs = 0;
			const adapter = adapterFor('ok', () => {
				runs += 1;
			});
			const registry = new CliAdapterRegistry([adapter, spySibling(siblingCalls)]);
			await assert.rejects(
				registry.advisory(adapter.id, { ...request, images: [Buffer.from('x')] }),
				/does not support image/,
			);
			assert.equal(runs, 0);
			assert.equal(siblingCalls.n, 0);
		});
	}
}

runCliAdapterContract(
	'example',
	(runtime, options) => createExampleAdapter({ ...baseOptions, ...options }, runtime),
	{ supportsImages: false },
);

runCliAdapterContract('grok', (runtime, options) =>
	createGrokAdapter(
		{ ...baseOptions, ...options },
		{
			...runtime,
			headlessArgs: () => ['--no-memory'],
			imagePromptArgs: async () => [],
		},
	),
);

runCliAdapterContract('codex', (runtime, options) => createCodexAdapter({ ...baseOptions, ...options }, runtime));

runCliAdapterContract(
	'cursor',
	() => {
		throw new Error('cursor uses prompt runtime');
	},
	{ supportsImages: true, cursor: true },
);

test('example adapter is not registered in production', async () => {
	const { mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const dir = await mkdtemp(join(tmpdir(), 'scan-example-'));
	const keys = ['SCAN_ROOT', 'SCAN_DATA_DIR', 'DATABASE_URL'] as const;
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		process.env.SCAN_ROOT = dir;
		process.env.SCAN_DATA_DIR = join(dir, 'data');
		process.env.DATABASE_URL = join(dir, 'data/scan.db');
		const { isCliEngine } = await import('../src/lib/server/cliTranslate');
		assert.equal(isCliEngine('grok'), true);
		assert.equal(isCliEngine('codex'), true);
		assert.equal(isCliEngine('cursor'), true);
		assert.equal(isCliEngine('example'), false);
		assert.equal(isCliEngine('chatgpt'), false);
	} finally {
		for (const key of keys) {
			const value = saved.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(dir, { recursive: true, force: true });
	}
});
