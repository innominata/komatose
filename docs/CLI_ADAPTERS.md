# CLI adapter foundation

The first adapter boundary covers structured advisory requests, used by region AI
and scene-note compaction, plus CLI translation attempts, executable discovery, default models and model
listing. Grok, Codex and Cursor keep their existing saved IDs, environment settings,
command options, output parsing and shared process runner.

## Interface

`src/lib/server/cliAdapters/types.ts` defines `CliAdapter`.

### Supported tasks

Every adapter implements **advisory** (structured JSON for region AI and
scene-note compaction). Optional handlers, advertised only when actually
implemented:

| Handler | Task |
| --- | --- |
| `translate` | One translation attempt (caller owns glossary and retries) |
| `read` | One crop transcription |
| `review` | One text-only chapter review |
| `describe` | One page scene note |
| `clean` | One image-generation crop (Codex only today) |

Do not set a handler merely because the underlying model might support the
task. The registry’s `require*` / dispatch methods fail with
`${label} does not support …` when the handler is missing. ChatGPT is not a
CLI adapter; requesting it is `Unknown CLI adapter`, not a rewrite to Codex.

Advisory results are `unknown`. Schema on the request is not a guarantee of
valid output; the workflow caller validates.

### Configuration

`AdapterOptions` injected at factory time (not read from `cliTranslate.ts`):

- `executable()` — launchable path, or `null` if missing/invalid
- `defaultModel()` — used when the request omits `model`
- `listModels()` — catalog refresh; may return a fallback list
- optional task handlers

IDs are `^[a-z][a-z0-9-]*$`. Duplicate IDs throw at registry construction.
There is no global plugin loader; the production registry is the array at the
end of `cliTranslate.ts`. `isCliEngine(id)` is `cliAdapters.has(id)` — not a
second hard-coded list.

### Discovery

`executable()` is whatever the factory injects. Production Grok/Codex/Cursor
inject `cliDiscovery.ts` (see **Discovery** below). A found program is not a
login or quota check. Windows `.cmd` shims stay unsupported.

### Execution

`CliAdapterRegistry` looks up the requested id, checks capability, images,
`executable()`, fills `model`, then calls that adapter only. Command adapters
use `commandAdvisory` (temp dir, `runtime.run`, parse, always delete the
work directory). Cursor uses `runtime.prompt` plus parse. The shared
`runCommand` in `cliTranslate.ts` logs jobs, forwards `abort`, and throws
`${bin} timed out` after 10 minutes instead of reporting a generic exit code.

### Cancellation

`AbortSignal` is checked before dispatch, before spawn, raced with the run,
and after the run. `AbortSignal.timeout` becomes `CLI timed out`. A
pre-aborted signal is `Cancelled` / DOM abort and never starts the process.

### Errors

| Situation | Error (does not run another adapter) |
| --- | --- |
| Unknown id | `Unknown CLI adapter: …` |
| Missing handler | `${label} does not support …` |
| Images when `supportsImages` is false | `${label} does not support image attachments` |
| `executable()` is null | `${label} CLI not found` |
| Non-zero exit | `${id} exited ${code}: …` |
| Empty / invalid JSON | parse error (`CLI returned no output`, `JSON`, …) |
| Timeout | `CLI timed out` or `${bin} timed out` |
| Abort | `Cancelled` |

Failures never substitute Grok, Codex, Cursor, Qwen, or ChatGPT.

## Example adapter

`src/lib/server/cliAdapters/example.ts` is the minimum implementation:
advisory-only, no images, `commandAdvisory` plus an injected `CommandRuntime`.
It is **not** registered in production. `createExampleAdapter` plus
`runCliAdapterContract('example', …)` in
`tests/cli-adapter-contract.test.ts` is the template for a new factory.

## Discovery

`src/lib/server/cliDiscovery.ts` resolves Grok, Codex and Cursor executables for
both readiness (`GET /api/ai/engines`) and execution. Tests inject environment,
path/platform semantics and a fake filesystem; changing `process.platform` alone
does not switch Node's path implementation.

Precedence:

1. Nonempty environment override: `GROK_BIN`, `CODEX_BIN`, `CURSOR_BIN`.
   `CURSOR_AGENT_BIN` is used only when `CURSOR_BIN` is unset or empty.
2. Admin-saved executable in `SCAN_DATA_DIR/cli-tools.json` (Setup →
   Command-line agents). Missing file means this step is skipped.
3. The provider command on `PATH` (`grok`, `codex`, `cursor-agent`).
4. Known install locations under the resolved home directory
   (`~/.grok/bin/grok`, `~/.local/bin/<command>`, `~/bin/<command>`).
5. Codex only: an optional bundled helper from a Cursor `openai.chatgpt-*`
   extension, and only the verified `linux-x86_64` layout on linux x64.

Overrides are one path or command name. They are not shell commands: spaces stay
part of the path, and `$VARS` / globs / `~user` are not expanded. Relative paths
resolve from the server working directory. `~/` is joined to the home directory
from `HOME` / `USERPROFILE` / `os.homedir()` — never a hard-coded user path.
A nonempty invalid environment override or saved location fails clearly and does
not fall through. Clearing a saved location restores automatic discovery unless
an environment override is still set. Do not mutate `process.env` to implement
this. Malformed `cli-tools.json` is an error for every tool; it is never ignored
so a different executable can run. Unknown tool ids and non-string values
(including numbers) are rejected. Only `grok`, `codex`, and `cursor` may appear.

Admin **Check discovery** only inspects this resolver. It does not spawn the CLI,
refresh catalogs, sign in, or call a model. **Test** on a named model row is the
billed native-path check and stays separate.

A found program is not authenticated and not a guarantee that a model is
available. These programs run on the machine hosting Komatose, not in the
visitor’s browser. Public engine status never includes resolved home paths;
only the admin settings endpoint returns the saved edit string.

Recovery examples:

- `GROK_BIN` is set but wrong: discovery fails with an invalid-override
  message. Fix or unset `GROK_BIN`. A saved Admin path is not used while the
  environment variable is nonempty.
- Saved Codex location points at a directory: Check discovery reports that
  clearly. Clear the saved location to resume PATH / known-install discovery.
- `cli-tools.json` is not an object: every tool reports a settings-file error
  until the file is fixed or replaced. Automatic discovery does not run.

A generic `agent` binary is never auto-selected as Cursor. If Cursor is installed
under another name, set `CURSOR_BIN` or save that path in Admin. Windows
`.cmd`/`.bat` shims are reported as unsupported launch targets (`spawn` uses
`shell: false`). Spawn `PATH` uses the platform delimiter. Discovery does not
run executables.

## Adding an adapter

Code adapters are trusted in-repo modules, not a sandbox for third-party
plugins. Copy `example.ts`; do not import `cliTranslate.ts` from the factory.

### Required for the contract (fake programs only)

1. `src/lib/cliAdapterDefs.ts` — one browser-safe definition: id, labels,
   operations, `production`, and discovery metadata (command, env vars,
   known paths, missing message). Provider lists, `CLI_ADAPTER_IDS`,
   validation, Admin setup, and discovery tables are derived from this.
2. `src/lib/server/cliAdapters/<id>.ts` — factory returning `CliAdapter`.
3. `tests/cli-adapter-contract.test.ts` — `runCliAdapterContract('<id>', create…)`.
4. `src/lib/server/cliTranslate.ts` — append the factory to `cliAdapters`
   **only** when `production: true`. Catalog refresh and `isCliEngine` follow
   the registry.

Do not add `if (id === '…')` on the dispatch, discovery, settings, or setup
path. The fake `example` definition is in the table with `production: false`:
discovery metadata works; it is not a catalog provider, admin tool, saved
`cli-tools.json` key, or built-in registry entry.

### Required to expose a production id

5. Seed model rows in `src/lib/modelRegistry.ts` (`access: 'cli'`, `cliAdapter`).
6. Task handlers in `cliTranslate.ts` if you claim translate/read/review/describe/clean.

`TRANSLATE_ENGINES` follows the catalog. Windows `.cmd` shims stay unsupported.

## Scope and next step

CLI translation now dispatches through the optional `translate` capability.
Proofreading and alternative phrasing inherit this dispatch because they already
use the shared translation pipeline. Vision bubble reading dispatches through
the optional `read` capability. Chapter review dispatches through the optional
`review` capability. Page description dispatches through the optional `describe`
capability. Existing command implementations are injected into each
adapter; their prompts, parsing and validation are unchanged. Codex
image-generation cleaning dispatches through the optional `clean` capability.
OCR, local model runtimes, installers and hardware selection are unchanged.
Migrate one of these operations at a time, adding a capability and contract
tests before switching callers. Do not claim an operation is supported merely
because the underlying model might support it.

Run `npm run test:cli-adapter-contract` for the reusable suite (example, Grok,
Codex, Cursor). Run `npm run test:cli-adapters` for that suite plus
adapter-specific transport tests.
Run `npm run test:cli-discovery` for executable discovery, override diagnostics
and PATH/home portability (injected filesystems; no real agent accounts).
Run `npm run test:cli-tools` for saved locations, admin check/save/clear and
malformed-config isolation.
Run `npm test` for existing workflow integration coverage, including large Grok
image attachments through the public CLI facade. Nothing in this change publishes
or installs anything, changes login state, or changes deployment configuration.

## Translation contract

`TranslationOptions` and `TranslationHandler` define one attempt over detected
regions. The registry checks capability, executable availability, image support,
model defaults and cancellation. Unsupported or unknown agents fail explicitly,
including proofreader requests previously able to fall through to Codex.
`cliTranslate.ts` retains SFX/glossary handling, missing-line retries, proofreading
IDs, and result validation. A glossary-only translation needs no CLI executable.
Adapter handlers are optional: an advisory-only adapter must not claim translation.

## Vision reading contract

`VisionReadOptions` and `VisionReadHandler` define one crop transcription.
The registry checks capability, executable availability, image support, model
defaults and cancellation. Adapters without `read` fail explicitly, including
ChatGPT. `cliTranslate.ts` keeps Grok/Codex/Cursor command options and
`parseReadPayload` validation. `runVisionRead` still chooses CLI vs local Qwen
before the registry; local models are not CLI agents.

## Chapter review contract

`ChapterReviewOptions` and `ChapterReviewHandler` define one text-only chapter
review. The registry checks capability, executable availability, model defaults
and cancellation. It does not require image support. Adapters without `review`
fail explicitly, including ChatGPT. `cliTranslate.ts` keeps Grok/Codex/Cursor
command options and `reviewFromModelText` validation. `runChapterReview` still
chooses CLI vs local Qwen before the registry; local models are not CLI agents.

## Page description contract

`PageDescribeOptions` and `PageDescribeHandler` define one JPEG scene note.
The registry checks capability, executable availability, image support, model
defaults and cancellation. Adapters without `describe` fail explicitly, including
ChatGPT. `cliTranslate.ts` keeps Grok/Codex/Cursor command options and
`parseCaption` validation. `runDescribePage` still chooses CLI vs local Qwen
or Qwen3-VL before the registry; local models are not CLI agents.

## Cleaning contract

`CleaningOptions` and `CleaningHandler` define one Codex image-generation crop
(artwork plus mask, PNG out, optional user reconstruction `prompt`). The registry checks capability, executable
availability, image support, model defaults and cancellation. Only Codex
injects `clean`. Grok, Cursor, ChatGPT and advisory-only adapters fail
explicitly. `cliTranslate.ts` keeps the existing sandbox flags and
output-file checks, wrapping the user prompt with mask and copy-file
instructions. `codexClean.ts` still owns crop tiling, mask compositing
and `probeCodexCleaning`.

Chapter translation in `aiTranslate.ts` now calls `runTranslationTask` in
`translationTask.ts`. That task layer is above the CLI adapters: Grok/Codex/Cursor
delegate to `translateScriptWithCli()`, and `qwen` delegates to `llm.translateScript()`
(including named specialists). Local models are not CLI agents. Unknown engines and
proofreader translation are rejected before inference. OCR English
(`translateOcrSource`) uses the same engine selection: CLI and named specialists
share those handlers, while unnamed Qwen keeps the OCR-specific transcription prompt.
Scene-note compaction uses the same explicit CLI vs local selection and rejects
ChatGPT instead of rewriting it to Qwen. Page description uses the same named-CLI
selection, then the adapter `describe` capability; unknown engines are rejected
rather than treated as CLI agents. Vision
bubble reading uses the same named-CLI selection, then the adapter `read`
capability, for both read-area call sites.
Chapter review uses the same named-CLI selection, then the adapter `review`
capability. Artwork cleaning uses Codex only, then the adapter `clean`
capability. Alternative phrasing
uses the same named-CLI vs local selection. Proofread edited English uses the
same named-CLI vs local selection. Region-AI advisory uses the same named-CLI
vs local selection.

Provider IDs, labels, transport kind and implemented operations live in
`src/lib/providerCatalog.ts`. That module is browser-safe: it does not probe
installs, credentials or models. `CLI_TRANSLATION_ENGINES` is derived from
catalog entries with CLI transport. Region AI settings filter provider pickers
by those operations and keep an unsupported saved selection visible until the
user changes it. Catalog support means an application handler exists; it does
not mean a typed model ID is vision-capable or installed.

