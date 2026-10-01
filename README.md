# Komatose

SvelteKit + SQLite scanlation assistant. Six-stage manga translation, review, local cleaning, typesetting, and chapter export. Live websocket sync and disk-stored immutable assets.

See [the workflow guide](docs/WORKFLOW.md) for usage, local model setup, migration/API contracts, validation, and remaining GPU/Photoshop acceptance checks.

Dedicated text translators include Hy-MT2 Manga v5, Shisa v2.1 8B Q4, Sugoi v4, Opus-MT Ja→En, and Imsbee Ko→En.
See [translation models](docs/TRANSLATION_MODELS.md) for installation and availability.

## Dev

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173 — first visit creates the admin at `/setup`.
Then open **Admin → Setup** to see what is configured, missing, or unavailable.
See [fresh install](docs/FRESH_INSTALL.md).

```bash
npm run test:unit          # fast Node regressions, including audit fixes
npm run test:integration   # workflow, access, setup, and HTTP contract suites
npm run test:ci            # unit + integration (also `npm test`)
npm run test:workflow      # the large workflow fixture suite only
npm run test:browser       # Playwright acceptance (needs Chromium)
```

Paid model, GPU, and Python worker checks stay on their own scripts (`test:cleaning`, `test:ko-en`, `test:browser-*`).

## Production (this machine)

```bash
npm run build
npm start
```

Listens on `127.0.0.1:3847`. Point Caddy at [`Caddyfile.scan`](Caddyfile.scan) for your host, then reload Caddy. Set `SCAN_SITE_ADDRESS` for Caddy and `SCAN_TRUSTED_ORIGINS` for the app (see [`.env.example`](.env.example)).

Data lives in `data/` (`scan.db` + `images/{seriesSlug}/{episodeSlug}/`). Gitignored.

## OCR worker

Transcription uses Hayai OCR v2 and PaddleOCR-VL-1.6 on CPU. Disagreements get
English from the selected Translation model on each suggestion. The same OCR models are available for
**AI Review** comparisons.
See [Local OCR review](docs/LOCAL_OCR_REVIEW.md) for installation and usage.

Detection and recognition run in a persistent Python subprocess
([`ocr/worker.py`](ocr/worker.py)), spoken to over newline-delimited JSON.
Models load on first use, so a run never pays for a backend it does not touch.

```bash
uv venv --python 3.12 .venv-ocr
uv pip install --python .venv-ocr/bin/python -r ocr/requirements.txt
```

## Text detection

Transcribe detects lettering and compares Hayai with PaddleOCR-VL on every
region. Matching readings fill source; disagreements leave source and English
empty with both readings saved as suggestions for manual council AI Review.
After checking source, Translate drafts English. Proofreading remains optional.
The text detector setup — a box detector (Comic Text Detector, RT-DETR,
PaddleOCR lines or heuristic bubbles), optionally with COO for sound effects
and Koharu for missed lettering — and its confidence are set in **Admin →
Models → Jobs & defaults**. Any chapter can override both next to **Transcribe
chapter**. Default confidence is 0.20 — raise it (often 0.35–0.45) on manhwa if
flames, empty space, or other art are boxed as text.

| Backend | What it is | Notes |
| --- | --- | --- |
| `rtdetr` | RT-DETR v2 fine-tuned on ~11k manga/webtoon/manhua/comic pages | Default. Labels `bubble`, `text_bubble`, `text_free`, so free-floating SFX and narration are found, not just bubbles. ~170MB, ~9s per 690×16000 strip on CPU. |
| `ctd` | comic-text-detector (BallonsTranslator) | YOLOv5 text blocks + UNet mask, ~95MB. Manga-trained, so Korean SFX recall is weaker. |
| `paddle` | PaddleOCR's own detector over the whole page | No extra download, but it scores text *lines*, which then get clustered, and it fires on artwork more often. |
| `heuristic` | The original luma-threshold + distance-transform bubble finder | Pure TypeScript, no model. Only sees thick white or thick dark bubble interiors, so borderless text is invisible to it by construction. |

Weights download from Hugging Face on first use and cache under
`~/.cache/huggingface`. Bubble OCR uses PaddleOCR PP-OCRv5; pick Korean or
Japanese in the editor toolbar (`SCAN_OCR_LANG` sets the default). The first
Japanese run downloads the `japan` recogniser weights.

Regions that read back empty remain visible as unreadable source for review or an explicit ignore decision. Japanese is the default for new projects.

Benchmark the backends against real pages:

```bash
.venv-ocr/bin/python scripts/bench-detect.py --backends rtdetr,ctd,paddle \
  --overlay /tmp/ov data/images/<series>/<episode>/*.jpg
```

`--overlay` writes contact sheets with boxes drawn on, which is the quickest
way to compare recall. For scored numbers against a hand-checked gold standard,
use **Admin → Models → Jobs & defaults → Benchmark** (see
[docs/LOCAL_OCR_REVIEW.md](./docs/LOCAL_OCR_REVIEW.md)).

## AI review and questions

Open **Chapter → AI model settings…** to choose separate description, vision,
translation, proofreading, and chat models, plus up to four source reviewers.
Page image proofreading can optionally use a **proofreading service** you run
separately (see [docs/PROOFREADING_SERVICE.md](./docs/PROOFREADING_SERVICE.md)).
Set `SCAN_PROOFREAD_SERVICE_URL` to enable the proofreader rows; leave it unset and
the tools stay hidden. No proofreading service ships with this app. **AI Review** beside Japanese/Korean source opens the region crop. You can mask
it with detected lettering, tidy the mask, then send it to local reviewers.
Grok, Codex, and Cursor each need their own Run button. **Enquire** beside **Suggest alternative** opens a chat
with selectable context and source/English replacement cards. Replacements need
human acceptance; accepting a changed source automatically retranslates it with the
translation model. A later local edit overwrites a newer saved revision.

## Roles

| Role | Can |
| --- | --- |
| admin | everything, including backend services, billed models, users, and per-series ACL |
| scanlator | all workflows, add series/chapters, invite regular users onto their own series, shared **Test**, and series an admin assigns |
| translator | upload raws, import/edit translations |
| proofreader | edit translations + comments (no upload) |
| typesetter | cleaning, geometry, fonts, typesetting, comments |
