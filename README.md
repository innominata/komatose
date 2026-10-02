# Komatose

Self-hosted scanlation studio. SvelteKit + SQLite, with local-first AI for the
slow parts: text detection, OCR, translation, cleaning, and typesetting. One
chapter screen walks a team through six steps — **Prepare → Translate → Review →
Clean → Typeset → Export** — with live websocket sync and disk-stored,
immutable page assets.

The screenshots below use the bundled test series, *Give My Regards to Black
Jack* (volume 1, pages 1–10), running on a real install. See [License](#license)
for artwork credit.

![Series library](docs/images/01-library.png)

## What it does

| Step | What happens | Main tools |
| --- | --- | --- |
| **Prepare** | Upload raws, reorder, split spreads, auto-crop, auto-align, reslice webtoon strips, add scene notes and series credits. | Organize grid, Nudge page, Scene notes model |
| **Translate** | Detect lettering, read it with two OCR models, draft English. | Transcribe, Translate, Fill missing source & English |
| **Review** | Approve English, compare model suggestions, ask questions about a region. | AI Review, Revise English, Enquire, Proofread |
| **Clean** | Mask the lettering, remove it, touch up, approve. | Detect lettering, LaMa / AOT / Qwen-Image-Edit / Codex, clone, blur, restore |
| **Typeset** | Fit English into bubbles with real fonts, then refine. | Auto-fit, Find & fit bubbles, skew, warp, text masks |
| **Export** | Resolve blockers, then build a ZIP, PSD, or public viewer link. | PNG / JPG / PSD / clean / scripts / JSON |

### Prepare

Upload, order, and organize pages. Each page carries a **scene note** —
a visual description (no lettering) that translators and models see but that
is never drawn on the page.

![Prepare](docs/images/03-prepare.png)

### Translate

**Transcribe** detects every text region and compares Hayai OCR v2 with
PaddleOCR-VL-1.6. Matching readings fill the source; disagreements keep both
readings as suggestions for review. **Translate** then drafts English with the
selected translation model, using scene notes, the glossary, and earlier lines
as context. The detector (here RT-DETR + Koharu at 0.20 confidence) and the
translation model are chips on the stage bar.

![Translate](docs/images/04-translate.png)

### Review

The inspector queues what still needs a human: unreadable source, missing
English, and unapproved lines. **Review Transcription** and **Review
Translation** ask a council of models; **Enquire** opens a chat with
selectable context; **Approve & next** moves on. Nothing is approved
automatically.

![Review](docs/images/05-review.png)

**Review Transcription** opens the region's crop beside every reader's answer
(Qwen3-VL, Hayai, Manga OCR, PaddleOCR-VL). Each reviewer reads the crop
independently and shows its source reading with an English draft. You can mask
the crop with detected lettering and tidy it with the brush before sending,
then **Use source & English** on the reading you trust or reject the rest.

![Review Transcription](docs/images/18-review-transcription.png)

**Review Translation** (Revise English) runs a council of text translators on
the saved source only, without sending the crop. Each card shows that model's
wording, or notes that it matched the current English. **Use English** replaces
the draft with a suggestion; **Reject** drops it. Fast models such as Hy-MT
sample several wordings, while thinking models translate once. Choose the
council in **Council settings…** or add another translator for the session.

![Review Translation](docs/images/19-review-translation.png)

### Clean

Four numbered stages — Mask, Remove, Touch up, Approve. Detect lettering with
Comic Text Detector or Koharu, brush or grow the mask, then remove it with
LaMa Manga, Big-LaMa, AOT, Telea, flat fill, clone/patch, or an image editor
(Qwen-Image-Edit 2511, Codex). Every pass is undoable and the raw page never
changes.

![Clean](docs/images/06-clean.png)

After **Big LaMa** runs on the approved mask, the page reads "mask approved · cleaned" and the Touch up stage opens, with **Approve cleaned & next** ready.

![Clean result](docs/images/06b-clean-result.png)

### Typeset

Fonts are shaped with Fontkit, fitted to bubble polygons, and stored with
their layout so exports match the editor. Per-type styles, skew, Photoshop
Warp Text, per-region text masks, and a locked-layout system keep manual work
safe from refits.

![Typeset](docs/images/07-typeset.png)

### Export

Export lists every blocker by page and step. A finished export needs every
page marked complete in Translate, Review, Clean, and Typeset; drafts and
script/JSON handoffs do not. Choose PNG, JPG (4:4:4), editable PSD, clean
images, bilingual/English scripts, or JSON with revisions, and optionally
share a public read-only viewer link.

![Export](docs/images/08-export.png)

### Admin → Models

One area for everything model-related, split into six tabs.

**Overview** — what Komatose can do on this machine, by job, with the default
model for each. Checks are free: they look at files, ports and variable names
and never call a model.

![Admin models overview](docs/images/09-admin-models.png)

**Models** — every model in one searchable list: installed weights, local
servers, remote APIs, CLI agents, and services. Filter by status, source or
job, and choose per row whether users can pick it.

![Models list](docs/images/10-models-list.png)

**Install** — everything downloadable, grouped into bundles (Essentials, Local
translation, Light chat & vision, Local cleaning). Required Python
environments are queued first, and each install runs in the background with
its exact command shown.

![Install bundles](docs/images/11-models-install.png)

**Jobs & defaults** — the capability grid: which model passed which check
(chat, translation, OCR, vision, detect, mask, inpaint, edit), with test
buttons and the per-job default.

![Jobs and defaults](docs/images/12-models-jobs.png)

**Benchmark** — scores models against a hand-checked gold standard on the
bundled test pages. The Translation view runs one request per page per model
and reports chrF against the official and literal references, the share of key
terms carried over, missing lines, and time per page. A Detection & OCR view
covers detectors and readers. It is reached from **Jobs & defaults**.

![Benchmark](docs/images/15-benchmark.png)

Below the scores, **Lines** puts one model's output next to the raw page and the
typeset page, line by line, against the Japanese, the official English, and a
literal reference, each with its chrF score. The official edition is a
localisation, so good translations rarely pass 60 against it.

![Benchmark lines](docs/images/16-benchmark-lines.png)

The **Detection & OCR** view scores boxes and readings separately. Pick which
detector supplies the boxes and which reader supplies the text, and the page
shows gold boxes, detections and false boxes over the artwork, with a per-line
table of the gold Japanese against what was read. The summary line reports how
many required boxes were found, how many false boxes appeared, and the time.

![Benchmark detection and OCR](docs/images/17-benchmark-detection-ocr.png)

**Hardware & services** — memory per device with what is resident, system
memory, PyTorch environments, and Start/Stop/Restart for every service.

![Hardware and services](docs/images/13-models-hardware.png)

**Guided setup** — a four-step wizard (Translation, Reading pages, Cleaning,
Review & install) for fresh machines. It detects your hardware and queues the
installs.

![Guided setup](docs/images/14-models-setup.png)

## Quick start

```bash
npm install
cp .env.example .env     # set SCAN_ROOT and DATABASE_URL
npm run dev              # http://127.0.0.1:5173
```

1. Open `/setup` and create the first admin.
2. Open **Admin → Models → Guided setup** (or **Overview**) to see what is
   ready, missing, or unavailable, and install what you need.
3. On the library page, **Add** a series, or **Add Test Pages** to try the
   workflow with sample pages.

You need **one** working translation backend — a local OpenAI-compatible chat
server, a remote API, or a Grok / Codex / Cursor CLI on the server. OCR,
specialist translators, cleaners and the proofreading service are optional.
See [fresh install](docs/FRESH_INSTALL.md).

### Production

```bash
npm run build
npm start
```

Listens on `127.0.0.1:3847`. Point Caddy at [`Caddyfile.scan`](Caddyfile.scan)
for your host and reload it. Set `SCAN_SITE_ADDRESS` for Caddy and
`SCAN_TRUSTED_ORIGINS` for the app (see [`.env.example`](.env.example)).
`npm run rebuild` (also **Rebuild and restart** in the top bar, admin only)
rebuilds and restarts the service.

Data lives in `data/` — `scan.db` plus `images/{seriesSlug}/{episodeSlug}/` —
and is gitignored. Back the two up together. `SCAN_DATA_DIR` and
`DATABASE_URL` allow isolated instances.

## Models

| Job | Default or choices |
| --- | --- |
| Detect text | RT-DETR (default), Comic Text Detector, PaddleOCR lines, heuristic bubbles; optional COO for SFX and Koharu for missed lettering |
| Transcribe | Hayai OCR v2 + PaddleOCR-VL-1.6 (CPU); Qwen3-VL and other vision models for AI Review |
| Translate | Set per machine in **Jobs & defaults** (CAT-Translate 7B on the screenshot install); CAT-Translate 7B, Hy-MT2 (1.8B Manga v5, 7B), TranslateGemma, Shisa v2.1, Sugoi v4, Opus-MT Ja→En, Imsbee Ko→En, remote OpenAI-compatible APIs, Grok / Codex / Cursor |
| Scene notes, AI review, proofread | Any image-capable chat model |
| Text masks | Comic Text Detector, Koharu |
| Clean artwork | LaMa Manga, Big-LaMa, AOT, Qwen-Image 2.1, Qwen-Image-Edit 2511, Codex reconstruction |

Models are chosen per series under **Settings → AI models** and can be saved as
named profiles. Defaults per job live in **Admin → Models → Jobs & defaults**.

- [Managed local models](docs/MANAGED_MODELS.md) and [model registry](docs/MODEL_REGISTRY.md)
- [Translation models](docs/TRANSLATION_MODELS.md)
- [Local OCR and AI review](docs/LOCAL_OCR_REVIEW.md)
- [Text detection](docs/TEXT_DETECTION.md)
- [Qwen-Image-Edit 2511](docs/QWEN_IMAGE_EDIT_2511.md)
- [CLI adapters](docs/CLI_ADAPTERS.md) · [HTTP endpoints](docs/HTTP_ENDPOINTS.md)
- [Model packages](docs/MODEL_PACKAGES.md) · [proofreading service](docs/PROOFREADING_SERVICE.md)

### OCR and detection workers

Detection and recognition run in a persistent Python subprocess
([`ocr/worker.py`](ocr/worker.py)) spoken to over newline-delimited JSON.
Models load on first use, so a run never pays for a backend it does not touch.

```bash
uv venv --python 3.12 .venv-ocr
uv pip install --python .venv-ocr/bin/python -r ocr/requirements.txt
```

Cleaning and segmentation use a second environment (`.venv-workflow`); see the
[workflow guide](docs/WORKFLOW.md#local-worker-setup). Weights download on
first use and cache under `~/.cache/huggingface`. Default OCR language is
Japanese for new projects; pick Korean or Japanese in the editor toolbar
(`SCAN_OCR_LANG` sets the default).

Raise detector confidence (often 0.35–0.45) on manhwa if art is boxed as text;
set it per chapter next to **Transcribe chapter** or machine-wide in **Admin →
Models → Jobs & defaults**. Benchmark detectors on real pages with
`scripts/bench-detect.py` (see [text detection](docs/TEXT_DETECTION.md)).

## Roles

| Role | Can |
| --- | --- |
| admin | everything, including backend services, billed models, users, and per-series ACL |
| scanlator | all workflows, add series/chapters, invite regular users onto their own series, shared **Test**, and series an admin assigns |
| translator | upload raws, import/edit translations |
| proofreader | edit translations + comments (no upload) |
| typesetter | cleaning, geometry, fonts, typesetting, comments |

## Tests

```bash
npm run test:unit          # fast Node regressions
npm run test:integration   # workflow, access, setup, and HTTP contract suites
npm run test:ci            # unit + integration (also `npm test`)
npm run test:workflow      # the large workflow fixture suite only
npm run test:browser       # Playwright acceptance (needs Chromium)
npm run check              # svelte-check
```

Paid model, GPU, and Python worker checks stay on their own scripts
(`test:cleaning`, `test:ko-en`, `test:browser-*`, `test:image-edit`,
`test:codex-cleaning`).

## Documentation

| Guide | Covers |
| --- | --- |
| [WORKFLOW.md](docs/WORKFLOW.md) | Every step, region AI, layout/PSD contract, local workers, API contracts, validation |
| [FRESH_INSTALL.md](docs/FRESH_INSTALL.md) | Smallest working install and the Admin → Models pages |
| [LOCAL_OCR_REVIEW.md](docs/LOCAL_OCR_REVIEW.md) | OCR models, council review, page clipboard |
| [TEXT_DETECTION.md](docs/TEXT_DETECTION.md) | Detector backends, COO, Koharu, benchmarks |
| [TRANSLATION_MODELS.md](docs/TRANSLATION_MODELS.md) | Specialist translators and installers |
| [LETTERING.md](docs/LETTERING.md) | Detection and lettering-mask details |
| [MANAGED_MODELS.md](docs/MANAGED_MODELS.md) · [MODEL_REGISTRY.md](docs/MODEL_REGISTRY.md) · [MODEL_PACKAGES.md](docs/MODEL_PACKAGES.md) | Local model lifecycle, registry, moving setups |
| [CLI_ADAPTERS.md](docs/CLI_ADAPTERS.md) · [HTTP_ENDPOINTS.md](docs/HTTP_ENDPOINTS.md) | Grok/Codex/Cursor adapters and OpenAI-compatible contracts |
| [QWEN_IMAGE_EDIT_2511.md](docs/QWEN_IMAGE_EDIT_2511.md) | Image-edit cleaning |
| [PROOFREADING_SERVICE.md](docs/PROOFREADING_SERVICE.md) | Optional page-image proofreader |

## License

**Application code** — [MIT License](LICENSE). Copyright (c) 2026 innominata.

**Test series artwork** — Pages in [`fixtures/test-pages/`](fixtures/test-pages/)
and screenshots in [`docs/images/`](docs/images/) are from *Give My Regards to Black
Jack* (volume 1, pages 1–10). Shuho Sato and Sato Manga Works Ltd. permit reuse
under [densho810.com/free](https://densho810.com/free/). Credit for this
repository is here and in [`docs/images/ATTRIBUTION.txt`](docs/images/ATTRIBUTION.txt).
Shipped exports include `attribution.txt` when the series applies; bundled page
files include [`fixtures/test-pages/ATTRIBUTION.txt`](fixtures/test-pages/ATTRIBUTION.txt).

```
ブラックジャックによろしく
佐藤秀峰
Give My Regards to Black Jack
SHUHO SATO
```
