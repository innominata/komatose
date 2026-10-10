# Fresh install

This is the smallest path that `npm run test:fresh-install` actually exercises:
an **empty data directory**, no installed OCR/weights, and no real Grok/Codex/Cursor
binaries. The test uses a fake OpenAI-compatible HTTP server and three fake CLI
programs. It does not download models, sign in, or make paid calls.

## What you need

- Node.js (same major as this repo) and `npm install`
- A writable data directory (SQLite + `models.json`, `cli-tools.json`, `model-profiles.json`)
- **One** working translation backend (pick any):
  1. Local OpenAI-compatible HTTP (`GET {url}/models` must succeed)
  2. A remote OpenAI-compatible row (base URL + API-key **variable** in `.env`)
  3. Grok, Codex, or Cursor **installed on the server OS**, then saved under
     **Admin → Setup → Command-line agents**

Optional and **not** required to translate: Hayai, PaddleOCR-VL, Qwen3-VL, Hy-MT,
Imsbee, the proofreading service, Komatose GPU mode.

## Steps

1. Copy `.env.example` to `.env` in the app root. Keep secrets in `.env` only.
   Admin stores environment **names**, never key values or executable bytes.
2. Point data at an empty directory, not another install’s `data/`:

   ```bash
   SCAN_ROOT=/path/to/komatose
   SCAN_DATA_DIR=/path/to/komatose/data
   DATABASE_URL=/path/to/komatose/data/scan.db
   ```

   If `SCAN_ROOT` still points at another tree, `.env` and review-model lookup
   follow that tree.
3. Set `LLAMASWAP_URL` to the local `/v1` endpoint if you use a local chat
   server. Leave `LLAMASWAP_API_KEY` empty unless that server requires a bearer
   token. If `LLAMASWAP_URL` is unset, Komatose still tries `http://127.0.0.1:8081/v1`.
4. `npm install` and `npm run dev` (or `npm run build` then `npm start`).
5. Open `/setup` and create the first admin (username ≥ 2 characters, password ≥ 6).
6. Open **Admin → Models**. Everything about models lives in one area:
   - **Overview** — what Komatose can do on this machine, by job (detect,
     transcribe, translate, scene notes, AI review, proofread, masks, clean),
     with the default model per job and the single most useful fix. Checks are
     free: files, ports and variable names — never a model call. **Needs
     attention** lists only broken things, one row per cause.
   - **Models** — every model in one list (installed weights, local servers,
     remote APIs, CLI agents, services). Click a row for setup, jobs with test
     results, the compute device picker (**Auto**, CPU, or a named GPU — the
     device list comes from the installed llama.cpp and PyTorch builds, so
     CUDA, ROCm, Vulkan and Metal all work), and "Users can pick". **Add model**
     covers local chat servers (with launch presets), remote APIs and CLI
     agents.
   - **Install** — everything downloadable, grouped by job, with bundles and
     multi-select. Missing Python environments are queued and installed first;
     one install runs at a time with logs and cancel. Each PyTorch environment
     fetches a CPU, CUDA or ROCm build (**PyTorch build** selector). Installing
     a chat model (Qwen 3.8 27B, or Qwen3-VL 8B for modest hardware) adds its
     managed row automatically.
   - **Jobs & defaults** — the model × job grid: allow or disallow per job,
     test results in the cells, and a Default row per job (stored per machine;
     chapters and series can still override).
   - **Hardware & services** — VRAM per device with what is resident, every
     service with Start/Stop/Restart, environments, and moving model setup to
     another machine (model packs never carry secrets).
   - **Guided setup** — four steps for fresh installs; it queues the installs
     and leaves everything else to the pages above.
7. Configure **one** backend, then refresh Overview until **Translate** is ready:
   - **Local** — install a chat model from **Install** (Qwen3-VL 8B runs on
     modest hardware and even CPU), or point **Add model → Local model** at a
     server you run (`LLAMASWAP_URL` must respond to `GET /models`).
   - **Remote** — **Add model → Remote API** picks from a searchable provider
     list (global, Chinese and local servers) with the base URL and key
     variable filled in; **Check endpoint & list models** probes the endpoint
     before anything is saved. Search the returned model list, then add several
     at once. Put the secret in `.env` under the variable name stored on the row.
   - **CLI** — install Grok, Codex, or Cursor on this machine (not in the
     browser), sign in as the server user, then **Add model → CLI agent**.
     Environment `GROK_BIN` / `CODEX_BIN` / `CURSOR_BIN` still override a
     saved path.
   Visibility is per row (**Users can pick**) and nothing is deleted by hiding
   it.
8. On a chapter, select a model the Overview marks ready. The shipped default
   is Qwen 3.8 27B, with a fallback to whichever chat row exists (for example
   Qwen3-VL 8B on a light install); **Jobs & defaults** sets per-job defaults
   per machine, and chapters can override them. **AI model settings → Model
   profiles** can save translation, proofreading, reviewers, and transcription
   as "Local only" or "CLI agents". To copy named rows and profiles onto
   another machine, use **Admin → Models → Hardware & services → Move to
   another machine**. The JSON does not copy secrets, CLI paths, or
   private/loopback/link-local endpoints unless you check **Include private
   network endpoints**; skip or rename conflicts instead of overwriting.
9. Optional OCR and specialist translators: [LOCAL_OCR_REVIEW.md](./LOCAL_OCR_REVIEW.md)
   and [TRANSLATION_MODELS.md](./TRANSLATION_MODELS.md). The **Local models** tab
   on Setup offers the same installs as buttons (Hayai, Manga OCR, PaddleOCR-VL,
   Qwen3-VL, Hy-MT2, Imsbee, Opus-MT, RT-DETR, Comic Text Detector, Koharu, COO,
   Qwen-Image-Edit 2511, Big-LaMa, AOT, lama-Manga) — the docs remain the long form.

**Test** in a model panel is a billed native-path check. The free checks never run it.

## Isolated smoke test

```bash
npm run test:fresh-install
```

Local llama.cpp and remote OpenAI-compatible request shapes (no silent
provider switch) are locked by `npm run test:http-endpoint-contract`. See
[HTTP_ENDPOINTS.md](./HTTP_ENDPOINTS.md).

That command creates a temp `SCAN_ROOT` / empty `SCAN_DATA_DIR`, ignores this
machine’s `.env`, PATH agents, GPU mode, and review-model directories, then:

- starts against zero users
- shows Setup missing/unavailable until a fake `/v1` and fake CLIs are configured
- registers a remote HTTP row (env var name only)
- saves and applies a named model profile
- runs one **translate** task through local HTTP, remote HTTP, Grok, Codex, and Cursor

## Remaining limitations

- **Windows** CLI discovery still does not accept `.cmd` shims. Use a real
  executable or WSL.
- **Page-image proofread** is optional and off by default. It needs a separate
  proofreading service you run yourself (`SCAN_PROOFREAD_SERVICE_URL`). The smoke
  test does not cover it, and the tools stay hidden while it is unset.
- CLI “found” is not a login or quota check. Fake or real binaries that exit 0
  still have to speak each adapter’s JSON.
- Unset `LLAMASWAP_URL` probes `127.0.0.1:8081`, so Setup says **unavailable**
  rather than **missing** when nothing is listening there.
- Hayai / Paddle / Qwen3-VL / Hy-MT / Imsbee stay optional. An empty data
  directory reports them missing and does not download weights.
- `SCAN_GPU_MODE=komatose` is this host’s dual-GPU layout, not a fresh-install
  requirement.
- Model-pack export omits private, loopback, and link-local URLs (IPv4 and
  IPv6, plus `.localhost` / `.local`) unless **Include private network
  endpoints** is checked. Credentials in URLs are always stripped. Profiles
  that pointed at excluded rows are listed so the destination can add them.
  `npm run test:browser-model-pack` covers that UI on two temp installs with
  fake URLs (passed 2026-09-15). A second real machine is still the
  compatibility check.
- Overlay writes use the same temp-file rename as profiles. Leftover
  `*.tmp` files after a kill are unused and can be deleted by hand.
- Import does not copy `.env` values or CLI executables. After import, set
  the named API-key variable and install/sign-in CLIs on that machine, then
  apply a profile and run a task.

See [MODEL_REGISTRY.md](./MODEL_REGISTRY.md) and [CLI_ADAPTERS.md](./CLI_ADAPTERS.md).

Local chat models are added from **Admin → Models → Add model → Local model** (launch preset, device picker, port, startup) or installed from **Install** with their row created automatically. Each managed model has its own port, device choice (Auto, CPU or a named GPU), startup setting, and Start/Stop/Restart controls. See [Managed local models](./MANAGED_MODELS.md). Other local endpoints work independently when the default is unavailable.
