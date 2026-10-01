/**
 * Write-ahead journal for model-pack apply. If the process dies between overlay
 * and profile writes, the next read finishes the import so the two files match.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelOverlay } from '../modelRegistry';
import type { ModelProfile } from '../modelProfiles';

export type PackApplyJournal = {
	overlay: ModelOverlay;
	profiles: ModelProfile[];
};

export function packJournalPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'model-pack-apply.json');
}

function modelsPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'models.json');
}

function profilesPath(): string {
	const root = process.env.SCAN_ROOT || process.cwd();
	const data = process.env.SCAN_DATA_DIR || join(root, 'data');
	return join(data, 'model-profiles.json');
}

export function writeAtomicJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
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
}

export function readPackJournal(): PackApplyJournal | null {
	const path = packJournalPath();
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as PackApplyJournal;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		if (!parsed.overlay || typeof parsed.overlay !== 'object') return null;
		if (!Array.isArray(parsed.profiles)) return null;
		return {
			overlay: {
				rows: Array.isArray(parsed.overlay.rows) ? parsed.overlay.rows : [],
				catalogs: Array.isArray(parsed.overlay.catalogs) ? parsed.overlay.catalogs : [],
			},
			profiles: parsed.profiles,
		};
	} catch {
		return null;
	}
}

export function writePackJournal(journal: PackApplyJournal) {
	writeAtomicJson(packJournalPath(), {
		overlay: {
			rows: journal.overlay.rows || [],
			catalogs: journal.overlay.catalogs || [],
		},
		profiles: journal.profiles,
	});
}

export function clearPackJournal() {
	try {
		unlinkSync(packJournalPath());
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code !== 'ENOENT') throw error;
	}
}

let recovering = false;

/** Replay a leftover journal so models.json and model-profiles.json match. */
export function recoverPackApply(): boolean {
	if (recovering) return false;
	if (!existsSync(packJournalPath())) return false;
	const journal = readPackJournal();
	if (!journal) {
		clearPackJournal();
		return false;
	}
	recovering = true;
	try {
		writeAtomicJson(modelsPath(), {
			rows: journal.overlay.rows || [],
			catalogs: journal.overlay.catalogs || [],
		});
		writeAtomicJson(profilesPath(), { profiles: journal.profiles });
		clearPackJournal();
		return true;
	} finally {
		recovering = false;
	}
}
