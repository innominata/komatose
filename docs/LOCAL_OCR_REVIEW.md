# Local OCR transcription and AI Review

## Korean recognizers

**Admin → Models → Setup** offers two separate installable readers:

- **PP-OCRv5 Korean** (`pp-ocrv5-korean`) uses the official
  [korean_PP-OCRv5_mobile_rec](https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec)
  with a local PP-OCRv5 text detector to split multiline crops. It uses
  `.venv-ocr` (or `PADDLEOCR_PYTHON`) and CPU PaddlePaddle, including on AMD Linux.
  The recognition weights are about 13 MB; the detector adds about 88 MB.
- **Hayai OCR v2.5 Nova** (`hayai-ocr-v2.5-nova`) uses the
  [publisher's checkpoint](https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova)
  and SigLIP2 configuration through `.venv-review` (or `SCAN_REVIEW_PYTHON`).
  It supports Japanese and Korean crop transcription and the existing CPU/ROCm/CUDA
  device selection. The app uses 512 patches and greedy decoding with repetition
  penalty 1.0. Hayai v2 remains a separate choice.

After installation, run **Transcription** under the model's checks, then select the
reader in **AI model settings → Transcription**. The test includes an original
Korean fixture so a Korean-only reader is not judged against Japanese text. Both
readers transcribe source only; English comes from the selected translator. Neither
reader replaces the current transcription set automatically.

```bash
.venv-ocr/bin/python scripts/install-review-models.py --model pp-ocrv5-korean
.venv-review/bin/python scripts/install-review-models.py --model hayai-ocr-v2.5-nova
```

For machines with existing official PaddleX assets, the PP-OCRv5 installer supports
`--paddlex-cache /path/to/.paddlex/official_models`. This reuses configuration files
and verifies both weight files against their pinned SHA256 hashes before copying;
the receipt records that configuration came from the local cache. Normal downloads
pin repository revisions and verify Hugging Face file metadata.

Setup checks both PP-OCRv5 subfolders rather than looking only for top-level
files. Installed models are skipped by the install queue. Rerunning the Korean
installer checks the pinned receipt, file sizes and SHA256 hashes locally; a
complete verified installation finishes without contacting the download service.

Old qualification results are warnings when the implementation changes. They do
not disable an installed reader or force an automatic retest during transcription.
Current failed checks and explicit disabled settings still block use.

The PP-OCRv5 worker was checked on 24 original clean Korean controls (24 exact
matches), plus ten real crops independently inspected without using saved
approval status (eight exact matches after whitespace/NFC normalization).
The two misses omitted punctuation; all Hangul characters matched. Two uncertain
stylized crops were excluded. With bounded crop upscaling, warmed CPU recognition
took a median 107 ms on those real crops and 348 ms on the larger controls;
model loading took about 2.2 seconds. These are worker inference timings,
excluding HTTP/queue overhead, and a small sample rather than an accuracy guarantee.
Blank and multiline controls also passed. Repeat offline integration and installer
checks with `npm run test:korean-ocr`; they do not download weights or test Nova's
recognition quality.


**Transcribe chapter/page** runs the series **transcription model set** (default
Hayai OCR v2 + PaddleOCR-VL-1.6) on every detected region, including free text
and SFX. The Clean-step text detector masks the source page once; each
recognition crop retains lettering and whites out surrounding artwork. Region
OCR, image rereads, and fill-missing OCR also mask their inputs before reading.

**Installable transcription decider:** Admin → Models → Install → Transcription
deciders → **Liquid AI d1-3B Q8** installs the Q8 model, F16 vision projector,
and a dedicated pinned llama.cpp Vulkan runtime. On Linux the runtime build
requires `git`, `cmake`, a C++ compiler, Vulkan development headers and `glslc`
(for Debian/Ubuntu: `build-essential cmake git libvulkan-dev glslc`). The files
use approximately 3.73 GB plus runtime/build space. The runtime supports AMD
cards through Vulkan; ROCm is not needed. It does not replace other llama.cpp
installations. Downloads resume and verify pinned sizes and SHA256 checksums.

Installation leaves the decider default unchanged. The current d1 model has
not qualified for automatic transcription selection; installing it must not
change the chapter's OCR behavior. Select a default explicitly after testing.
Series AI model settings → Transcription offers **Default**, **Off**, or a tested
decider. Run **Decide Transcription** under model tests to qualify it. Default
picks up later default changes; explicit Off stays off. Settings, profiles and
model packs retain the selection and confidence thresholds.

With a decider enabled, every distinct OCR disagreement is checked against the
same masked crop, including disagreements with a plurality winner. It receives
the candidate strings and language, without engine identities, vote counts,
translations or series notes. It can select a minority reading, choose **none
match**, or abstain because the crop is **too unclear**. It never generates a
replacement transcription. A candidate is auto-applied only at probability
**0.80** or higher and a lead of **0.15** or higher over every other option.
These adjustable scores are model probabilities, not measured OCR accuracy.
Low confidence, abstention and service/validation errors leave readings for
review without falling back to the plurality. Existing human/approved/ignored
text remains protected. Changed region geometry or source page prevents stale
results from being applied. Saved region details show probabilities and the
applied/review status; historical decisions are marked when their context changes.

The isolated runtime is on demand. Stop d1 before reinstalling or uninstalling;
its runtime cannot be removed while d1 is installed. Artifacts live under
`data/models/deciders/d1-3b` and `data/runtimes/llama-decider`; deployments can
set `SCAN_DECIDER_MODELS_DIR` and `SCAN_DECIDER_RUNTIME_DIR`.
`npm run smoke:decider -- Vulkan2` runs a real Japanese crop test in both
candidate orders using an owned temporary server (choose your Vulkan device
from `llama-server --list-devices`). It reports hardware support separately
from OCR qualification; add `--require-qualified` to require the latter.
The managed d1 process disables Vulkan shader fusion to avoid an observed
RADV ACO compile stall on RX 7900 XTX.
The current pinned model did not qualify on the fine-grained Japanese reading
pair `待って` versus `持って` with abstention options. Controlled diagnostics
confirmed that image input works: it classified Japanese/Korean/English
correctly on all 18 visual tests (six generated text images, three answer orders),
and recognised blank/text, colours and shapes. CPU and Vulkan chose the same
answers on all 30 shared tests. With just the two Japanese candidates it
weakly favoured the right reading (~56%); adding abstention options made it
choose “none match”. These controls establish basic functionality, not reliable
manga OCR selection. Installation does not override the qualification gate.
Run `npm run diagnose:decider -- Vulkan2` and `npm run diagnose:decider -- CPU`
to repeat the controls; each run prints its temporary image/result/log directory. `npm run test:decider` runs offline tests.

**Korean evaluation:** d1 is currently unsuitable for automatically verifying
Korean OCR or deciding to skip paid fallback. In a controlled test of 24 clean
Korean text images (12 calibration phrases, 12 held-out phrases), its native
yes/no verifier accepted deliberately changed consonants/vowels or missing/extra
characters above 90% probability in both splits. At 95%, no correct control
reading was confirmed in either split. Raising confidence therefore did not
produce a useful operating threshold in this test. The crop-quality classifier
also called damaged text “easy” above 95%. These are task failures with a
working image model, not evidence of a broken AMD setup.

The existing local PaddleOCR-VL-1.6 service read all 24 clean controls correctly.
Among ten real crops independently inspected before checking saved readings,
it matched eight exactly after whitespace/NFC normalization; one miss changed
Korean letters and one changed punctuation. Two less certain stylized crops
were excluded. This small sample supports trying local OCR first, but does
not establish that every high-quality Korean crop is correct. Saved approval
status is never used as ground truth by the evaluator.

On RX 7900 XTX Vulkan, 30 warmed single-question HTTP requests had approximately
93 ms median and 94 ms p95 latency; loading the owned test server took about
1.8 seconds. Five crop-quality questions took about 425 ms per request. These
include request processing and image evaluation, rather than only GPU compute.

Repeat with `npm run evaluate:decider-korean -- Vulkan2` for synthetic controls.
Add `--native-binary` for the model's native yes/no question format. Private
candidate crops can be supplied with `--approved=/absolute/private/manifest.json`;
that historical flag supplies candidates, **not trusted labels**. To score real
crops, also provide `--independent-review=/absolute/private/review.json`, with
`id`, `independentReading`, `status: "independently-reviewed"`, and
`visualConfidence: "high"` per independently checked crop. Unverified crops
are excluded from accuracy summaries. `--ocr=http://127.0.0.1:18081` compares
the existing local Paddle service using its resident token. HTTP errors count
as request failures, not wrong transcriptions. `--reuse=/tmp/.../results.json
--native-binary --stress` tests character mutations on previous clean controls.
All images and detailed results stay in private temporary directories; only
aggregate scores are printed. No paid services are called.

Model and API reference: [Liquid AI d1-3B-GGUF](https://huggingface.co/LiquidAI/d1-3B-GGUF).

Comparable keys ignore whitespace, canonical Unicode composition, and
interchangeable dashes/tildes/separator dots (`-` vs `~`, wrapping). Differences
in letters, numbers, prolonged-sound ー, or other punctuation still count.

**When the decider is Off or no default is installed — plurality:** nonempty successful readings are clustered by that comparable key.
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
