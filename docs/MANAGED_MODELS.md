# Managed local models

Admin → Setup → Local models shows one card list of the local llama.cpp
servers this machine can configure and run: each named model is a card with
its own recipe, port, device, lifecycle, and status. **Add local model** opens
an add form; submitting creates the new card in its expanded state so the
launch editor is ready immediately, and every card has **Edit** (toggles the
editor) and **Delete**. External local HTTP services, remote endpoints, CLI
agents, and specialist OCR services continue to use their existing adapters.

## Configure a model

1. **Add local model** opens the form (Name, Model id, External endpoint,
   API-key variable). Prefill chips for **Qwen 3.8 27B / Gemma 4 26B / 12B /
   E2B** fill Name and Model id only — those models ship as presets, not as
   seeded rows, so each install adds the one it actually has. The external URL
   is used only while the model has no managed recipe.
2. The new card opens expanded. Select **Generic llama.cpp preset**, **Current
   Qwen preset**, or a **Gemma 4 preset** to load its recipe into the fields.
3. Set paths to the executable and weights. Recipes are stored, served, and
   shown as home-relative `~/…` paths — never this machine's home directory —
   and the server expands them only right before a filesystem check or launch.
   A projector and chat template are optional. Set the loopback port, device,
   context size, GPU layers, and slots explicitly. Models need different ports; sharing a device is an
   intentional operator choice, without automatic memory scheduling.
   In `SCAN_GPU_MODE=komatose`, ports 18081–18083 and 18085 are reserved for
   PaddleOCR-VL, Qwen3-VL 8B, Manga OCR, and Hayai, and 18091 is reserved for the
   local image editors. Chat recipes use
   `SCAN_LLM_PORT` (18080). Saving or
   starting a chat model on a review or image-editor port is rejected.
   The image editors share one card with the resident chat model, so starting
   either unloads the other on that device. Both editors also share port 18091
   and one resident process: loading one in **Admin → Setup → Local image editor**
   stops the other first.
4. Choose whether to start with the app. Save, then press **Start model**.

**Edit** re-expands a card and re-reads the saved recipe (collapse → expand
always shows what is on disk). **Delete** asks for confirmation and removes the
row from this machine; it is disabled while the model is starting, running,
stopping, or has active uses — stop the model first (the server refuses the
delete too).

Advanced arguments use one token per line, including separate values. Only
supported tuning flags are accepted; executable, weights, aliases, ports,
authentication, downloads, and other launch behavior cannot be overridden there.
Weights are not downloaded by this feature.

**Request settings** are independent of the server transport. Generic llama.cpp
uses its transport-specific cache/schema options without Qwen template options.
**Qwen thinking template** opts into `enable_thinking` and `reasoning_effort`.
New local rows are generic; loading the Current Qwen preset also selects the
thinking template.

## Save and lifecycle controls

Saving a running model's recipe creates pending changes. Its active endpoint and
request settings remain unchanged until **Restart model**. Stop the model before
changing its identifier, credentials, external connection, or removing its recipe.
Start is idempotent. Stop and Restart refuse models with queued or active work;
finish or cancel that work first. In-progress lifecycle operations also block new
work for that model. Other models continue independently.

Startup is asynchronous. Status reports starting, running, stopping, stopped, or
error, along with the device, port, active-use count, and pending changes. Server
logs are under `SCAN_DATA_DIR/logs/managed-<model-id>.log`.

Managed processes survive an app restart. Ownership metadata is kept under
`SCAN_DATA_DIR/run`; Linux process start time and a unique process marker prevent
PID reuse from authorizing a stop. The manager verifies ownership, configuration,
and the served model ID before reusing a resident process. A configuration
mismatch requires Restart. An unrelated service on the same port is reported and
never terminated. The launcher no longer stops or kills llama-swap globally.

## Storage and compatibility

`managedLaunch` and `requestPreset` live on rows in `models.json`; the four
path fields are stored as `~/…` so the file never carries this machine's home
directory. Credentials
remain environment-variable names; values are resolved on the server. Requests,
readiness, catalog discovery, and Setup all use the selected row's configuration.
Explicit endpoints do not borrow another endpoint's credential.

Existing task selections and default models remain unchanged. `qwen` is accepted
as a legacy saved alias; resolved HTTP models have an `http` host identity. Logs
and provenance identify the actual registry model and slug.

There is no seeded chat row and no virtual recipe: Qwen 3.8 27B and the Gemma 4
models are prefill chips plus launch presets in Setup, and an install that has
none of them reports the local chat path as missing until an operator adds one.
OCR and cleaning retain the existing GPU-mode warmup separately from chat models.

Local rows and machine-specific launch recipes are excluded from portable model
packs. The management API is admin-only: `GET /api/admin/managed-models` returns
status and presets; `POST` accepts `{ id, action: "start" | "stop" | "restart" }`
and returns an operation identifier immediately. Poll GET for completion.
`GET /api/admin/review-models` reports Hayai / PaddleOCR-VL / Qwen3-VL process
identity; `POST` accepts the same start/stop/restart actions for those OCR
servers.

## Validation

`npm run test:managed-models` exercises independent fake model processes,
connection isolation, pending changes, ownership, lifecycle locking, job leases,
reserved OCR ports, and startup failures. `npm run test:browser-managed-models` checks the card
flow (add → expanded editor → presets with `~/…` paths), permissions, error
recovery, lifecycle controls, and reload persistence against
an isolated app and fake executable. Neither test starts a real GPU model.
