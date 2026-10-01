import type { PageRole, SeriesCredits } from './credits';
import { ROLES, STAFF_ROLES, type Role } from './roles';
export { ROLES, STAFF_ROLES };
export type { Role };
import {
	PROVIDER_IDS,
	PROVIDER_LABELS,
	isProofreaderProvider,
} from './providerCatalog';

export type EpisodeStatus = 'raws' | 'translating' | 'proofing' | 'cleaning' | 'typesetting' | 'done';

export type GlossaryTerm = {
	source: string;
	translation: string;
	edited?: boolean;
};

export type LineStatus = 'none' | 'needs_work' | 'approved';

export type LineType = 'OT' | '[]' | '<>' | '()' | 'ST' | '""' | '//' | 'note' | '::' | 'plain';

export type PublicUser = {
	id: string;
	username: string;
	role: Role;
};

/** System account that owns OCR/Qwen notes. Cannot log in. */
export const AI_USER_ID = 'ai-ocr';
export const AI_USERNAME = 'AI/OCR';

export type Series = {
	id: string;
	slug: string;
	title: string;
	notes: string;
	glossary: GlossaryTerm[];
	credits: SeriesCredits;
	createdBy: string | null;
	createdAt: number;
	updatedAt: number;
};

export type Episode = {
	numberingStale?: boolean;
	revision?: number;
	id: string;
	seriesId: string;
	slug: string;
	title: string;
	sortOrder: number;
	status: EpisodeStatus;
	glossary: GlossaryTerm[];
	createdAt: number;
	updatedAt: number;
};

export type ImageRow = {
	captionRevision?: number;
	pageNumber?: number | null;
	dpi?: number;
	id: string;
	episodeId: string;
	filename: string;
	originalName: string;
	sortOrder: number;
	width: number;
	height: number;
	caption: string;
	role: PageRole;
	createdAt: number;
	updatedAt: number;
};

export type LineRow = {
	source?: string;
	ocrConfidence?: number | null;
	sourceState?: string;
	ignoreReason?: string;
	revision?: number;
	id: string;
	episodeId: string;
	imageId: string | null;
	body: string;
	lineType: LineType;
	status: LineStatus;
	placed: boolean;
	/** True = black text on a light sticky. Null = autodetect. */
	invert: boolean | null;
	x: number | null;
	y: number | null;
	w: number | null;
	h: number | null;
	sidebarX: number | null;
	sidebarY: number | null;
	sidebarW: number | null;
	sidebarH: number | null;
	sortOrder: number;
	createdBy: string | null;
	updatedBy: string | null;
	updatedAt: number;
};

export type CommentRow = {
	revision?: number;
	id: string;
	lineId: string;
	userId: string;
	username: string;
	body: string;
	correction: boolean;
	createdAt: number;
};

export type ActivityRow = {
	id: string;
	seriesId: string | null;
	episodeId: string | null;
	userId: string | null;
	username: string | null;
	action: string;
	payload: string;
	createdAt: number;
};

/** Registry row id (or a legacy host id that hydrate/resolve still accept). */
export type TranslateEngine = string;

export type ReviewIssue = {
	page: string;
	line?: number;
	severity: 'info' | 'warn' | 'error';
	text: string;
};

export type ReviewQuestion = {
	page: string;
	text: string;
};

export type ReviewReport = {
	summary: string;
	issues: ReviewIssue[];
	questions: ReviewQuestion[];
	notes: string;
	engine: TranslateEngine;
	model: string;
	createdAt: number;
};

/**
 * Text-region detectors, best recall first. `heuristic` is the original
 * luma-threshold bubble finder: it only sees thick white or thick dark bubble
 * interiors, so free-floating SFX and narration over artwork are invisible to
 * it. The learned detectors label those as first-class regions.
 */
export type Detector = string;

export const DETECTORS: Detector[] = ['rtdetr', 'ctd', 'paddle', 'heuristic'];

export const DETECTOR_LABELS: Record<Detector, string> = {
	rtdetr: 'RT-DETR · comic/webtoon',
	ctd: 'comic-text-detector',
	paddle: 'PaddleOCR full page',
	heuristic: 'Geometric bubbles (legacy)'
};

export type DetectorInfo = {
	id: Detector;
	label: string;
};

/** Source-script language for OCR recognition and translation prompts. */
export type OcrLang = 'korean' | 'japanese';

export const OCR_LANGS: OcrLang[] = ['korean', 'japanese'];

export const OCR_LANG_LABELS: Record<OcrLang, string> = {
	korean: 'Korean',
	japanese: 'Japanese'
};

export type OcrLangInfo = {
	id: OcrLang;
	label: string;
};

export type WsEvent =
	| { type: 'workflow:changed'; id: string; revision: number }
	| { type: 'job:changed'; id: string }
	| { type: 'suggestion:changed'; lineId: string }
	| { type: 'presence'; users: PublicUser[] }
	| { type: 'line:upsert'; line: LineRow }
	| { type: 'line:delete'; id: string }
	| { type: 'comment:add'; comment: CommentRow }
	| { type: 'comment:delete'; id: string; lineId: string }
	| { type: 'episode:status'; status: EpisodeStatus; updatedAt: number }
	| { type: 'image:upsert'; image: ImageRow }
	| { type: 'image:delete'; id: string }
	| { type: 'image:reorder'; order: { id: string; sortOrder: number }[] }
	| { type: 'activity'; entry: ActivityRow }
	| { type: 'series:notes'; notes: string }
	| { type: 'episode:clear' }
	| { type: 'region:queue'; pending: number; running: boolean; message: string }
	| { type: 'glossary:series'; glossary: GlossaryTerm[] }
	| {
			type: 'page:describe';
			running: boolean;
			imageIndex: number;
			imageCount: number;
			message: string;
			imageId?: string;
	  }
	| {
			type: 'ai:progress';
			running: boolean;
			imageIndex: number;
			imageCount: number;
			message: string;
			error?: string;
			engine?: TranslateEngine;
			detector?: string;
			detectConf?: number;
			lang?: OcrLang;
			kind?: 'transcribe' | 'translate' | 'proofread' | 'review';
			report?: ReviewReport;
			model?: string;
	  }
	| { type: 'review:ready'; report: ReviewReport };

export const TEST_SERIES_TITLE = 'Test';
export const TEST_SERIES_SLUG = 'test';

export const EPISODE_STATUSES: EpisodeStatus[] = [
	'raws',
	'translating',
	'proofing',
	'cleaning',
	'typesetting',
	'done'
];

export const LINE_TYPES: LineType[] = ['OT', '[]', '<>', '()', 'ST', '""', '//', 'note', '::', 'plain'];

export const LINE_TYPE_LABELS: Record<LineType, string> = {
	OT: 'OT',
	'[]': 'Box',
	'<>': 'System',
	'()': 'Thought',
	ST: 'ST',
	'""': 'Dialogue',
	'//': 'Aside',
	note: 'Note',
	'::': 'SFX',
	plain: 'Plain'
};

export const TRANSLATE_ENGINES = [...PROVIDER_IDS];

export const TRANSLATE_ENGINE_LABELS: Record<string, string> = { ...PROVIDER_LABELS };

export type TranslateEngineInfo = {
	access?: string;
	id: string;
	label: string;
	available: boolean;
	reason?: string;
	pageImageOnly?: boolean;
	group?: string;
	operations?: string[];
	estimates?: Record<string, { label: string; ms: number; medianMs?: number }>;
};

export function isPageImageOnlyEngine(id: string): boolean {
	return isProofreaderProvider(id);
}

export function textEngines<T extends { id: string }>(engines: T[]): T[] {
	return engines.filter((engine) => !isPageImageOnlyEngine(engine.id));
}
