import { decisionThreshold, DECIDER_MIN_PROBABILITY, DECIDER_MIN_MARGIN } from './decider';
import type { TaskEngine } from './aiTasks';
import { MAX_SOURCE_REVIEWERS } from './localReviewModels';
import {
	isCliAdapterId,
	isReservedLegacyHost,
	rowForReviewer,
	rowHasOperation,
	visionEligible,
	type ModelRow,
} from './modelRegistry';
import { isProofreaderId } from './proofreaders';
import { QWEN_38_27B_ID } from './qwenModels';
import { MAX_TRANSCRIPTION_MODELS, type RegionAiSettings } from './regionAi';

export const PROFILE_FIELDS = [
	'translate',
	'proofread',
	'reviewers',
	'transcriptionModels',
	'transcriptionDecider',
	'deciderMinProbability',
	'deciderMinMargin',
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export type ModelRef = { engine: string; model: string };

export type ModelProfileSelections = {
	translate: ModelRef;
	proofread: ModelRef;
	reviewers: ModelRef[];
	transcriptionModels: string[];
	transcriptionDecider?: ModelRef | null;
	deciderMinProbability?: number;
	deciderMinMargin?: number;
};

export type ModelProfile = {
	id: string;
	name: string;
	updatedAt: number;
	selections: ModelProfileSelections;
};

export type ProfileIssue = {
	field: ProfileField;
	ref: string;
	status: 'missing' | 'disabled' | 'unsupported' | 'invalid';
	message: string;
};

export class ModelProfileError extends Error {
	issues?: ProfileIssue[];
	constructor(message: string, issues?: ProfileIssue[]) {
		super(message);
		this.name = 'ModelProfileError';
		this.issues = issues;
	}
}

const FIELD_LABEL: Record<ProfileField, string> = {
	translate: 'Translation',
	proofread: 'Proofreading',
	reviewers: 'Source reviewer',
	transcriptionModels: 'Transcription',
	transcriptionDecider: 'Transcription decider',
	deciderMinProbability: 'Decider minimum probability',
	deciderMinMargin: 'Decider minimum lead',
};

const MAX_NAME = 80;

export function cloneModelRef(ref: ModelRef): ModelRef {
	return { engine: ref.engine, model: ref.model };
}

function deciderSelections(s: Partial<ModelProfileSelections>): Partial<ModelProfileSelections> {
	return {
		...(s.transcriptionDecider !== undefined ? { transcriptionDecider: s.transcriptionDecider === null ? null : parseModelRef(s.transcriptionDecider, 'Transcription decider') } : {}),
		...(s.deciderMinProbability !== undefined ? { deciderMinProbability: decisionThreshold(s.deciderMinProbability, DECIDER_MIN_PROBABILITY) } : {}),
		...(s.deciderMinMargin !== undefined ? { deciderMinMargin: decisionThreshold(s.deciderMinMargin, DECIDER_MIN_MARGIN) } : {}),
	};
}

export function cloneProfileSelections(selections: ModelProfileSelections): ModelProfileSelections {
	return {
		translate: cloneModelRef(selections.translate),
		proofread: cloneModelRef(selections.proofread),
		reviewers: selections.reviewers.map(cloneModelRef),
		transcriptionModels: [...selections.transcriptionModels],
		...deciderSelections(selections),
	};
}

export function publicModelProfile(profile: ModelProfile): ModelProfile {
	return {
		id: profile.id,
		name: profile.name,
		updatedAt: profile.updatedAt,
		selections: cloneProfileSelections(profile.selections),
	};
}

function assertPlainObject(raw: unknown, message: string): Record<string, unknown> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ModelProfileError(message);
	}
	return raw as Record<string, unknown>;
}

/** Keep engine + slug only. Drop credentials, paths, and other extras. */
export function parseModelRef(raw: unknown, label: string): ModelRef {
	const rec = assertPlainObject(raw, `${label} must be a model id, not a credential or path.`);
	if (typeof rec.engine !== 'string') {
		throw new ModelProfileError(`${label} must use a model id string.`);
	}
	const engine = rec.engine.trim();
	if (!engine) throw new ModelProfileError(`Choose a ${label.toLowerCase()} model.`);
	if (typeof rec.model === 'number') {
		throw new ModelProfileError(`${label} slug must be a string.`);
	}
	const model = typeof rec.model === 'string' ? rec.model.trim() : '';
	return { engine, model };
}

function parseTranscriptionIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		throw new ModelProfileError('Transcription models must be a list of model ids.');
	}
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		if (typeof item !== 'string') {
			throw new ModelProfileError('Transcription models must be model id strings.');
		}
		const id = item.trim();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		ids.push(id);
		if (ids.length > MAX_TRANSCRIPTION_MODELS) {
			throw new ModelProfileError(`Choose at most ${MAX_TRANSCRIPTION_MODELS} transcription models.`);
		}
	}
	if (!ids.length) {
		throw new ModelProfileError('Choose at least one transcription model.');
	}
	return ids;
}

export function parseProfileSelections(raw: unknown): ModelProfileSelections {
	const rec = assertPlainObject(raw, 'A profile must store model references only.');
	const reviewersRaw = rec.reviewers;
	if (reviewersRaw != null && !Array.isArray(reviewersRaw)) {
		throw new ModelProfileError('Review Transcription must be a list of model references.');
	}
	if (Array.isArray(reviewersRaw) && reviewersRaw.length > MAX_SOURCE_REVIEWERS) {
		throw new ModelProfileError(`Choose at most ${MAX_SOURCE_REVIEWERS} transcription reviewers.`);
	}
	return {
		translate: parseModelRef(rec.translate, 'Translation'),
		proofread: parseModelRef(rec.proofread, 'Proofreading'),
		reviewers: Array.isArray(reviewersRaw)
			? reviewersRaw.map((item, i) => parseModelRef(item, `Reviewer ${i + 1}`))
			: [],
		transcriptionModels: parseTranscriptionIds(rec.transcriptionModels),
		...deciderSelections(rec as Partial<ModelProfileSelections>),
	};
}

export function snapshotProfileSelections(
	settings: Partial<Pick<RegionAiSettings, 'translate' | 'proofread' | 'reviewers' | 'transcriptionModels' | 'transcriptionDecider' | 'deciderMinProbability' | 'deciderMinMargin'>>,
): ModelProfileSelections {
	return parseProfileSelections({
		translate: settings.translate,
		proofread: settings.proofread,
		reviewers: settings.reviewers ?? [],
		transcriptionModels: settings.transcriptionModels ?? [],
		...deciderSelections(settings),
	});
}

export function normalizeProfileName(raw: unknown): string {
	if (typeof raw !== 'string') throw new ModelProfileError('Choose a profile name.');
	const name = raw.trim().replace(/\s+/g, ' ');
	if (!name) throw new ModelProfileError('Choose a profile name.');
	if (name.length > MAX_NAME) throw new ModelProfileError('Profile name is too long.');
	if (/[\n\r\0]/.test(raw)) throw new ModelProfileError('Profile name must be a single line.');
	return name;
}

function rowById(rows: readonly ModelRow[], id: string): ModelRow | undefined {
	return rows.find((row) => row.id === id);
}

/** Resolve a stored ref to a registry row without falling through to another model. */
export function profileRowForRef(
	ref: ModelRef,
	rows: readonly ModelRow[],
): { row?: ModelRow; missing: boolean } {
	const byId = rowById(rows, ref.engine);
	if (byId) return { row: byId, missing: false };
	if (isCliAdapterId(ref.engine)) {
		if (ref.model) {
			const match = rows.find((row) => row.cliAdapter === ref.engine && row.slug === ref.model);
			if (match) return { row: match, missing: false };
		}
		return { missing: true };
	}
	if (isProofreaderId(ref.engine)) {
		const browser = rows.find((row) => row.id === ref.engine);
		return browser ? { row: browser, missing: false } : { missing: true };
	}
	if (ref.engine === 'qwen') {
		if (!ref.model) {
			const fallback = rowById(rows, QWEN_38_27B_ID);
			return fallback ? { row: fallback, missing: false } : { missing: true };
		}
		const named = rowById(rows, ref.model) || rows.find((row) => row.slug === ref.model);
		if (named) return { row: named, missing: false };
		return { missing: true };
	}
	if (isReservedLegacyHost(ref.engine)) return { missing: true };
	return { missing: true };
}

function issue(
	field: ProfileField,
	ref: string,
	status: ProfileIssue['status'],
	message: string,
): ProfileIssue {
	return { field, ref, status, message };
}

function refLabel(ref: ModelRef): string {
	return ref.model && ref.model !== ref.engine ? `${ref.engine} (${ref.model})` : ref.engine;
}

function checkTaskRef(
	field: 'translate' | 'proofread' | 'reviewers' | 'transcriptionDecider',
	ref: ModelRef,
	rows: readonly ModelRow[],
	supported: (row: ModelRow) => boolean,
	taskLabel: string,
): ProfileIssue | undefined {
	const found = profileRowForRef(ref, rows);
	const label = FIELD_LABEL[field];
	if (found.missing) {
		return issue(field, refLabel(ref), 'missing', `${label} ${refLabel(ref)} is not in the model registry.`);
	}
	if (!found.row) return undefined;
	if (found.row.disabled) {
		return issue(field, found.row.id, 'disabled', `${label} ${found.row.name} is disabled.`);
	}
	if (!supported(found.row)) {
		return issue(
			field,
			found.row.id,
			'unsupported',
			`${found.row.name} cannot be used for ${taskLabel}.`,
		);
	}
	return undefined;
}

export function validateProfileSelections(
	selections: ModelProfileSelections,
	rows: readonly ModelRow[],
): ProfileIssue[] {
	const issues: ProfileIssue[] = [];
	if (selections.transcriptionDecider) {
		const problem = checkTaskRef('transcriptionDecider', selections.transcriptionDecider, rows, row => rowHasOperation(row, 'sourceDecide'), 'decide transcription');
		if (problem) issues.push(problem);
	}
	const translate = checkTaskRef(
		'translate',
		selections.translate,
		rows,
		(row) => rowHasOperation(row, 'translate'),
		'translation',
	);
	if (translate) issues.push(translate);
	const proofread = checkTaskRef(
		'proofread',
		selections.proofread,
		rows,
		(row) => rowHasOperation(row, ['proofreadEnglish', 'pageImageProofread']),
		'proofreading',
	);
	if (proofread) issues.push(proofread);
	if (selections.reviewers.length > MAX_SOURCE_REVIEWERS) {
		issues.push(
			issue(
				'reviewers',
				String(selections.reviewers.length),
				'invalid',
				`Choose at most ${MAX_SOURCE_REVIEWERS} transcription reviewers.`,
			),
		);
	}
	for (const reviewer of selections.reviewers) {
		const next = checkTaskRef('reviewers', reviewer, rows, rowForReviewer, 'source review');
		if (next) issues.push(next);
	}
	if (!selections.transcriptionModels.length) {
		issues.push(
			issue(
				'transcriptionModels',
				'',
				'invalid',
				'Choose at least one transcription model.',
			),
		);
	}
	if (selections.transcriptionModels.length > MAX_TRANSCRIPTION_MODELS) {
		issues.push(
			issue(
				'transcriptionModels',
				String(selections.transcriptionModels.length),
				'invalid',
				`Choose at most ${MAX_TRANSCRIPTION_MODELS} transcription models.`,
			),
		);
	}
	for (const id of selections.transcriptionModels) {
		const row = rowById(rows, id);
		if (!row) {
			issues.push(
				issue(
					'transcriptionModels',
					id,
					'missing',
					`Transcription ${id} is not in the model registry.`,
				),
			);
			continue;
		}
		if (row.disabled) {
			issues.push(
				issue('transcriptionModels', id, 'disabled', `Transcription ${row.name} is disabled.`),
			);
			continue;
		}
		if (!visionEligible(row)) {
			issues.push(
				issue(
					'transcriptionModels',
					id,
					'unsupported',
					`${row.name} cannot be used for transcription.`,
				),
			);
		}
	}
	return issues;
}

export function mergeProfileIntoSettings(
	current: RegionAiSettings,
	selections: ModelProfileSelections,
): RegionAiSettings {
	const { transcriptionDecider, deciderMinProbability, deciderMinMargin, ...rest } = current;
	return {
		...rest,
		translate: cloneModelRef(selections.translate),
		proofread: cloneModelRef(selections.proofread),
		reviewers: selections.reviewers.map(cloneModelRef),
		transcriptionModels: [...selections.transcriptionModels],
		...deciderSelections(selections),
	};
}

export function applyProfileSelections(
	current: RegionAiSettings,
	selections: ModelProfileSelections,
	rows: readonly ModelRow[],
): { ok: true; settings: RegionAiSettings; issues: [] } | { ok: false; settings: RegionAiSettings; issues: ProfileIssue[] } {
	const parsed = parseProfileSelections(selections);
	const issues = validateProfileSelections(parsed, rows);
	if (issues.length) {
		return {
			ok: false,
			settings: {
				...current,
				translate: { ...current.translate },
				describe: { ...current.describe },
				vision: { ...current.vision },
				proofread: { ...current.proofread },
				enquire: { ...current.enquire },
				reviewers: current.reviewers.map((item) => ({ ...item })),
				reviseModels: current.reviseModels.map((item) => ({ ...item })),
				transcriptionModels: [...current.transcriptionModels],
			},
			issues,
		};
	}
	return { ok: true, settings: mergeProfileIntoSettings(current, parsed), issues: [] };
}

export function profileIssueSummary(issues: ProfileIssue[]): string {
	if (!issues.length) return '';
	return issues.map((item) => item.message).join(' ');
}
