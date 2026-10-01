# Model packages and task evidence

Models are selected by current task-test evidence. Installation, transport, device choice,
and administrative access are separate from task eligibility. A working connection is not
a task pass. Every task is sent to the adapter by **Test all**, including tasks it rejects.

Packages are discovered at startup and through **Admin → Models → Jobs → Refresh packages**.
Discovery never installs software, starts a service, or runs a billed request. Bundled
packages live in `model-packages/`; operator packages live in
`SCAN_DATA_DIR/model-packages/`. Each package is a directory containing `model.json`.
An operator package can replace a bundled package with the same stable ID. Duplicate IDs within one package root and invalid manifests are reported by refresh and block execution of the affected integration until corrected.

## Manifest

```json
{
  "version": 1,
  "id": "my-reader",
  "name": "My reader",
  "revision": "2026-09-28",
  "access": "local_http",
  "model": "vendor/model-revision",
  "adapter": {
    "id": "my-jsonl-adapter",
    "command": { "executable": "python3", "args": ["{package}/adapter.py"] }
  },
  "service": { "id": "my-reader-service", "concurrency": 1, "resource": "gpu-0", "device": "cuda:0" },
  "config": { "weights": "/models/my-reader" }
}
```

A package can reuse `openai` with `config.baseUrl` and `config.apiKeyEnv`, or `cli`
with `config.provider`. Bundled native adapters preserve existing integration protocols.
A new calling convention supplies its own command; there is no application registration step.
Commands are argument arrays, not shell expressions. Keep credentials in environment
variables; configurations store their references. Manifests must not contain
`operations`, `capabilities`, `supportedTasks`, or `supportsImages` declarations.

Optional fields:

- `setup`: a normal installer command (`executableEnv` optionally overrides its executable); stdout/stderr report progress and exit status reports success.
- `artifacts`: installation checks; paths relative to the package or absolute, with `{root}` expansion.
- `dependencies`: package IDs installed before this package.
- `environment`: names of environment settings that affect this integration’s fingerprint.
- `artifactDirectories`: installed model directories whose file versions affect fingerprints; each entry has `path`, optional `rootEnv`, and optional `subdirectory`.
- `lifecycle`: JSONL commands for `install`, `installation-status`, `start`, `health`, and `stop`.
- `adapter.files`: additional package-local files that contribute to adapter fingerprints.
- `kind: "runtime"`: an installable dependency without a model row.

Commands use `{package}` for the package directory and `{work}` for the request directory.
Setup commands also accept `{root}` for the application root. Packages sharing a service
must use the same service ID and concurrency. A resource identity reserves that resource
exclusively across services. Device strings are delivered to adapters without interpreting
them as capabilities.

## Adapter protocol

The application starts a command per request and sends one JSON line on stdin:

```json
{"protocol":1,"requestId":"unique-id","action":"execute","task":{"id":"vision","version":1},"input":{"jpeg":{"attachment":"jpeg"}},"attachments":[{"name":"jpeg","path":"/tmp/request/input-0.bin","mimeType":"image/jpeg"}],"model":{"id":"my-reader","slug":"vendor/model-revision","revision":"2026-09-28","config":{}},"settings":{"workDirectory":"/tmp/request","device":"cuda:0"}}
```

Stdout contains only JSON lines. Stderr is for diagnostics. Each event echoes the
protocol and request ID. Progress is optional; exactly one final result is required:

```json
{"protocol":1,"requestId":"unique-id","type":"progress","message":"Reading crop"}
{"protocol":1,"requestId":"unique-id","type":"result","ok":true,"output":{"source":"待って","lineType":"\"\""}}
```

An unsupported task must return before loading weights:

```json
{"protocol":1,"requestId":"unique-id","type":"result","ok":false,"error":{"kind":"unsupported","message":"This adapter revision only implements crop reading"}}
```

Other error kinds are `failed_validation`, `error` (including unavailable infrastructure),
and `cancelled`. A successful command exits zero after its final response. Cancellation
terminates its process group. An adapter controlling a persistent service must implement
ownership and cancellation of that service's individual requests, and implement `stop`.

Lifecycle outputs use `{ "installed": true }` for installation status and
`{ "ready": true }` for health. Start is followed by readiness checks. Stopping an
actively used service is rejected. Installer failure is surfaced without inventing readiness.

Image inputs are request-scoped files. Image results return `image` or `mask`, containing
a path inside the request directory or a PNG/JPEG data URI. Output files are read before
request cleanup; paths resolving outside that directory are rejected.

## Tasks and evidence

`src/lib/modelTasks.ts` defines ordered task IDs, labels, groups, and output validation.
`src/lib/server/modelTaskCatalog.ts` binds each task to its production runner, small fixtures, and correctness checks.
Production and probes execute through `modelTaskRunner.ts`; diagnostics bypass only the
current-pass gate. New tasks need application contracts, fixtures, validators, and workflow
integration. Adding instances or updating adapters for an existing task does not.

**Read Text / OCR** (`vision`) returns source text. **Review Transcription** (`sourceReview`)
returns an independent reading, status, and findings. A recognizer can return `unassessed`
when it cannot assess uncertainty. English is optional in that adapter result; the workflow
uses the selected translator when needed and attributes the two contributions separately.
**Review Translation** is a council of integrations with current `translate` passes.
English proofreading and alternative translations are distinct tasks. Translation tests try a Japanese fixture, then a Korean fixture if the first is unsupported or fails validation; the result records which fixture passed. This establishes a task pass, not a claim of universal language coverage.

Evidence is fingerprinted against model/configuration, adapter code, artifacts, and task
contract/fixture revisions. Cosmetic display-name changes do not invalidate it. Old results
stay in history; legacy results without fingerprints are stale. Failed validation or
unsupported retests supersede earlier passes. Cancellation and temporary errors preserve
an earlier pass only for the same fingerprint. Use **Model updated · require retest** when
an upstream alias changes without exposing a revision. Retesting is always explicit.

The first explicit package refresh backs up existing model/profile/default/detector JSON
configuration under `data/backups/model-packages-v1` and migrates history idempotently.
It leaves selections and weight files intact. To roll back configuration, stop the app,
restore the backed-up JSON files, and remove `model-packages-migration-v1.json` before
restarting the previous application version.

Run `npm run test:model-packages` for isolated unknown-package, adapter-upgrade,
concurrency, cancellation, validation, migration, and evidence-history tests. These tests
create temporary adapters and data directories and never call production models.

## Installation, control, and adapter upgrades

Admin → Models installs, starts, checks, stops, and marks a package updated. Install runs
the package `setup` command, or its `lifecycle.install` command, and then requires
`installation-status` to report `installed: true`. A finished installer that leaves weights
missing is a failure. Start refuses a package that is not installed, pings only that
package’s service, and does not warm unrelated models. CPU workflow workers stay resident
after an explicit start until Stop; GPU mode may respawn the shared worker on the next
image request. Stop is rejected while the shared service has an active request. Packages
that share a service id must declare the same concurrency and resource; a mismatch blocks
every package on that service until the manifests agree.

An operator package with the same id replaces the bundled manifest. Replacing or editing
adapter files changes the fingerprint, so earlier passes become stale and the picker hides
that task until an explicit retest passes. A display-name change does not. **Model updated ·
require retest** is the manual form of that invalidation when an upstream alias changes
without a new revision. Receipts, declared artifact directories, and environment settings named
by the package participate. Builtin models also fingerprint the shared task
contract plus the source files for that model's adapter, so editing one adapter
restales only the models that adapter runs. Cancellation and infrastructure
errors do not erase a pass for the same fingerprint; a failed or unsupported retest does.

Saved device choices are sent to external adapters as `settings.device`. Builtin adapters
keep using the same device preferences they used before packages. Councils stay lists of
model ids; a default is one selected row, and the workflow runs that row only when its
current task pass still matches. Unavailable or stale selections remain visible with the
reason they cannot run.

SAM and Paddle use `scripts/install-native-package.py` only on explicit installation.
SAM fetches its checkpoint (or verifies `SCAN_SAM_CHECKPOINT`); Paddle prepares the
Japanese and Korean pipelines used by its native adapter. Installation receipts in
`SCAN_DATA_DIR/models/package-installations/` list the actual files. Missing or empty
files mean the package needs installation, even when its Python environment exists.
Receipt artifacts and declared Hugging Face cache directories participate in evidence
fingerprints. Keep receipts with configuration backups; they do not contain weights.
Starting these packages checks installation and pings the shared worker without warming
unrelated models. CPU workflow workers started explicitly remain available until stopped.

Blank OCR is valid in production (a crop can contain no readable text), but cannot pass
the nonblank reading fixture. Malformed protocol responses and missing output files are
failed validations, so they supersede older passing evidence. Process failures and
cancellation remain infrastructure/interruption outcomes.
