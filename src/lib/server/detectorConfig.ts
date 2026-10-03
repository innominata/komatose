import { listRegistryRows } from './modelRegistryStore';
import { rowHasOperation } from '../modelRegistry';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	DEFAULT_DETECT_CONF,
	clampDetectConf,
	detectorSetupId,
	parseDetectorSetup,
	type DetectorAvailability,
	type DetectorDefaults,
	type DetectorSetupConfig,
} from '../detectorSetup';
import { DETECTORS, type Detector } from '../types';
import type { Preferences } from '../workflow';
import { cooEnabled, koharuDetectionMode, koharuInstalled, parseDetector } from './detect';
import { modelDefaultFor } from './modelDefaultStore';
import { writeAtomicJson } from './modelPackJournal';
import { DATA_DIR } from './paths';
import { getDoc } from './workflowStore';

type StoredDetector = { version: 1; setup: string; conf: number };

function configPath() {
	return join(DATA_DIR, 'detector-config.json');
}

function readStored(): StoredDetector | undefined {
	try {
		const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as Partial<StoredDetector>;
		const setup = parseDetectorSetup(parsed.setup);
		if (!setup) return undefined;
		return { version: 1, setup: detectorSetupId(setup), conf: clampDetectConf(parsed.conf) ?? DEFAULT_DETECT_CONF };
	} catch {
		return undefined;
	}
}

/**
 * The setup a fresh install ran before detection was configurable: the old
 * default detector, COO beside it, and Koharu, each whenever installed.
 */
function legacySetup(base: Detector = parseDetector(modelDefaultFor('detect'))): DetectorSetupConfig {
	return {
		base,
		coo: base !== 'heuristic' && cooEnabled(),
		koharu: base !== 'heuristic' && koharuDetectionMode() !== 'off' && koharuInstalled(),
	};
}

function envConf() {
	return clampDetectConf(process.env.SCAN_DETECT_CONF) ?? DEFAULT_DETECT_CONF;
}

export function detectorAvailability(): DetectorAvailability {
 return Object.fromEntries([['heuristic', { installed: true }], ...listRegistryRows().map(row => [row.id, {
  installed: !row.disabled && rowHasOperation(row, 'detect'), detail: 'Requires a current passing Detect Text test',
 }])]) as DetectorAvailability;
}

export function detectorDefaults(): DetectorDefaults {
	const stored = readStored();
	return {
		setup: stored?.setup ?? detectorSetupId(legacySetup()),
		conf: stored?.conf ?? envConf(),
		saved: Boolean(stored),
		available: detectorAvailability(),
	};
}

export function saveDetectorDefaults(input: { setup: unknown; conf?: unknown }): DetectorDefaults {
	const setup = parseDetectorSetup(input.setup);
	if (!setup) throw Object.assign(new Error('Unknown detector setup'), { status: 400 });
	const conf = input.conf === undefined ? readStored()?.conf ?? envConf() : clampDetectConf(input.conf);
	if (conf === undefined) throw Object.assign(new Error('Detection confidence must be a number from 0.05 to 0.9'), { status: 400 });
	writeAtomicJson(configPath(), { version: 1, setup: detectorSetupId(setup), conf } satisfies StoredDetector);
	return detectorDefaults();
}

export type ResolvedDetector = {
	setup: DetectorSetupConfig;
	conf: number;
	/** Where the choice came from, so job logs can say why a setup ran. */
	source: 'request' | 'chapter' | 'default';
	/** Add-ons the choice asked for that this machine cannot run. */
	skipped: string[];
};

/**
 * The detector a chapter transcription runs: an explicit request, then the
 * chapter's own choice, then the admin default. A chapter saved before setups
 * existed keeps its old detector with the add-ons it used to get.
 */
export function resolveDetector(
	episodeId: string,
	override: { setup?: DetectorSetupConfig; conf?: number } = {},
): ResolvedDetector {
	const chapter = getDoc<Partial<Preferences>>(`chapter:${episodeId}`, {}).data;
	const defaults = detectorDefaults();
	const chapterSetup = parseDetectorSetup(chapter.detectorSetup) ??
		(chapter.detector ? legacySetup(chapter.detector) : undefined);
	const setup = override.setup ?? chapterSetup ?? parseDetectorSetup(defaults.setup)!;
	const conf = override.conf ?? clampDetectConf(chapter.detectConf) ?? defaults.conf;
	const skipped: string[] = [];
	const effective = { ...setup };
	if (effective.coo && !defaults.available.coo?.installed) {
		effective.coo = false;
		skipped.push('COO needs a current passing Detect Text test');
	}
	if (effective.koharu && !defaults.available.koharu?.installed) {
		effective.koharu = false;
		skipped.push('Koharu needs a current passing Detect Text test');
	}
	return {
		setup: effective,
		conf,
		source: override.setup ? 'request' : chapterSetup ? 'chapter' : 'default',
		skipped,
	};
}
