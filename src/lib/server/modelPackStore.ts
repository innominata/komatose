/**
 * Export and apply versioned model packs. Secrets, CLI paths, and probes never
 * leave SCAN_DATA_DIR this way. Private/loopback/link-local HTTP endpoints are
 * omitted unless export opts them in; credentials in URLs are always stripped.
 */
import { cloneProfileSelections } from '../modelProfiles';
import {
	parseImportDecisions,
	parseModelPack,
	portableModelToOverlay,
	previewModelPack,
	previewPackExport,
	resolveImport,
	validateResolvedImport,
	type ImportDecisions,
	type ModelPack,
	type PackExportOptions,
	type PackExportPreview,
	type PackPreview,
} from '../modelPack';
import { envVar } from './envFile';
import { MAX_PROFILES, readModelProfiles, writeModelProfiles } from './modelProfileStore';
import {
	invalidateRegistryCache,
	listRegistryRows,
	readModelOverlay,
	writeModelOverlay,
} from './modelRegistryStore';
import { clearPackJournal, recoverPackApply, writePackJournal } from './modelPackJournal';

export function previewExportedPack(
	now = new Date(),
	options: PackExportOptions = {},
): PackExportPreview {
	if (recoverPackApply()) invalidateRegistryCache();
	return previewPackExport(listRegistryRows(), readModelProfiles(), options, now);
}

export function exportModelPack(now = new Date(), options: PackExportOptions = {}): ModelPack {
	return previewExportedPack(now, options).pack;
}

export function modelPackFilename(pack: ModelPack): string {
	const day = (pack.exportedAt || nowStamp(nowFromPack(pack))).slice(0, 10);
	return `komatose-model-pack-${day || 'export'}.json`;
}

function nowFromPack(pack: ModelPack): Date {
	const at = Date.parse(pack.exportedAt);
	return Number.isFinite(at) ? new Date(at) : new Date();
}

function nowStamp(date: Date): string {
	return date.toISOString();
}

function envNamesForPack(pack: ModelPack): Set<string> {
	const names = pack.models
		.map((model) => model.http?.apiKeyEnv)
		.filter((name): name is string => !!name);
	return new Set(names.filter((name) => !!envVar(name)));
}

export function previewImportedPack(raw: unknown): PackPreview {
	if (recoverPackApply()) invalidateRegistryCache();
	const pack = parseModelPack(raw);
	return previewModelPack(pack, listRegistryRows(), readModelProfiles(), envNamesForPack(pack));
}

export function applyImportedPack(
	raw: unknown,
	decisionsRaw?: unknown,
	hooks?: { afterOverlayWrite?: () => void },
): {
	addedModels: string[];
	addedProfiles: string[];
	skippedModelIds: string[];
	skippedProfileIds: string[];
} {
	const pack = parseModelPack(raw);
	const decisions: ImportDecisions = parseImportDecisions(decisionsRaw);
	const rows = listRegistryRows();
	const profiles = readModelProfiles();
	const resolved = resolveImport(pack, rows, profiles, decisions);
	validateResolvedImport(resolved, rows, profiles, MAX_PROFILES);
	if (!resolved.models.length && !resolved.profiles.length) {
		return {
			addedModels: [],
			addedProfiles: [],
			skippedModelIds: resolved.skippedModelIds,
			skippedProfileIds: resolved.skippedProfileIds,
		};
	}

	const overlayBefore = structuredClone(readModelOverlay());
	const overlayAfter = {
		rows: [...(overlayBefore.rows || []), ...resolved.models.map(portableModelToOverlay)],
		catalogs: overlayBefore.catalogs,
	};
	const now = Date.now();
	const profilesAfter = [
		...profiles,
		...resolved.profiles.map((profile) => ({
			id: profile.id,
			name: profile.name,
			updatedAt: now,
			selections: cloneProfileSelections(profile.selections),
		})),
	];
	writePackJournal({ overlay: overlayAfter, profiles: profilesAfter });
	try {
		writeModelOverlay(overlayAfter);
		hooks?.afterOverlayWrite?.();
		writeModelProfiles(profilesAfter);
		clearPackJournal();
	} catch (error) {
		clearPackJournal();
		writeModelOverlay(overlayBefore);
		invalidateRegistryCache();
		throw error;
	}
	return {
		addedModels: resolved.models.map((model) => model.id),
		addedProfiles: resolved.profiles.map((profile) => profile.id),
		skippedModelIds: resolved.skippedModelIds,
		skippedProfileIds: resolved.skippedProfileIds,
	};
}
