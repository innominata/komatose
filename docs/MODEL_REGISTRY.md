# Named translation-assistant registry

The picker unit is one **named model**, not an engine plus a slug. Saved
`TaskEngine.engine` is a registry row id. `model` is empty unless it is a slug
override different from `row.slug`.

Cleaning is not this product. Codex image inpainting stays on the workflow Clean
path. Proofreader rows are page-image proofread only, and appear only when
`SCAN_PROOFREAD_SERVICE_URL` is set.

## Rows

Each row in the seed table plus `SCAN_DATA_DIR/models.json` overlay has:

- **id** — stable. Seeded CLI ids stay `grok-4.6`, `gpt-5.4`, `composer-2.5`.
  Discovered Cursor slugs that collide with Codex get a prefixed id
  (`cursor-gpt-5.4`); the slug sent to the CLI is unchanged. Cursor `auto` is
  `cursor-auto` so it does not collide with the cleaning method id. Legacy host
  aliases `qwen`, `grok`, `codex`, and `cursor` are reserved and cannot be used
  as row ids.
- **access** — `local_http` | `remote_http` | `cli` | `browser`
- **cliAdapter** — `grok` | `codex` | `cursor` when access is `cli`
- **runtime** — llama.cpp / OpenAI HTTP / Qwen3-VL / Hy-MT / Imsbee / Hayai / Paddle
- **operations** — locked on specialist OCR/translate, CLI family, and proofreaders.
  HTTP chat rows can enable tasks in Admin. Cleaning is never stored here.
- **managedLaunch** — optional local llama.cpp recipe; `null` explicitly means an external service.
- **requestPreset** — `generic` or `qwen-thinking`; independent of HTTP transport.
- **http** — `baseUrl` and `apiKeyEnv` (environment **name** only). Local
  llama.cpp chat does not need `LLAMASWAP_API_KEY`. Remote OpenAI-compatible
  rows do. Keys are never written to the overlay or logs.

Admin: **`/admin/setup`** is where the models on this machine are made to work.
Its Status panel lists configured, missing, and unavailable services from the
registry and CLI discovery plus task coverage (which tasks have a ready model).
Its Local / Remote / CLI tabs add, edit and delete the model configs and discover
what the machine serves: the Local tab also carries the local services (OCR /
review servers, the image editor) and the installers for every model Komatose
can run (grouped by function, with measured disk/memory sizes, the exact command
shown before anything runs); the Remote tab adds and removes OpenAI-compatible
rows and can list `GET {baseUrl}/models`; the CLI tab is a collapse/expand tree
of detected tools and their models. It does not call a model.

**Command-line agents** (Setup) saves optional Grok/Codex/Cursor executable
locations in `SCAN_DATA_DIR/cli-tools.json`. Environment `*_BIN` values still
win; Check discovery does not run the CLI. **Refresh list** is explicit (not on
page load): Cursor `cursor-agent --list-models`, `grok models`, `codex debug
models` JSON (slug + display_name only), llama-swap `GET /models`, remote `GET
{baseUrl}/models`. Refresh fills a discovered table; **Add** / **Add all**
creates a CLI row **hidden from chapter model pickers**.

**`/admin/settings`** (same access as Users) configures the app from what Setup
provides: which rows users can pick, and which tasks each row may run. Rows are
grouped Local / Remote / CLI / Proofreaders / Browser. Any row can be hidden,
including seeds and proofreaders. Use **Show in pickers** on a row, or **Show all
in pickers** on a group or the page, to opt models in. **Hide from pickers** (or
**Hide all from pickers**) sets `disabled` so `/api/ai/engines` and named
profiles omit it. Hidden rows remain for Test. Last catalogs are cached on the
overlay.

**Test** runs that row’s native production path (timing + truncated output).
Hayai `POST /ocr`, Paddle `OCR:` chat, Hy-MT/Imsbee specialist prompts, HTTP/CLI
JSON parsers. Do not send `TRANSLATE_SCHEMA` to Hayai. Proofreaders and cleaning
have no Test. A failed vision Test keeps a chat/CLI slug out of the transcription
set.

## Defaults after hydration

- translate / describe / proofread → `qwen3.8-27b-q4`
- review → `composer-2.5`
- transcription set → Hayai + Paddle when those rows exist

Legacy `{ engine, model }` pairs hydrate to row ids. Known CLI slugs become
that row (`cursor` + `composer-2.5` → `composer-2.5`). Unknown CLI slugs stay
`{ engine: grok|codex|cursor, model: slug }` so they still dispatch through that
host. Other leftover pairs stay visible and disabled. There is no fall-through
of unknown engines to Qwen.

## Transcription

Chapter transcribe runs the selected **N vision-capable rows** (cap 8) in
parallel per region (concurrency 3). A strict plurality of comparable source
strings is auto-applied; **n = 1** accepts that reading. Ties or all failures
leave suggestions. CLI/remote models in the set are billed. Hayai and Paddle do
not have to be installed if other vision models are selected.

## Named profiles

**AI model settings** can save the current translation, proofreading, reviewers,
and transcription selections as a named profile (`Local only`, `CLI agents`).
Profiles live in `SCAN_DATA_DIR/model-profiles.json` as model ids only — no API
keys, env values, or executable paths. Choosing a profile does not change the
series. **Apply profile** validates first and refuses missing, disabled, or
unsupported models instead of substituting another row. Describe, vision, and
Enquire stay on the series until you edit them separately.

## Transfer between installs

**Setup → Transfer named models** exports a versioned `komatose.model-pack`
JSON (version 1): non-seeded remote HTTP rows and CLI rows, plus named
profiles. The file stores environment **names** and `baseUrl` values only.
Userinfo (`user:password@`) and secret query parameters (`api_key`,
`token`, …) are stripped on export and rejected on import. Classification uses
URL parsing and address ranges only — no DNS lookup or network request.

By default the pack omits private, loopback, and link-local HTTP endpoints,
including IPv6 ULA / `::1` / `fe80::`, `localhost` / `*.localhost`, and
`*.local`. **Include private network endpoints** opts those rows in and shows a
preview of what will be included. `local_http` / `file:` rows and seeded rows
are never exported (seeds already exist on every install). API keys,
`cli-tools.json` executable paths, Test probe results, and catalogs stay on
the source machine. Profiles whose selected models were excluded appear in the
preview so you can configure those rows on the destination.

Import previews adds, id/name conflicts, and missing model or env-name
dependencies. A pack that opted into private URLs can be applied; credentials
are still rejected. Apply validates the whole pack first. Conflicts must be
**skipped** or **renamed** with an explicit choice; existing rows are never overwritten. If validation
fails, `models.json` and `model-profiles.json` are left as they were. A crash
between those two writes leaves `model-pack-apply.json`; the next read finishes
the import so the files match. Put the
matching secret in the destination `.env` yourself — the pack does not copy
keys or install CLIs.

`npm run test:browser-model-pack` creates two empty temp installs, a test admin
on each, and fake OpenAI-compatible URLs only. It checks default exclusion,
the include-private preview and download, profile warnings, and that import
conflicts stay blocked until skip or rename. It passed on 2026-09-15 (no live
model calls, no writes to the app data directory). That does not prove a pack from
this host will apply on another machine — set that second install up for real.

See [FRESH_INSTALL.md](./FRESH_INSTALL.md), [HTTP_ENDPOINTS.md](./HTTP_ENDPOINTS.md), and [LOCAL_OCR_REVIEW.md](./LOCAL_OCR_REVIEW.md).

## Remote OpenAI-compatible example

Create a row such as id `work-gpt4o`, slug `gpt-4o`, access `remote_http`,
`apiKeyEnv=OPENAI_API_KEY`. Put the secret in `.env`; the overlay stores the
variable name only.

Managed local model configuration, startup, and lifecycle controls live on **Admin → Setup → Local models → Add local model** and are documented in [MANAGED_MODELS.md](./MANAGED_MODELS.md). Discovery lists contain server-reported models only; there are no seeded Qwen/Gemma rows — their launch presets ship in Setup → Local models instead. Setup reports local availability per model.

## Shared qualification checks

Admin → Models → Jobs now qualifies general language models with Conversation,
Translation, Transcription, and Image Understanding checks. The two image checks
share one request but retain independent outcomes. Job availability is derived:

- Transcription enables OCR and Review Transcription. Reviewers return independent
  readings; the selected translator supplies English separately.
- Translation enables Translate and Review Translation.
- Conversation enables scene-note summarization and chapter review.
- Conversation plus Translation enables alternatives, English proofreading, and Enquire.
- Conversation plus Image Understanding enables page descriptions.
- All four enable page-image proofreading.

Detection, text masks, bubble segmentation, inpainting, and image editing retain
separate integration checks. Adapter support still limits available jobs. Native
OCR and translation adapters only need their respective capability check. Browser
proofreaders and custom command adapters retain direct integration checks; custom
transcription review uses their existing `vision` operation.

Capability samples and history are stored separately from job probe history.
Legacy language-job passes remain visible in the model drawer but do not qualify
general models under the new checks. Model/configuration, adapter, and fixture
changes invalidate evidence. A cancelled or transiently failed retry preserves a
current pass; a completed validation failure supersedes it. Runtime job output
validation and task-specific regression tests remain in place.

The admin test endpoint accepts `{ action: "test", id, check }`, where `check` is
one of `conversation`, `translation`, `transcription`, `imageUnderstanding`, or an
adapter-supported integration job ID. The response includes `samples`, the updated
row, and a compatibility `sample`; an image request returns two capability samples.
