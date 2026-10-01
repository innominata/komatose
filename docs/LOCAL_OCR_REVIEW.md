# Local OCR transcription and AI Review

**Transcribe chapter/page** runs the series **transcription model set** (default
Hayai OCR v2 + PaddleOCR-VL-1.6) on every detected region, including free text
and SFX. The Clean-step text detector masks the source page once; each
recognition crop retains lettering and whites out surrounding artwork. Region
OCR, image rereads, and fill-missing OCR also mask their inputs before reading.

Comparable keys ignore whitespace, canonical Unicode composition, and
interchangeable dashes/tildes/separator dots (`-` vs `~`, wrapping). Differences
in letters, numbers, prolonged-sound ー, or other punctuation still count.

**Plurality:** nonempty successful readings are clustered by that comparable key.
The source is auto-applied when the largest cluster is **strictly larger** than
the next (a single selected model is enough). If Paddle is in the winning
cluster, its spacing is preferred; otherwise the longest string wins. Ties, all
errors, or empty text leave source/English empty, mark the region for review, and
save per-model suggestions with English from the selected Translation model
(from that transcription alone, no image). No AI Review council runs
automatically. Existing human edits and approved/ignored text survive
retranscription. Blank cleanup preserves pending source suggestions.

Choose the set in **AI model settings → Transcription models** (up to eight rows
that are OCR specialists or have a passing vision Test). Chapter transcribe runs
the whole set, including billed CLI/remote rows if you added them. Hayai and
Paddle do not have to be installed when other vision models are selected.

**Fill missing source & English** uses that same plurality on placed regions
that still have no source, then translates only empty English on sourced
regions and pending source suggestions. It never overwrites source or English
that already exists.

Run local reviewers with the region's **AI Review** button, or accept/edit a source
manually. On Japanese chapters, **Enter characters** (Review sidebar and the AI
Review dialog) opens a hiragana chart with diacritic, digraph, and katakana
toggles, series-glossary kanji keys, and a scratchpad that OCRs a handwritten
glyph with Accept/Reject before inserting. Korean chapters keep the plain
source textarea only.

The review dialog opens with **Mask crop with detected text** enabled
and starts detection immediately. Send waits for detection; brush or erase to
refine the mask, or uncheck masking to send the original crop. Detection uses
Drawing a region starts the same selected transcription set used by Transcribe.
**Send to local reviewers** runs Hayai, PaddleOCR-VL, Qwen3-VL-8B, and any other
local row. Grok, Codex, Cursor, and remote HTTP rows require a separate **Run**
press so they are not billed when a local reading is already good. Accepting a
source suggestion uses the existing corrected-source translation workflow. The
chapter's **Translation model** controls translation; **AI Vision / Read area**
remains the explicit manual image-reading model.

Chapter → **AI model settings…** → **Source reviewers** → **Add local OCR reviewers** adds:

| Model ID | Runtime | Weights |
| --- | --- | --- |
| `hayai-ocr-v2` | CPU PyTorch, float32 | JustANormalTinkerer/hayai-ocr-v2 |
| `paddleocr-vl-1.6` | CPU llama.cpp, full precision | PaddlePaddle/PaddleOCR-VL-1.6-GGUF |
| `qwen3-vl-8b` | CPU llama.cpp, Q8 weights and F16 vision projector | unsloth/Qwen3-VL-8B-Instruct-GGUF |

The engine selector lists **named models** (Hayai, Paddle, Qwen3-VL, CLI slugs).
**Add local OCR reviewers** stores each as its own row id (`hayai-ocr-v2`, not
`qwen` + slug). They are offered as source reviewers and as members of the
transcription set once vision-capable.

Up to five reviewers can be saved for **AI Review** (separate from the
transcription set). Click a region's **AI Review** button to compare the local
readings. Use **Run** on Grok, Codex, Cursor, or remote HTTP rows only when
those extra opinions are needed. Suggestions change the text only when accepted.

Every reviewer sees the same crop without the saved transcription or competing
answers. Hayai and PaddleOCR-VL return raw transcriptions using their native
interfaces. The selected Translation model translates each of those strings
separately, without an image or other reading. The source is never replaced by
the translator's output. Review cards identify both models; shared translation
is not an independent vote about the image. Qwen3-VL-8B's own review still
reads the image and produces its own transcription, English, and findings.

CPU reviews run sequentially to avoid overloading the machine. External
reviewers can respond concurrently. Each active local review has a 15-minute
limit; cancelling stops its inference. Workers start on demand, stay warm
between reviews, and stop after five idle minutes or app shutdown. They bind
only to loopback with per-process random access tokens. Their logs are in
`data/logs/review-*.log`.

GPU mode keeps Hayai on `SCAN_REVIEW_HAYAI_PORT` (18083), PaddleOCR-VL on
`SCAN_REVIEW_PADDLE_PORT` (18081), and Qwen3-VL-8B on `SCAN_REVIEW_QWEN_PORT`
(18082). Chat models must use `SCAN_LLM_PORT` (18080).

**Admin → Models → Jobs & defaults → Benchmark** scores models against the ten pages
in `fixtures/test-pages` (*Give My Regards to Black Jack* vol. 1, pp. 1–10). The gold
standard is in `src/lib/benchmarkGold.ts`: a box around every piece of lettering, the
Japanese as printed, the official English from `fixtures/test-pages/english`, a literal
translation, and meaning checks per line. There are two separate benchmarks:

- **Detection & OCR** runs every text detector setup (RT-DETR, Comic Text Detector,
  PaddleOCR lines, geometric bubbles, and the COO and Koharu supplements, alone and
  combined as chapter transcription combines them). Recall counts speech, captions,
  and SFX found; boxes on signs and titles are neutral; boxes on artwork are false.
  OCR models then read crops cut from the gold boxes (recognition alone) and/or from
  chosen detectors (the chapter pipeline), using the same read path as chapter
  transcription. CLI and remote vision rows make one full-page call per page. Lines
  are scored by character accuracy; text no gold line accounts for is noise.
- **Translation** sends each page's gold Japanese to the translation model the way
  chapter translation does, so OCR errors play no part, and scores chrF against the
  official English and against the literal reference, plus the meaning checks.

One benchmark runs at a time and can be cancelled. The last run of each is saved in
`data/run/model-benchmark-ocr.json` and `model-benchmark-translation.json`, and the
page viewer overlays gold and detected boxes with each line's reading or translation.
Hidden picker rows are omitted. llama-server `/health`
does not check the API key, so the app verifies `/v1/models` (or Hayai `/health`)
before treating a port as that OCR server. A chat model bound to a review port
is reported as occupied instead of `HTTP 401 Invalid API Key`.

**Admin → Setup → Local OCR / review servers** shows whether each process is
running, stopped, or serving a different model, with Start / Stop / Restart.
Stop refuses a PID that is not that reviewer. After `killall llama-server`,
use that panel rather than assuming the OCR server is still up.

## Page clipboard and proofreader

Select a page in **Review** or **Typeset**. The floating toolbar's **Images** group
has **Copy raw image**, **Copy typeset image**, and **Proofread raw + typeset images**.
Copies are full-size PNGs; raw means the current prepared page with source
lettering, including page crops/reslicing. Typeset uses saved cleaning and layout,
including visible overflow, without editor selection handles or automatic refitting.
Pending text drafts are saved first. Clipboard images require HTTPS/localhost and
a browser supporting image clipboard writes.

The proofreader uses **AI model settings → Proofreading (English / page images)**.
Choose an image-capable model. It receives raw first and typeset second, asks for
translation and lettering critique, and makes no edits. A configured
**proofreading service** (see [PROOFREADING_SERVICE.md](./PROOFREADING_SERVICE.md))
carries those two JPEGs into a per-proofreader conversation, so later pages keep the
same context. It receives only the images and any follow-up text you type — no system
prompt, captions, or JSON schema. Formatting and JSON-to-critique conversion happen in
the app after the service replies. API proofreading still uses the system prompt. A
second send of the same page attaches only the updated typeset as a follow-up;
sending from another page resets and includes the raw again. The
modal may be closed while the job runs. **Jobs & downloads → Open critique**
(duplicated on the collapsed jobs header) reopens the stored response, even after a
reload or server restart, without another model call. The critique window can send a
typed follow-up, including pasted images, into that same tab or model; each reply is
a new saved critique. **Attach working draft** captures the current typeset page;
**Attach raw source** captures the current raw page. Both submitted images are immutable snapshots in
the modal, collapsed until you expand **Images submitted**. Retry on a failed job uses its captured images when available; clicking
the toolbar action again after a completed run creates a new critique of the
current page. **Clear finished** removes completed job history, including its
saved critiques.

## Install or reproduce

From the repository root, with an existing recent llama.cpp build that supports
PaddleOCR-VL and Qwen3-VL:

```bash
uv venv --python 3.12 .venv-review
uv pip install --python .venv-review/bin/python --index-url https://download.pytorch.org/whl/cpu 'torch==2.14.0+cpu'
uv pip install --python .venv-review/bin/python -r ocr/requirements-review.txt
.venv-review/bin/python scripts/install-review-models.py
```

The installer downloads pinned revisions, verifies file sizes and SHA256
checksums for the weights, and writes `SCAN_DATA_DIR/models/review/installed.json`
(default `data/models/review`) with the revisions and checksums. Hayai's pinned
model implementation and the small SigLIP2 processor/configuration are stored
locally. Inference runs offline. Total model storage is approximately 12 GB;
the Python environment is separate from the original `.venv-ocr` and
`.venv-workflow` environments.

Optional environment settings:

```dotenv
SCAN_REVIEW_MODELS_DIR=/path/to/komatose/data/models/review
SCAN_REVIEW_PYTHON=/path/to/komatose/.venv-review/bin/python
SCAN_REVIEW_LLAMA_SERVER=/path/to/llama.cpp/build-vulkan/bin/llama-server
SCAN_REVIEW_THREADS=8
SCAN_PROOFREAD_SERVICE_URL=http://127.0.0.1:9231
SCAN_PROOFREAD_SERVICE_TOKEN=
```

The GGUF workers explicitly disable both model and vision GPU offload, even
when using a Vulkan-enabled llama.cpp binary. Hayai uses CPU-only PyTorch.
The GGUF context size is 8192 tokens. Changing the GPU deployment later requires
changing the worker launch configuration; the current setup never depends on
either GPU being available.

## Validation

```bash
npm run test:review
npm run test:model-benchmark
npm run test:review-workflow
npm run test:kana-entry
node scripts/test-browser.mjs scripts/check-browser-page-proofread.mjs
node scripts/test-browser.mjs scripts/check-browser-local-review.mjs
node --import tsx scripts/smoke-review-models.ts /path/to/japanese-crop.jpg /path/to/korean-crop.jpg
npm run test:browser-review-servers
npm run test:browser-model-benchmark
```

The inference smoke test runs the complete review adapters, checks for a source
and English translation, and prints model outputs and elapsed times. It uses a
temporary database and does not change chapter text or call external models.
Use manually verified transcriptions for accuracy comparisons; smoke tests
only establish that the models and review integration work.

Sources: [Hayai OCR](https://github.com/NopeNopeGuy/hayai-ocr),
[PaddleOCR-VL-1.6 GGUF and native prompt](https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF),
[Qwen3-VL-8B Instruct GGUF](https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF).
