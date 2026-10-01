/* Pretend data for the admin Models mockup. Nothing here talks to the app. */
window.MOCK = (() => {
	const GB = 1;
	const MB = 0.001;

	const HARDWARE = {
		cpu: 'Ryzen 9 7950X · 16 cores',
		ramGb: 64,
		disk: { path: '/www', totalGb: 1800, freeGb: 412 },
		devices: [
			{ id: 'gpu0', label: 'GPU 0', name: 'Radeon RX 7900 XTX', vramGb: 24, foreign: [{ label: 'Xorg + desktop', gb: 1.1 }] },
			{ id: 'gpu1', label: 'GPU 1', name: 'Radeon RX 6800', vramGb: 16, foreign: [] },
			{ id: 'cpu', label: 'CPU / RAM', name: 'System memory', vramGb: 64, foreign: [{ label: 'OS + Komatose', gb: 6.5 }] },
		],
	};

	/**
	 * The user-facing jobs. Each maps onto the internal operation ids the
	 * registry already uses, so the matrix can stay faithful to the backend.
	 */
	const TASKS = [
		{ id: 'detect', label: 'Detect text', stage: 'Translate', icon: 'bi-bounding-box', required: true, blurb: 'Finds lettering and balloons on each page.' },
		{ id: 'transcribe', label: 'Transcribe', stage: 'Translate', icon: 'bi-fonts', required: true, blurb: 'Reads source text from each region.' },
		{ id: 'translate', label: 'Translate', stage: 'Translate', icon: 'bi-translate', required: true, blurb: 'Drafts English from checked source.' },
		{ id: 'describe', label: 'Scene notes', stage: 'Translate', icon: 'bi-card-text', blurb: 'Visual notes that give translation context.' },
		{ id: 'review', label: 'AI review', stage: 'Review', icon: 'bi-people', blurb: 'Council readings, Enquire and alternatives.' },
		{ id: 'proofread', label: 'Proofread', stage: 'Review', icon: 'bi-spellcheck', blurb: 'English polish and page-image critique.' },
		{ id: 'mask', label: 'Text masks', stage: 'Clean', icon: 'bi-brush', required: true, blurb: 'Lettering masks that Clean erases.' },
		{ id: 'clean', label: 'Clean artwork', stage: 'Clean', icon: 'bi-magic', blurb: 'Fill or reconstruct the art under lettering.' },
	];

	const STAGES = ['Translate', 'Review', 'Clean'];

	/** Operations an admin can allow per model (the old checkbox wall, with real names). */
	const OPS = [
		{ id: 'vision', label: 'Read images', hint: 'Transcribe · Read area', task: 'transcribe' },
		{ id: 'translate', label: 'Translate', hint: 'Chapter + region', task: 'translate' },
		{ id: 'describe', label: 'Scene notes', hint: 'Describe pages', task: 'describe' },
		{ id: 'compactNotes', label: 'Compact notes', hint: 'Summaries', task: 'describe' },
		{ id: 'advisory', label: 'AI review', hint: 'Council · Enquire', task: 'review' },
		{ id: 'chapterReview', label: 'Chapter review', hint: 'Whole chapter', task: 'review' },
		{ id: 'alternatives', label: 'Alternatives', hint: 'Suggest wording', task: 'review' },
		{ id: 'proofreadEnglish', label: 'Proofread English', hint: 'Text only', task: 'proofread' },
		{ id: 'pageImageProofread', label: 'Page proofread', hint: 'Raw + typeset', task: 'proofread' },
		{ id: 'cleaning', label: 'Reconstruct art', hint: 'Clean step', task: 'clean' },
	];
	const CHAT_OPS = ['vision', 'translate', 'describe', 'compactNotes', 'advisory', 'chapterReview', 'alternatives', 'proofreadEnglish', 'pageImageProofread'];

	const ENVIRONMENTS = [
		{ id: 'env-ocr', label: 'OCR & detection environment', path: '.venv-ocr', diskGb: 1.3, cmd: 'uv venv --python 3.12 .venv-ocr && uv pip install --python .venv-ocr/bin/python -r ocr/requirements.txt' },
		{ id: 'env-review', label: 'Review environment', path: '.venv-review', diskGb: 15, cmd: 'uv venv --python 3.12 .venv-review && uv pip install --python .venv-review/bin/python -r review/requirements-cpu.txt' },
		{ id: 'env-workflow', label: 'Workflow environment', path: '.venv-workflow', diskGb: 15, cmd: 'uv venv --python 3.12 .venv-workflow && uv pip install --python .venv-workflow/bin/python -r workflow/requirements.txt' },
	];

	/** Catalog groups follow the job, not the runtime. */
	const CATALOG_GROUPS = [
		{ id: 'chat', label: 'Chat model', task: 'translate', blurb: 'General model behind Translate, Scene notes, Review and Proofread. Any remote or CLI model can stand in.' },
		{ id: 'detect', label: 'Text detection & masks', task: 'detect', blurb: 'Finds lettering before OCR, and draws the masks Clean erases.' },
		{ id: 'transcribe', label: 'Transcription (OCR)', task: 'transcribe', blurb: 'Reads detected regions. Hayai + PaddleOCR-VL is the default council.' },
		{ id: 'translate', label: 'Dedicated translators', task: 'translate', blurb: 'Small manga-tuned translators for Japanese or Korean.' },
		{ id: 'fill', label: 'Clean · fill', task: 'clean', blurb: 'Lightweight inpainting that erases text over flat or simple art.' },
		{ id: 'reconstruct', label: 'Clean · reconstruct', task: 'clean', blurb: 'Diffusion editors that redraw detailed art under lettering. Share GPU 0 with the chat model.' },
	];

	/**
	 * Everything the mockup treats as "a model". Catalog entries carry an
	 * `install` block; configured rows (remote, CLI) do not.
	 */
	const CATALOG = [
		{ id: 'qwen3.8-27b', name: 'Qwen 3.8 27B', group: 'chat', tasks: ['translate', 'describe', 'review', 'proofread', 'transcribe'], ops: CHAT_OPS.filter((o) => o !== 'pageImageProofread'), diskGb: 13.05, memGb: 16, device: 'gpu0', runtime: 'chat', port: 18080, recommended: true, sum: 'Default chat model. IQ3_S GGUF + vision projector on llama.cpp.', repo: 'unsloth/Qwen3.8-27B-GGUF', file: 'Qwen3.8-27B-IQ3_S.gguf' },
		{ id: 'rtdetr', name: 'RT-DETR', group: 'detect', tasks: ['detect'], diskGb: 172 * MB, memGb: 0.6, device: 'cpu', requires: ['env-ocr'], recommended: true, sum: 'Default detector. Separates bubble text, free SFX and balloon outlines.', repo: 'ogkalu/comic-text-and-bubble-detector', file: 'model.safetensors' },
		{ id: 'ctd', name: 'Comic Text Detector', group: 'detect', tasks: ['detect', 'mask'], diskGb: 95 * MB, memGb: 0.5, device: 'cpu', requires: ['env-ocr'], recommended: true, sum: 'YOLOv5 blocks + UNet text mask. The mask feeds Clean.', repo: 'mayocream/comic-text-detector', file: 'comictextdetector.pt' },
		{ id: 'koharu', name: 'Koharu SAM-TS-L', group: 'detect', tasks: ['detect', 'mask'], diskGb: 1.365, memGb: 2.5, device: 'cpu', requires: ['env-workflow'], sum: 'Catches text the box detectors miss; full-page transcription mask.', repo: 'mayocream/koharu-sam-ts', file: 'sam_ts_l.safetensors' },
		{ id: 'coo', name: 'COO DBNet++ (SFX)', group: 'detect', tasks: ['detect'], diskGb: 111 * MB, memGb: 1, device: 'cpu', requires: ['env-workflow'], sum: 'Sidecar for free-floating sound effects and drawn lettering.', repo: 'coo-lab/dbnetpp-sfx', file: 'dbnetpp.pth' },
		{ id: 'hayai-ocr-v2', name: 'Hayai OCR v2', group: 'transcribe', tasks: ['transcribe', 'review'], ops: ['vision', 'advisory'], diskGb: 0.7, memGb: 2.5, device: 'cpu', runtime: 'review', port: 18092, requires: ['env-review'], recommended: true, sum: 'Fast CPU OCR; default council member and source reviewer.', repo: 'hayai-lab/hayai-ocr-v2', file: 'model.safetensors' },
		{ id: 'paddleocr-vl-1.6', name: 'PaddleOCR-VL 1.6', group: 'transcribe', tasks: ['transcribe', 'review'], ops: ['vision', 'advisory'], diskGb: 1.9, memGb: 3, device: 'cpu', runtime: 'review', port: 18091, requires: ['env-review'], recommended: true, sum: 'Multilingual VL OCR on llama.cpp; the other default council member.', repo: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF', file: 'paddleocr-vl-1.6-Q8_0.gguf' },
		{ id: 'manga-ocr', name: 'Manga OCR', group: 'transcribe', tasks: ['transcribe'], ops: ['vision'], diskGb: 0.48, memGb: 1.5, device: 'cpu', runtime: 'review', requires: ['env-review'], lang: 'Japanese', sum: 'Japanese recognizer; strong on vertical lettering.', repo: 'kha-white/manga-ocr-base', file: 'pytorch_model.bin' },
		{ id: 'qwen3-vl-8b', name: 'Qwen3-VL 8B', group: 'transcribe', tasks: ['transcribe', 'describe', 'review'], ops: ['vision', 'describe', 'advisory'], diskGb: 9.9, memGb: 11, device: 'gpu1', runtime: 'review', port: 18093, requires: ['env-review'], sum: 'Vision model for reading, scene notes and review. Shares its encoder with Qwen-Image 2.1.', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', file: 'Qwen3-VL-8B-Q8_0.gguf' },
		{ id: 'hy-mt2-manga-v5', name: 'Hy-MT2 1.8B Manga v5', group: 'translate', tasks: ['translate'], ops: ['translate'], diskGb: 1.15, memGb: 1.6, device: 'gpu1', runtime: 'review', port: 18094, lang: 'JP → EN', recommended: true, sum: 'Japanese → English manga translator (Q4 GGUF).', repo: 'fumetodev/Hy-MT2-1.8B-JP-Manga-Finetune-v5-GGUF', file: 'manga-v5-Q4_K_M.gguf' },
		{ id: 'imsbee-ko-en', name: 'Imsbee Ko→En', group: 'translate', tasks: ['translate'], ops: ['translate'], diskGb: 1.1, memGb: 2, device: 'cpu', runtime: 'review', requires: ['env-review'], lang: 'KO → EN', sum: 'Korean → English sentence translator.', repo: 'Imsbee/ko-en-translator', file: 'sentence-base/best.pt' },
		{ id: 'opus-mt-ja-en', name: 'Opus-MT Ja→En', group: 'translate', tasks: ['translate'], ops: ['translate'], diskGb: 0.32, memGb: 1, device: 'cpu', runtime: 'review', requires: ['env-review'], lang: 'JP → EN', sum: 'Lightweight Japanese → English MT.', repo: 'Helsinki-NLP/opus-mt-ja-en', file: 'pytorch_model.bin' },
		{ id: 'lama-manga', name: 'lama-Manga', group: 'fill', tasks: ['clean'], diskGb: 206 * MB, memGb: 0.5, device: 'cpu', requires: ['env-workflow'], recommended: true, sum: 'CPU inpaint behind balloon fill and click-to-fill erase.', repo: 'mayocream/lama-manga-onnx', file: 'lama-manga.onnx' },
		{ id: 'big-lama', name: 'AnimeManga Big-LaMa', group: 'fill', tasks: ['clean'], diskGb: 205 * MB, memGb: 1, device: 'cpu', requires: ['env-workflow'], sum: '512 px inpainting behind the “Big-LaMa” clean method.', repo: 'dreMaz/AnimeMangaInpainting', file: 'lama_large_512px.ckpt' },
		{ id: 'aot', name: 'AOT', group: 'fill', tasks: ['clean'], diskGb: 47 * MB, memGb: 0.5, device: 'cpu', requires: ['env-workflow'], sum: 'AOT inpainting with a GPU trace and CPU ONNX path.', repo: 'zyddnys/manga-image-translator', file: 'aot.onnx' },
		{ id: 'qwen-image-2.1', name: 'Qwen-Image 2.1', group: 'reconstruct', tasks: ['clean'], ops: ['cleaning'], diskGb: 8.4, memGb: 18, device: 'gpu0', runtime: 'editor', port: 18100, requires: ['env-workflow'], recommended: true, sum: 'Default local editor. Redraws artwork under lettering.', repo: 'Qwen/Qwen-Image-2.1-GGUF', file: 'qwen-image-2.1-Q4_K.gguf' },
		{ id: 'qwen-image-edit-2511', name: 'Qwen-Image-Edit 2511', group: 'reconstruct', tasks: ['clean'], ops: ['cleaning'], diskGb: 20.3, memGb: 21, device: 'gpu0', runtime: 'editor', port: 18100, requires: ['env-workflow'], sum: '20B instruction editor. Follows prompts closer; plan on a 24 GB card.', repo: 'Qwen/Qwen-Image-Edit-2511-GGUF', file: 'qwen-image-edit-2511-Q4_K.gguf' },
	];

	const BUNDLES = [
		{ id: 'essentials', name: 'Essentials', icon: 'bi-lightning-charge', blurb: 'Detect, transcribe and fill on the CPU. Pair with any chat model.', items: ['rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6', 'lama-manga'] },
		{ id: 'local-translate', name: 'Local translation', icon: 'bi-gpu-card', blurb: 'Run translation, review and notes on this machine. Needs 16 GB of VRAM.', items: ['qwen3.8-27b', 'hy-mt2-manga-v5'] },
		{ id: 'local-clean', name: 'Local cleaning', icon: 'bi-magic', blurb: 'Redraw artwork under lettering without Codex. Needs a 24 GB card.', items: ['koharu', 'qwen-image-2.1', 'big-lama'] },
	];

	const CHAT_PRESETS = [
		{ id: 'qwen38', name: 'Qwen 3.8 27B', slug: 'qwen3.8-27b-q4', memGb: 16, weights: '~/models/Qwen3.8-27B-IQ3_S.gguf', catalog: 'qwen3.8-27b', note: 'Default. One-click installer available.' },
		{ id: 'gemma4-26b', name: 'Gemma 4 26B', slug: 'gemma-4-26b-q4', memGb: 17, weights: '~/models/gemma-4-26b-it-Q4_K_M.gguf', note: 'Bring your own GGUF.' },
		{ id: 'gemma4-12b', name: 'Gemma 4 12B', slug: 'gemma-4-12b-q4', memGb: 9, weights: '~/models/gemma-4-12b-it-Q4_K_M.gguf', note: 'Bring your own GGUF. Fits GPU 1.' },
		{ id: 'gemma4-e2b', name: 'Gemma 4 E2B', slug: 'gemma-4-e2b', memGb: 3, weights: '~/models/gemma-4-e2b-it-Q8_0.gguf', note: 'Tiny; CPU-friendly.' },
		{ id: 'generic', name: 'Other llama.cpp model', slug: '', memGb: 0, weights: '', note: 'Any GGUF with the generic launch preset.' },
		{ id: 'external', name: 'Already-running server', slug: '', memGb: 0, weights: '', note: 'Point at an OpenAI-compatible /v1 you start yourself.' },
	];

	const REMOTE_PRESETS = [
		{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyVar: 'OPENAI_API_KEY', models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3', 'o3', 'o4-mini'] },
		{ id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyVar: 'OPENROUTER_API_KEY', models: ['deepseek/deepseek-v4', 'anthropic/claude-opus-5', 'google/gemini-3.5-pro', 'qwen/qwen3.8-235b'] },
		{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyVar: 'DEEPSEEK_API_KEY', models: ['deepseek-v4', 'deepseek-v4-reasoner'] },
		{ id: 'custom', name: 'Custom', baseUrl: '', keyVar: 'MY_API_KEY', models: ['model-a', 'model-b'] },
	];

	const CLI_DEFS = {
		codex: { label: 'Codex CLI', command: 'codex', envVar: 'CODEX_BIN', catalog: [['gpt-5.4', 'GPT-5.4'], ['gpt-5.3-codex', 'GPT-5.3 Codex'], ['gpt-5.3', 'GPT-5.3'], ['gpt-5.2', 'GPT-5.2'], ['o3', 'o3'], ['o4-mini', 'o4-mini']], cleaning: true },
		cursor: { label: 'Cursor CLI', command: 'cursor-agent', envVar: 'CURSOR_BIN', catalog: [['composer-2.5', 'Composer 2.5'], ['composer-2.5-fast', 'Composer 2.5 Fast'], ['auto', 'Auto']] },
		grok: { label: 'Grok CLI', command: 'grok', envVar: 'GROK_BIN', catalog: [['grok-4.6', 'Grok 4.6'], ['grok-4.5', 'Grok 4.5']] },
	};

	const ENV_KEYS_ALL = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'LLAMASWAP_API_KEY'];

	function remoteRow(id, name, preset, slug, extra = {}) {
		const p = REMOTE_PRESETS.find((r) => r.id === preset);
		return {
			id, name, source: 'remote', slug,
			endpoint: { baseUrl: p.baseUrl, keyVar: p.keyVar, provider: p.name },
			ops: ['translate', 'vision', 'describe', 'compactNotes', 'advisory', 'chapterReview', 'alternatives', 'proofreadEnglish'],
			visible: true, billed: true, tests: {}, ...extra,
		};
	}

	function cliRow(adapter, slug, extra = {}) {
		const def = CLI_DEFS[adapter];
		const label = def.catalog.find(([s]) => s === slug)?.[1] || slug;
		const tool = def.label.replace(' CLI', '');
		return {
			id: `${adapter}-${slug}`, name: label.includes(tool) ? label : `${label} (${tool})`, source: 'cli', adapter, slug,
			ops: [...CHAT_OPS, ...(def.cleaning ? ['cleaning'] : [])],
			visible: true, billed: true, tests: {}, ...extra,
		};
	}

	function catalogModel(item, install, extra = {}) {
		return {
			id: item.id, name: item.name, source: 'local', catalog: item.id,
			ops: item.ops ? [...item.ops] : [], opsLocked: item.group !== 'chat',
			tasks: [...item.tasks], visible: true, tests: {},
			install: { state: install, ...(install === 'failed' ? { error: 'HTTP 503 from huggingface.co while fetching pytorch_model.bin (attempt 3/3).' } : {}) },
			run: item.runtime ? { state: 'stopped', keepLoaded: false } : null,
			...extra,
		};
	}

	function scenario(name) {
		const installed = {
			partial: ['qwen3.8-27b', 'rtdetr', 'ctd', 'hayai-ocr-v2', 'paddleocr-vl-1.6', 'hy-mt2-manga-v5', 'lama-manga', 'big-lama'],
			fresh: [],
			full: CATALOG.map((c) => c.id).filter((id) => id !== 'qwen-image-edit-2511'),
		}[name];
		const failed = name === 'partial' ? ['manga-ocr'] : [];
		const envs = {
			partial: { 'env-ocr': 'installed', 'env-review': 'installed', 'env-workflow': 'installed' },
			fresh: { 'env-ocr': 'missing', 'env-review': 'missing', 'env-workflow': 'missing' },
			full: { 'env-ocr': 'installed', 'env-review': 'installed', 'env-workflow': 'installed' },
		}[name];

		const models = CATALOG.map((item) => {
			const state = installed.includes(item.id) ? 'installed' : failed.includes(item.id) ? 'failed' : 'missing';
			const m = catalogModel(item, state);
			if (item.id === 'qwen3.8-27b' && state === 'installed') {
				m.run = { state: 'running', keepLoaded: true, since: '2 h' };
				m.launch = { preset: 'Qwen 3.8', weights: '~/models/Qwen3.8-27B-IQ3_S.gguf', projector: '~/models/mmproj-Qwen3.8-27B-f16.gguf', port: 18080, device: 'gpu0', ctx: 32768, gpuLayers: 999, slots: 2, startOnBoot: true };
				m.tests = { translate: { ok: true, ms: 4200, at: 'yesterday', preview: '“Wait — you came back for me?”' }, vision: { ok: true, ms: 6100, at: 'yesterday', preview: 'お前、戻ってきたのか' } };
			}
			if (item.id === 'paddleocr-vl-1.6' && state === 'installed') m.run = { state: 'running', keepLoaded: false, since: '12 min' };
			if (item.id === 'hayai-ocr-v2' && state === 'installed') m.run = { state: 'stopped', keepLoaded: false };
			if (name === 'full' && item.id === 'qwen-image-2.1') m.run = { state: 'stopped', keepLoaded: false };
			return m;
		});

		const cli = {
			partial: {
				codex: { found: true, path: '~/.local/bin/codex', source: 'auto', version: '0.61.0' },
				cursor: { found: true, path: '~/.local/bin/cursor-agent', source: 'auto', version: '2026.09.18' },
				grok: { found: false, path: '/opt/grok/bin/grok', source: 'saved', message: 'Saved location /opt/grok/bin/grok does not exist.' },
			},
			fresh: {
				codex: { found: true, path: '~/.local/bin/codex', source: 'auto', version: '0.61.0' },
				cursor: { found: false, path: '', source: 'auto', message: 'cursor-agent not on PATH.' },
				grok: { found: false, path: '', source: 'auto', message: 'grok not on PATH.' },
			},
			full: {
				codex: { found: true, path: '~/.local/bin/codex', source: 'auto', version: '0.61.0' },
				cursor: { found: true, path: '~/.local/bin/cursor-agent', source: 'auto', version: '2026.09.18' },
				grok: { found: true, path: '~/.grok/bin/grok', source: 'auto', version: '1.9.2' },
			},
		}[name];

		if (name === 'partial') {
			models.push(
				remoteRow('work-gpt54', 'Work GPT-5.4', 'openai', 'gpt-5.4', { tests: { translate: { ok: true, ms: 2300, at: '3 days ago', preview: '“You came back… for me?”' }, vision: { ok: true, ms: 3900, at: '3 days ago', preview: 'お前、戻ってきたのか' } } }),
				remoteRow('or-deepseek', 'DeepSeek V4', 'openrouter', 'deepseek/deepseek-v4', { ops: ['translate', 'describe', 'compactNotes', 'advisory', 'alternatives', 'proofreadEnglish'] }),
				cliRow('codex', 'gpt-5.4', { tests: { vision: { ok: true, ms: 11800, at: 'last week', preview: 'お前、戻ってきたのか' } } }),
				cliRow('codex', 'gpt-5.3-codex', { visible: false }),
				cliRow('cursor', 'composer-2.5', { tests: { vision: { ok: false, ms: 9100, at: 'last week', reason: 'Returned no text for the image — kept out of transcription.' }, translate: { ok: true, ms: 5400, at: 'last week', preview: '“You actually came back for me?”' } } }),
				cliRow('cursor', 'auto', { visible: false }),
				cliRow('grok', 'grok-4.6'),
			);
		}
		if (name === 'full') {
			models.push(
				remoteRow('work-gpt54', 'Work GPT-5.4', 'openai', 'gpt-5.4'),
				remoteRow('or-deepseek', 'DeepSeek V4', 'openrouter', 'deepseek/deepseek-v4'),
				cliRow('codex', 'gpt-5.4'),
				cliRow('cursor', 'composer-2.5'),
				cliRow('grok', 'grok-4.6'),
			);
			models.find((m) => m.id === 'qwen3.8-27b').run = { state: 'running', keepLoaded: true, since: '6 h' };
			models.find((m) => m.id === 'qwen3-vl-8b').run = { state: 'running', keepLoaded: true, since: '6 h' };
		}

		models.push({
			id: 'proofread-service', name: 'Page proofreading service', source: 'service',
			ops: ['pageImageProofread'], opsLocked: true, tasks: ['proofread'], visible: true, tests: {},
			service: { envVar: 'SCAN_PROOFREAD_SERVICE_URL', set: name === 'full', url: name === 'full' ? 'http://10.0.0.12:8710' : '' },
			optional: true,
		});

		const envKeys = {
			partial: ['OPENAI_API_KEY'],
			fresh: [],
			full: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
		}[name];

		const defaults = {
			partial: { detect: 'rtdetr', transcribe: ['hayai-ocr-v2', 'paddleocr-vl-1.6'], translate: 'qwen3.8-27b', describe: 'qwen3.8-27b', compactNotes: 'qwen3.8-27b', advisory: 'codex-gpt-5.4', chapterReview: 'codex-gpt-5.4', alternatives: 'qwen3.8-27b', proofreadEnglish: 'work-gpt54', pageImageProofread: '', cleaning: 'codex-gpt-5.4' },
			fresh: { detect: 'rtdetr', transcribe: ['hayai-ocr-v2', 'paddleocr-vl-1.6'] },
			full: { detect: 'rtdetr', transcribe: ['hayai-ocr-v2', 'paddleocr-vl-1.6'], translate: 'qwen3.8-27b', describe: 'qwen3-vl-8b', compactNotes: 'qwen3.8-27b', advisory: 'cursor-composer-2.5', chapterReview: 'codex-gpt-5.4', alternatives: 'qwen3.8-27b', proofreadEnglish: 'qwen3.8-27b', pageImageProofread: 'proofread-service', cleaning: 'qwen-image-2.1' },
		}[name];

		return { name, models, envs, cli, envKeys, defaults, queue: [], history: [] };
	}

	return { GB, HARDWARE, TASKS, STAGES, OPS, CHAT_OPS, ENVIRONMENTS, CATALOG_GROUPS, CATALOG, BUNDLES, CHAT_PRESETS, REMOTE_PRESETS, CLI_DEFS, ENV_KEYS_ALL, scenario, cliRow, remoteRow };
})();
