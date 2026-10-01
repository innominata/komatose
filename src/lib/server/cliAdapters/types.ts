import type { LineType, OcrLang } from '../../types';
import type { DetectedBox, ProofreadItem } from '../llm';

export type AgentModel = { id: string; label: string };
export type AdvisoryRequest = {
  system: string; prompt: string; images: Buffer[]; schema: unknown;
  model?: string; abort?: AbortSignal;
};

/** Adapters advertise only operations actually implemented by this contract. */
export interface CliAdapter {
  readonly id: string;
  readonly label: string;
  readonly supportsImages: boolean;
  executable(): string | null;
  defaultModel(): string;
  listModels(): Promise<AgentModel[]>;
  advisory(request: AdvisoryRequest): Promise<unknown>;
  /** One translation attempt. The caller owns glossary processing and retries. */
  translate?: TranslationHandler;
  /** One crop transcription. The caller owns OCR fallback and engine selection. */
  read?: VisionReadHandler;
  /** One chapter review. The caller owns pack loading and report persistence. */
  review?: ChapterReviewHandler;
  /** One page scene note. The caller owns engine selection and Qwen3-VL routing. */
  describe?: PageDescribeHandler;
  /** One Codex image-generation crop. The caller owns tiling and compositing. */
  clean?: CleaningHandler;
}

export type Command = {
  bin: string; args: string[]; cwd: string; stdin?: string; abort?: AbortSignal;
  /** Defaults to the shared CLI runner timeout when omitted. */
  timeoutMs?: number;
};
export type CommandResult = { stdout: string; stderr: string; code: number };
export type CommandRuntime = {
  run(command: Command): Promise<CommandResult>;
  parse(text: string): unknown;
};
export type AdapterOptions = {
  translate?: TranslationHandler;
  read?: VisionReadHandler;
  review?: ChapterReviewHandler;
  describe?: PageDescribeHandler;
  clean?: CleaningHandler;
  executable(): string | null;
  defaultModel(): string;
  listModels(): Promise<AgentModel[]>;
};

export type TranslationOptions = {
	requireTranslation?: boolean;
	proofreadItems?: ProofreadItem[];
	seriesNotes: string;
	prior: string;
	pageLabel: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	pageCaption?: string;
	seriesGlossary?: string;
	/** Selection crop. Attached as a real image so the model can read the glyphs. */
	jpeg?: Buffer;
	userPrompt?: string;
	systemPrompt?: string;
	model?: string;
	/** Original script indexes to include in the prompt (retry missing lines). */
	lineIndexes?: number[];
};

export type TranslationHandler = (
  boxes: DetectedBox[], options: TranslationOptions
) => Promise<DetectedBox[]>;

export type VisionReadOptions = {
	lang?: OcrLang;
	model?: string;
	abort?: AbortSignal;
};

export type VisionReadHandler = (
  jpeg: Buffer,
  options: VisionReadOptions
) => Promise<{ source: string; lineType: LineType }>;

export type ChapterReviewOptions = {
	seriesNotes: string;
	seriesGlossary: string;
	prior: string;
	pages: string;
	script: string;
	abort?: AbortSignal;
	lang?: OcrLang;
	model?: string;
};

export type ChapterReviewResult = {
	summary: string;
	issues: { page: string; line?: number; severity: 'info' | 'warn' | 'error'; text: string }[];
	questions: { page: string; text: string }[];
	notes: string;
};

export type ChapterReviewHandler = (
  options: ChapterReviewOptions
) => Promise<ChapterReviewResult>;

export type PageDescribeOptions = {
	abort?: AbortSignal;
	model?: string;
};

export type PageDescribeHandler = (
  jpeg: Buffer,
  options: PageDescribeOptions
) => Promise<string>;

export type CleaningOptions = {
	mask: Buffer;
	abort?: AbortSignal;
	model?: string;
	/** User-edited reconstruction instructions, without the mechanical wrapper. */
	prompt?: string;
};

export type CleaningHandler = (
  image: Buffer,
  options: CleaningOptions
) => Promise<Buffer>;
