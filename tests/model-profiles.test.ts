import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CHAT_AND_CLI_OPERATIONS, SEED_ROWS, type ModelRow } from '../src/lib/modelRegistry';
import { QWEN_38_27B_ID } from '../src/lib/qwenModels';
import { regionAiSettings } from '../src/lib/regionAi';
import {
	ModelProfileError,
	applyProfileSelections,
	parseProfileSelections,
	snapshotProfileSelections,
	validateProfileSelections,
} from '../src/lib/modelProfiles';

const root = await mkdtemp(join(tmpdir(), 'scan-model-profiles-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data', 'test.db');
await mkdir(join(root, 'data'), { recursive: true });

const {
	applyModelProfileAction,
	deleteModelProfile,
	modelProfilesPath,
	readModelProfiles,
	saveModelProfile,
	writeModelProfiles,
} = await import('../src/lib/server/modelProfileStore');
const { requireEdit, requireUser } = await import('../src/lib/server/http');

after(() => rm(root, { recursive: true, force: true }));

const localSelections = {
	translate: { engine: QWEN_38_27B_ID, model: '' },
	proofread: { engine: QWEN_38_27B_ID, model: '' },
	reviewers: [{ engine: 'hayai-ocr-v2', model: '' }],
	transcriptionModels: ['hayai-ocr-v2', 'paddleocr-vl-1.6'],
};

/**
 * CLI models are discovered, not seeded, so a profile that names one is only
 * valid once the row exists. Build the rows the way discovery/Add would.
 */
function cliRow(id: string, slug: string, cliAdapter: ModelRow['cliAdapter'], name = id): ModelRow {
	return {
		id,
		name,
		slug,
		access: 'cli',
		cliAdapter,
		operations: [...CHAT_AND_CLI_OPERATIONS],
		roles: ['admin', 'translator', 'proofreader', 'typesetter'],
		seeded: false,
		operationsLocked: true,
	};
}
const discoveredRows: ModelRow[] = [
	...SEED_ROWS,
	cliRow('grok-4.6', 'grok-4.6', 'grok', 'Grok 4.6'),
	cliRow('gpt-5.4', 'gpt-5.4', 'codex', 'GPT-5.4'),
	cliRow('composer-2.5', 'composer-2.5', 'cursor', 'Composer 2.5')
];

const cliSelections = {
	translate: { engine: 'grok-4.6', model: '' },
	proofread: { engine: 'gpt-5.4', model: '' },
	reviewers: [{ engine: 'composer-2.5', model: '' }],
	transcriptionModels: [QWEN_38_27B_ID],
};

function currentSettings() {
	return regionAiSettings({
		translate: { engine: 'composer-2.5', model: '' },
		describe: { engine: 'qwen3-vl-8b', model: '' },
		vision: { engine: 'qwen3-vl-8b', model: '' },
		proofread: { engine: 'composer-2.5', model: '' },
		enquire: { engine: 'composer-2.5', model: '' },
		reviewers: [{ engine: 'composer-2.5', model: '' }],
		transcriptionModels: ['grok-4.6'],
	});
}

function resetProfiles() {
	if (existsSync(modelProfilesPath())) unlinkSync(modelProfilesPath());
}

function disabledRows(id: string, base = SEED_ROWS) {
	return base.map((row) => (row.id === id ? { ...row, disabled: true } : row));
}

describe('model profiles', { concurrency: 1 }, () => {
	test('missing file is an empty list; save stores model references only', async () => {
		resetProfiles();
		assert.deepEqual(readModelProfiles(), []);
		const profile = saveModelProfile({
			name: 'Local only',
			selections: {
				...localSelections,
				translate: {
					...localSelections.translate,
					apiKey: 'sk-secret',
					path: '/opt/grok',
					executable: '/usr/bin/grok',
				},
			},
		});
		assert.equal(profile.name, 'Local only');
		assert.deepEqual(profile.selections.translate, localSelections.translate);
		assert.deepEqual(profile.selections.proofread, localSelections.proofread);
		assert.deepEqual(profile.selections.reviewers, localSelections.reviewers);
		assert.deepEqual(profile.selections.transcriptionModels, localSelections.transcriptionModels);
		const saved = JSON.parse(await readFile(modelProfilesPath(), 'utf8'));
		const text = JSON.stringify(saved);
		assert.equal(text.includes('sk-secret'), false);
		assert.equal(text.includes('/opt/grok'), false);
		assert.equal(text.includes('/usr/bin/grok'), false);
		assert.equal(text.includes('apiKey'), false);
		assert.equal(text.includes('executable'), false);
		assert.deepEqual(Object.keys(saved.profiles[0].selections.translate).sort(), ['engine', 'model']);
	});

	test('saving, switching and deleting profiles leaves other series fields alone', () => {
		resetProfiles();
		const local = saveModelProfile({ name: 'Local only', selections: localSelections });
		const cli = saveModelProfile({ name: 'CLI agents', selections: cliSelections });
		assert.equal(readModelProfiles().length, 2);

		const before = currentSettings();
		const applied = applyProfileSelections(before, local.selections, SEED_ROWS);
		assert.equal(applied.ok, true);
		assert.deepEqual(applied.settings.translate, localSelections.translate);
		assert.deepEqual(applied.settings.proofread, localSelections.proofread);
		assert.deepEqual(applied.settings.reviewers, localSelections.reviewers);
		assert.deepEqual(applied.settings.transcriptionModels, localSelections.transcriptionModels);
		assert.deepEqual(applied.settings.describe, before.describe);
		assert.deepEqual(applied.settings.vision, before.vision);
		assert.deepEqual(applied.settings.enquire, before.enquire);

		const switched = applyProfileSelections(applied.settings, cli.selections, discoveredRows);
		assert.equal(switched.ok, true);
		assert.deepEqual(switched.settings.translate, cliSelections.translate);
		assert.deepEqual(switched.settings.describe, before.describe);

		const remaining = deleteModelProfile(local.id);
		assert.equal(remaining.length, 1);
		assert.equal(remaining[0].id, cli.id);
		assert.deepEqual(remaining[0].selections, cliSelections);
		assert.throws(() => deleteModelProfile(local.id), ModelProfileError);
	});

	test('validate reports missing and disabled models and apply does not substitute', () => {
		const before = currentSettings();
		const missing = applyProfileSelections(
			before,
			{
				translate: { engine: 'deleted-row', model: '' },
				proofread: localSelections.proofread,
				reviewers: localSelections.reviewers,
				transcriptionModels: ['missing-ocr'],
			},
			SEED_ROWS,
		);
		assert.equal(missing.ok, false);
		assert.deepEqual(missing.settings, before);
		assert.ok(missing.issues.some((item) => item.field === 'translate' && item.status === 'missing'));
		assert.ok(
			missing.issues.some((item) => item.field === 'transcriptionModels' && item.status === 'missing'),
		);
		assert.notEqual(missing.settings.translate.engine, QWEN_38_27B_ID);

		const disabled = applyProfileSelections(before, cliSelections, disabledRows('grok-4.6', discoveredRows));
		assert.equal(disabled.ok, false);
		assert.deepEqual(disabled.settings.translate, before.translate);
		assert.ok(disabled.issues.some((item) => item.ref === 'grok-4.6' && item.status === 'disabled'));
		assert.deepEqual(disabled.settings.transcriptionModels, before.transcriptionModels);

		const leftover = applyProfileSelections(
			before,
			{
				translate: { engine: 'qwen', model: 'gone-local-model' },
				proofread: localSelections.proofread,
				reviewers: [],
				transcriptionModels: ['hayai-ocr-v2'],
			},
			SEED_ROWS,
		);
		assert.equal(leftover.ok, false);
		assert.ok(leftover.issues.some((item) => item.status === 'missing'));
		assert.deepEqual(leftover.settings.translate, before.translate);
	});

	test('unsupported models and empty transcription fail without filling defaults', () => {
		const before = currentSettings();
		const unsupported = applyProfileSelections(
			before,
			{
				translate: { engine: 'hayai-ocr-v2', model: '' },
				proofread: { engine: 'proofreader-a', model: '' },
				reviewers: [{ engine: QWEN_38_27B_ID, model: '' }],
				transcriptionModels: [QWEN_38_27B_ID],
			},
			SEED_ROWS,
		);
		assert.equal(unsupported.ok, false);
		assert.ok(unsupported.issues.some((item) => item.field === 'translate' && item.status === 'unsupported'));
		assert.deepEqual(unsupported.settings, before);

		assert.throws(
			() =>
				snapshotProfileSelections({
					translate: localSelections.translate,
					proofread: localSelections.proofread,
					reviewers: [],
					transcriptionModels: [],
				}),
			ModelProfileError,
		);
		const emptyTranscribe = validateProfileSelections(
			parseProfileSelections({
				...localSelections,
				transcriptionModels: ['hayai-ocr-v2'],
			}),
			SEED_ROWS,
		);
		assert.deepEqual(emptyTranscribe, []);
		assert.throws(() => parseProfileSelections({ ...localSelections, transcriptionModels: [] }), /at least one|Choose a/i);
		const issues = validateProfileSelections(
			{
				...localSelections,
				transcriptionModels: [],
			},
			SEED_ROWS,
		);
		assert.ok(issues.some((item) => item.field === 'transcriptionModels' && item.status === 'invalid'));
		assert.equal(
			issues.some((item) => item.message.includes('hayai-ocr-v2') && item.status === 'invalid'),
			false,
		);
	});

	test('store save/validate/delete and malformed files; numeric engines rejected', async () => {
		resetProfiles();
		const saved = applyModelProfileAction('save', { name: 'Local only', selections: localSelections });
		assert.equal(saved.profile?.name, 'Local only');
		const validated = applyModelProfileAction('validate', { id: saved.profile?.id }, SEED_ROWS);
		assert.deepEqual(validated.issues, []);
		const updated = applyModelProfileAction('save', {
			name: 'Local only',
			selections: {
				...localSelections,
				proofread: { engine: 'qwen3-vl-8b', model: '' },
			},
		});
		assert.equal(updated.profiles.length, 1);
		assert.equal(updated.profile?.selections.proofread.engine, 'qwen3-vl-8b');

		assert.throws(
			() =>
				saveModelProfile({
					name: 'Broken',
					selections: { ...localSelections, translate: { engine: 12, model: '' } },
				}),
			ModelProfileError,
		);

		await writeFile(modelProfilesPath(), '[]\n');
		assert.throws(() => readModelProfiles(), ModelProfileError);
		writeModelProfiles([]);
		assert.deepEqual(readModelProfiles(), []);

		assert.throws(() => requireUser(null), /Unauthorized/);
		assert.throws(
			() => requireEdit({ id: 'u1', username: 'pat', role: 'typesetter' }),
			/Forbidden/,
		);
		requireEdit({ id: 't1', username: 'lee', role: 'translator' });
		requireEdit({ id: 'a1', username: 'root', role: 'admin' });
	});
});
