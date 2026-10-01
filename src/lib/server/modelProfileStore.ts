/**
 * Named model-selection profiles. Model references only — no credentials or
 * executable paths. Missing file means no profiles.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { invalidateRegistryCache, listRegistryRows } from './modelRegistryStore';
import { recoverPackApply } from './modelPackJournal';
import {
	ModelProfileError,
	cloneProfileSelections,
	normalizeProfileName,
	parseProfileSelections,
	publicModelProfile,
	validateProfileSelections,
	type ModelProfile,
	type ModelProfileSelections,
	type ProfileIssue,
} from '../modelProfiles';
import type { ModelRow } from '../modelRegistry';

export const MAX_PROFILES = 50;

export function modelProfilesPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'model-profiles.json');
}

function emptyFile(): { profiles: ModelProfile[] } {
	return { profiles: [] };
}

function parseStoredProfile(raw: unknown, index: number): ModelProfile {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ModelProfileError(`Profile ${index + 1} must be an object of model references.`);
	}
	const rec = raw as Record<string, unknown>;
	const selectionsRaw = rec.selections && typeof rec.selections === 'object' ? rec.selections : rec;
	const id = typeof rec.id === 'string' ? rec.id.trim() : '';
	if (!id) throw new ModelProfileError(`Profile ${index + 1} is missing an id.`);
	const updatedAt = typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0;
	return {
		id,
		name: normalizeProfileName(rec.name),
		updatedAt,
		selections: parseProfileSelections(selectionsRaw),
	};
}

export function readModelProfiles(): ModelProfile[] {
	if (recoverPackApply()) invalidateRegistryCache();
	const path = modelProfilesPath();
	let raw: string;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === 'ENOENT') return [];
		throw new ModelProfileError('Could not read model profiles.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ModelProfileError(
			'Model profiles file is not valid JSON. Fix or delete SCAN_DATA_DIR/model-profiles.json.',
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ModelProfileError('Model profiles must be a JSON object with a profiles list.');
	}
	const rec = parsed as Record<string, unknown>;
	if (!Array.isArray(rec.profiles)) {
		throw new ModelProfileError('Model profiles must be a JSON object with a profiles list.');
	}
	return rec.profiles.map((item, i) => publicModelProfile(parseStoredProfile(item, i)));
}

function storedPayload(profiles: ModelProfile[]): string {
	return `${JSON.stringify(
		{
			profiles: profiles.map((profile) => ({
				id: profile.id,
				name: profile.name,
				updatedAt: profile.updatedAt,
				selections: cloneProfileSelections(profile.selections),
			})),
		},
		null,
		2,
	)}\n`;
}

export function writeModelProfiles(profiles: ModelProfile[]): ModelProfile[] {
	if (profiles.length > MAX_PROFILES) {
		throw new ModelProfileError(`Keep at most ${MAX_PROFILES} model profiles.`);
	}
	const path = modelProfilesPath();
	mkdirSync(dirname(path), { recursive: true });
	const next = profiles.map(publicModelProfile);
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, storedPayload(next));
	try {
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* ignore */
		}
		throw error;
	}
	return next;
}

export function listPublicModelProfiles(): ModelProfile[] {
	return readModelProfiles().map(publicModelProfile);
}

function nameKey(name: string): string {
	return name.trim().toLowerCase();
}

export function saveModelProfile(input: {
	id?: unknown;
	name: unknown;
	selections: unknown;
}): ModelProfile {
	const name = normalizeProfileName(input.name);
	const selections = parseProfileSelections(input.selections);
	const profiles = readModelProfiles();
	const requestedId = typeof input.id === 'string' ? input.id.trim() : '';
	const now = Date.now();
	const byId = requestedId ? profiles.find((item) => item.id === requestedId) : undefined;
	const byName = profiles.find((item) => nameKey(item.name) === nameKey(name));
	if (byId && byName && byId.id !== byName.id) {
		throw new ModelProfileError(`A profile named ${JSON.stringify(name)} already exists.`);
	}
	const target = byId || byName;
	if (target) {
		target.name = name;
		target.updatedAt = now;
		target.selections = cloneProfileSelections(selections);
		writeModelProfiles(profiles);
		return publicModelProfile(target);
	}
	if (profiles.length >= MAX_PROFILES) {
		throw new ModelProfileError(`Keep at most ${MAX_PROFILES} model profiles.`);
	}
	const created: ModelProfile = {
		id: crypto.randomUUID(),
		name,
		updatedAt: now,
		selections: cloneProfileSelections(selections),
	};
	writeModelProfiles([...profiles, created]);
	return publicModelProfile(created);
}

export function deleteModelProfile(id: unknown): ModelProfile[] {
	const profileId = typeof id === 'string' ? id.trim() : '';
	if (!profileId) throw new ModelProfileError('Choose a profile to delete.');
	const profiles = readModelProfiles();
	if (!profiles.some((item) => item.id === profileId)) {
		throw new ModelProfileError('That profile is gone.');
	}
	return writeModelProfiles(profiles.filter((item) => item.id !== profileId));
}

export function getModelProfile(id: unknown): ModelProfile {
	const profileId = typeof id === 'string' ? id.trim() : '';
	if (!profileId) throw new ModelProfileError('Choose a profile.');
	const profile = readModelProfiles().find((item) => item.id === profileId);
	if (!profile) throw new ModelProfileError('That profile is gone.');
	return publicModelProfile(profile);
}

export function validateStoredProfile(
	id: unknown,
	rows: readonly ModelRow[] = listRegistryRows(),
): { profile: ModelProfile; issues: ProfileIssue[] } {
	const profile = getModelProfile(id);
	return { profile, issues: validateProfileSelections(profile.selections, rows) };
}

export type ModelProfileActionResult = {
	profiles: ModelProfile[];
	profile?: ModelProfile;
	issues?: ProfileIssue[];
};

export function applyModelProfileAction(
	action: string,
	body: Record<string, unknown>,
	rows?: readonly ModelRow[],
): ModelProfileActionResult {
	if (action === 'save') {
		const profile = saveModelProfile({
			id: body.id,
			name: body.name,
			selections: body.selections,
		});
		return { profiles: listPublicModelProfiles(), profile };
	}
	if (action === 'delete') {
		return { profiles: deleteModelProfile(body.id) };
	}
	if (action === 'validate') {
		const { profile, issues } = validateStoredProfile(body.id, rows ?? listRegistryRows());
		return { profiles: listPublicModelProfiles(), profile, issues };
	}
	if (action === 'list' || !action) {
		return { profiles: listPublicModelProfiles() };
	}
	throw new ModelProfileError('Choose save, delete, or validate.');
}

export type { ModelProfileSelections };
