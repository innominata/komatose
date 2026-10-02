/**
 * Catalog of everything Komatose can install on this machine, grouped by the
 * job each model does. This ships as *configs and install commands only* —
 * never weights. Disk sizes are the measured bytes on a working reference
 * install; memory is the approximate working set while that model is running
 * (RAM or VRAM, whichever the feature uses).
 *
 * Server-side install state lives in `$lib/server/modelInstall`.
 */

export const INSTALL_GROUPS = [
	{
		id: 'environment',
		label: 'Runtime environments',
		blurb:
			'Python environments the detectors, OCR reviewers and cleaners run inside. Install these before model weights that depend on them.',
	},
	{
		id: 'chat',
		label: 'Chat model',
		blurb:
			'The conversation model behind Translate, Describe and Proofread. Komatose cannot translate anything without one of these — or a remote/CLI model from the other tabs.',
	},
	{
		id: 'detect',
		label: 'Text detection',
		blurb: 'Finds lettering regions and balloons on a page before anything reads them.',
	},
	{
		id: 'ocr',
		label: 'Transcription (OCR)',
		blurb: 'Reads the detected regions back into source text.',
	},
	{
		id: 'translate',
		label: 'Translation',
		blurb: 'Dedicated manga translators for Japanese or Korean source text.',
	},
	{
		id: 'image-edit',
		label: 'Image editing',
		blurb: 'Diffusion editors that reconstruct artwork under lettering during Clean.',
	},
	{
		id: 'inpaint',
		label: 'Inpainting (cleanup)',
		blurb: 'Lightweight fill models that erase text and SFX from a page.',
	},
] as const;

export type InstallGroupId = (typeof INSTALL_GROUPS)[number]['id'];

export type InstallTarget = {
	id: string;
	group: InstallGroupId;
	label: string;
	/** What the model does, in one sentence, shown next to the sizes. */
	summary: string;
	/** Bytes written to disk by the installer (measured on a reference install). */
	diskBytes: number;
	/** Approximate working set while running; 0 when it has no meaningful footprint. */
	memoryBytes: number;
	/**
	 * Runtime environments this install needs. Satisfied when *any* listed
	 * environment is present; the server picks that one to run the command.
	 */
	requires?: string[];
	/**
	 * Model weights downloaded first when they are missing. Unlike `requires`,
	 * this does not hide Install: the dependency is queued ahead of this target.
	 */
	installsWith?: string[];
	/** Capability this unlocks, shown as a small hint. */
	unlocks?: string;
};

const GB = 1_000_000_000;
const MB = 1_000_000;

export const INSTALL_TARGETS: InstallTarget[] = [
	// --- Runtime environments -------------------------------------------------
	{
		id: 'env-ocr',
		group: 'environment',
		label: 'OCR & detection environment (.venv-ocr)',
		summary:
			'Detects text regions (RT-DETR, Comic Text Detector, PaddleOCR) and runs the OCR worker.',
		diskBytes: 1.3 * GB,
		memoryBytes: 0,
		unlocks: 'text detection, transcription',
	},
	{
		id: 'env-review',
		group: 'environment',
		label: 'Review environment (.venv-review)',
		summary:
			'CPU PyTorch environment for Hayai OCR, Manga OCR, the Korean/Japanese translators and local reviewers.',
		diskBytes: 15 * GB,
		memoryBytes: 0,
		unlocks: 'OCR reviewers, specialist translators',
	},
	{
		id: 'env-workflow',
		group: 'environment',
		label: 'Workflow environment (.venv-workflow)',
		summary:
			'Runs cleaning: masking (Koharu, COO), bubble geometry, inpainting models and the workflow worker.',
		diskBytes: 15 * GB,
		memoryBytes: 0,
		unlocks: 'cleaning, masking',
	},

	// --- Chat -----------------------------------------------------------------
	{
		id: 'qwen3.8-27b',
		group: 'chat',
		label: 'Qwen 3.8 27B · default chat model',
		summary:
			'Drives Translate, Describe and Proofread by default. IQ3_S GGUF + vision projector served by llama.cpp on the local endpoint. A remote or CLI model from the other tabs can replace it.',
		diskBytes: 13_051_163_488,
		memoryBytes: 16 * GB,
		unlocks: 'translate, describe, proofread',
	},

	// --- Text detection -------------------------------------------------------
	{
		id: 'rtdetr',
		group: 'detect',
		label: 'RT-DETR',
		summary:
			'Default region detector. Separates in-bubble text, free-floating SFX and balloon outlines; fine-tuned on ~11k comic pages.',
		diskBytes: 172 * MB,
		memoryBytes: 600 * MB,
		requires: ['env-ocr'],
		unlocks: 'text detection (default)',
	},
	{
		id: 'ctd',
		group: 'detect',
		label: 'Comic Text Detector',
		summary:
			'YOLOv5 text blocks plus a UNet text mask. The mask also feeds the cleaning step. Alternative detector to RT-DETR.',
		diskBytes: 95 * MB,
		memoryBytes: 500 * MB,
		requires: ['env-ocr'],
		unlocks: 'text detection, text masks',
	},
	{
		id: 'koharu',
		group: 'detect',
		label: 'Koharu SAM-TS-L',
		summary:
			'Starts beside the box detectors to catch text they missed and to produce the full-page mask used before transcription.',
		diskBytes: 1_365 * MB,
		memoryBytes: 2.5 * GB,
		requires: ['env-workflow'],
		unlocks: 'supplemental text detection, transcription masks',
	},
	{
		id: 'coo',
		group: 'detect',
		label: 'COO DBNet++ (sound effects)',
		summary:
			'Sidecar detector for free-floating sound effects and drawn lettering when RT-DETR is the active detector.',
		diskBytes: 111 * MB,
		memoryBytes: 1 * GB,
		requires: ['env-workflow'],
		unlocks: 'SFX detection',
	},

	// --- Transcription --------------------------------------------------------
	{
		id: 'hayai-ocr-v2',
		group: 'ocr',
		label: 'Hayai OCR v2',
		summary:
			'Fast CPU OCR and default member of the transcription set; also a source reviewer. Includes its SigLIP2 vision config.',
		diskBytes: 700 * MB,
		memoryBytes: 2.5 * GB,
		requires: ['env-review'],
		unlocks: 'transcription, AI review',
	},
	{
		id: 'manga-ocr',
		group: 'ocr',
		label: 'Manga OCR',
		summary: 'Japanese manga text recognizer. Transcription only; good at vertical lettering.',
		diskBytes: 480 * MB,
		memoryBytes: 1.5 * GB,
		requires: ['env-review'],
		unlocks: 'transcription (Japanese)',
	},
	{
		id: 'paddleocr-vl-1.6',
		group: 'ocr',
		label: 'PaddleOCR-VL-1.6',
		summary:
			'Multilingual VL OCR (GGUF via llama.cpp) and the other default member of the transcription set.',
		diskBytes: 1.9 * GB,
		memoryBytes: 3 * GB,
		requires: ['env-review'],
		unlocks: 'transcription, AI review',
	},
	{
		id: 'qwen3-vl-8b',
		group: 'ocr',
		label: 'Qwen3-VL 8B',
		summary:
			'8B vision model that reads images for transcription, vision tasks and AI review.',
		diskBytes: 9.9 * GB,
		memoryBytes: 11 * GB,
		requires: ['env-review'],
		unlocks: 'vision, describe, AI review',
	},

	// --- Translation ----------------------------------------------------------
	{
		id: 'cat-translate-7b-q4',
		group: 'translate',
		label: 'CAT-Translate 7B Q4',
		summary:
			'CyberAgent Japanese → English translator (imatrix Q4_K_M GGUF, served by llama-server).',
		diskBytes: 4_537_758_304,
		memoryBytes: 6 * GB,
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'hy-mt2-manga-v5',
		group: 'translate',
		label: 'Hy-MT2 1.8B Manga v5',
		summary:
			'Japanese → English manga translator (Q4 GGUF, served by the existing llama-server).',
		diskBytes: 1.15 * GB,
		memoryBytes: 1.6 * GB,
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'hy-mt2-7b-q4',
		group: 'translate',
		label: 'Hy-MT2 7B Q4',
		summary:
			'Stock Tencent Hy-MT2 7B Japanese → English translator (Q4_K_M GGUF, served by llama-server).',
		diskBytes: 4_624_648_896,
		memoryBytes: 6 * GB,
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'imsbee-ko-en-translator',
		group: 'translate',
		label: 'Imsbee Ko→En Translator',
		summary:
			'Korean → English sentence translator (PyTorch checkpoint; runs in the review environment).',
		diskBytes: 1.1 * GB,
		memoryBytes: 2 * GB,
		requires: ['env-review'],
		unlocks: 'dedicated KO→EN translation',
	},
	{
		id: 'opus-mt-ja-en',
		group: 'translate',
		label: 'Opus-MT Ja→En',
		summary: 'Lightweight Japanese → English MT (PyTorch; runs in the review environment).',
		diskBytes: 320 * MB,
		memoryBytes: 1 * GB,
		requires: ['env-review'],
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'shisa-v2.1-qwen3-8b-q4',
		group: 'translate',
		label: 'Shisa v2.1 8B Q4',
		summary:
			'Japanese → English manga translator (Qwen3 8B Q4_K_M GGUF, served by the existing llama-server).',
		diskBytes: 5_027_784_736,
		memoryBytes: 6 * GB,
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'sugoi-v4-ja-en',
		group: 'translate',
		label: 'Sugoi v4 Ja→En',
		summary:
			'Japanese → English NMT (CTranslate2; runs in the review environment).',
		diskBytes: 1_105_165_247,
		memoryBytes: 1.5 * GB,
		requires: ['env-review'],
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'translategemma-4b-q4',
		group: 'translate',
		label: 'TranslateGemma 4B Q4',
		summary:
			'Google TranslateGemma 4B Japanese → English translator (Q4_K_M GGUF, served by llama-server).',
		diskBytes: 2_489_909_760,
		memoryBytes: 3.5 * GB,
		unlocks: 'dedicated JP→EN translation',
	},
	{
		id: 'translategemma-12b-q4',
		group: 'translate',
		label: 'TranslateGemma 12B Q4',
		summary:
			'Google TranslateGemma 12B Japanese → English translator (Q4_K_M GGUF, served by llama-server).',
		diskBytes: 7_300_794_112,
		memoryBytes: 9 * GB,
		unlocks: 'dedicated JP→EN translation',
	},

	// --- Image editing --------------------------------------------------------
	{
		id: 'qwen-image-edit-2511',
		group: 'image-edit',
		label: 'Qwen-Image-Edit 2511 · default editor',
		summary:
			'20B instruction editor used by Clean. Follows the edit prompt; plan on a ~24 GB card.',
		diskBytes: 20.3 * GB,
		memoryBytes: 21 * GB,
		requires: ['env-workflow'],
		unlocks: 'artwork editing in Clean',
	},
	{
		id: 'qwen-image-edit-2511-lightning',
		group: 'image-edit',
		label: 'Qwen-Image-Edit 2511 Lightning',
		summary:
			'8-step Lightning LoRA on the 2511 weights. Same editor, fewer steps. Installing this also downloads 2511 when those weights are missing.',
		diskBytes: 849_608_296,
		memoryBytes: 21 * GB,
		requires: ['env-workflow'],
		installsWith: ['qwen-image-edit-2511'],
		unlocks: 'faster artwork editing in Clean',
	},

	// --- Inpainting -----------------------------------------------------------
	{
		id: 'big-lama',
		group: 'inpaint',
		label: 'AnimeManga Big-LaMa',
		summary:
			'512px inpainting checkpoint (AnimeMangaInpainting) behind the “Big-LaMa” clean method.',
		diskBytes: 205 * MB,
		memoryBytes: 1 * GB,
		requires: ['env-workflow'],
		unlocks: 'Big-LaMa clean method',
	},
	{
		id: 'aot',
		group: 'inpaint',
		label: 'AOT',
		summary:
			'AOT inpainting as a clean-fill method, with a traced GPU build and a CPU ONNX path.',
		diskBytes: 47 * MB,
		memoryBytes: 500 * MB,
		requires: ['env-workflow'],
		unlocks: 'AOT clean method',
	},
	{
		id: 'lama-manga',
		group: 'inpaint',
		label: 'lama-Manga',
		summary:
			'Dynamic ONNX LaMa-manga: the CPU inpaint pass behind balloon-fill cleaning and click-to-fill erase.',
		diskBytes: 206 * MB,
		memoryBytes: 500 * MB,
		requires: ['env-workflow'],
		unlocks: 'balloon fill, click-to-fill erase',
	},
];

export function installTarget(id: string): InstallTarget | undefined {
	return INSTALL_TARGETS.find((target) => target.id === id);
}

export function installTargetsForGroup(group: InstallGroupId): InstallTarget[] {
	return INSTALL_TARGETS.filter((target) => target.group === group);
}

/** "1.9 GB", "172 MB" — for the catalog rows. */
export function formatDisk(bytes: number): string {
	if (bytes <= 0) return '—';
	if (bytes >= GB) return `${(bytes / GB).toFixed(bytes % GB === 0 ? 0 : 1)} GB`;
	return `${Math.round(bytes / MB)} MB`;
}

/** Memory footprint, same units; 0 means the model has no meaningful footprint. */
export function formatMemory(bytes: number): string {
	return formatDisk(bytes);
}
