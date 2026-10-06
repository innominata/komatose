# Hardware-aware PyTorch installation

Komatose installs a pinned runtime profile rather than an unqualified `torch` package. Python 3.12 and Linux x86-64 are the initial target. The installer supports both uv and pip. New installations use the planner automatically; existing environments retain their runtime until an explicit runtime upgrade. Dependency-only maintenance preserves the old runtime version.

## Profiles

- CPU: `torch==2.12.1+cpu`, `torchvision==0.27.1+cpu` from the official CPU index. Intel hardware uses this profile; native XPU is not enabled.
- NVIDIA: official CUDA 12.6 or 13.0 wheels at the same package versions. CUDA 13.0 requires Turing or newer and driver 580.65.06 or newer. Older supported cards use CUDA 12.6 with driver 560.28.03 or newer. A Blackwell card cannot fall through to the CUDA 12.6 profile. Hardware detection is bounded and requires successful `nvidia-smi` enumeration. The planner is tested with synthetic NVIDIA inventories; no NVIDIA hardware was available for runtime qualification.
- AMD: `torch[device-gfx1100]==2.13.0+rocm10.0.0` and `torchvision[device-gfx1100]==0.28.0+rocm10.0.0` from AMD's stable split-wheel index. Automatic selection is qualified for `gfx1100`. Two cards of the same architecture need one pack. Unsupported architectures use CPU automatically; other physical targets can be requested explicitly and must pass local validation. Integrated GPUs are excluded unless explicitly requested.

No profile requests torchaudio, an all-device AMD pack, or the ROCm `devel` extra. Upstream runtime dependencies still include ROCm core components and Triton; these are retained rather than deleting libraries from installed wheels. NVIDIA libraries are likewise left intact.

Sources: [AMD split-wheel packaging](https://github.com/ROCm/TheRock/blob/main/RELEASES.md), [PyTorch 2.12 architecture support](https://pytorch.org/blog/pytorch-2-12-release-blog/), [CUDA 12.6 driver requirements](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-toolkit-release-notes/index.html), [CUDA 13.0 driver requirements](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/).

## Install and upgrade

The Admin → Models → Install page displays the current profile, architecture packs, installed bytes, proposed upgrade, and reasons. “Upgrade runtime” queues an explicit workflow/review upgrade. Setup, package lifecycle installation, and the GPU helper use the same installer.

Read-only planning imports no torch and changes no environment:

```bash
python3 scripts/setup-python-env.py --env workflow --plan-json
python3 scripts/setup-python-env.py --env review --torch cpu --plan-json
```

CLI installation and explicit upgrade:

```bash
python3 scripts/setup-python-env.py --env workflow
python3 scripts/setup-python-env.py --env review --upgrade-runtime
bash scripts/install-gpu-torch.sh
```

`--torch cpu|cuda|rocm` preserves an explicit choice. `SCAN_TORCH_INDEX` preserves a custom index, which must pass runtime validation. `--architectures gfx1100,gfx1201` or `SCAN_TORCH_ARCHES` requests the union of physical AMD targets. The installer respects relevant `.env` settings and exported variables. Configured interpreter paths are read-only; Komatose will not upgrade them.

For isolated qualification:

```bash
python3 scripts/setup-python-env.py --env workflow --upgrade-runtime --stage-only
python3 scripts/setup-python-env.py --env workflow --activate-candidate data/python-envs/workflow-GENERATION
```

Activation revalidates the candidate. Production upgrades through the app drain accepted requests, hold new Python work, retire owned Python workers, activate, and invalidate hardware/model evidence. Workers start with the new generation on the next request. CLI upgrades preserve old generations because they cannot certify that app workers have drained; an idle worker detects the new generation on its next request. Externally owned resident review processes must be stopped by their owner before an app-driven runtime upgrade.

Permanent generations live in `data/python-envs/`. Absolute Python entry-point shebangs remain valid because generation directories are not renamed. `.venv-workflow` and `.venv-review` point to an activated generation. Symlink replacement uses an atomic rename; Linux `renameat2(RENAME_EXCHANGE)` handles an existing real legacy directory without a missing-path window. Failure or graceful cancellation before activation removes the owned candidate and preserves the active path. App upgrades remove only the immediately previous owned generation after draining. External symlink targets and legacy directories are retained.

The structured `.komatose-runtime.json` receipt records the requirement hash, selected profile, architecture union, resolved package versions, operator/model validation, and installed bytes. `.komatose-env` remains compatible with legacy dependency checks. Subsequent dependency installation uses constraints to prevent a generic PyPI torch replacement. CPU ONNX repair uses a clean generation, avoiding the shared files of previous GPU ONNX distributions.

Global uv/pip caches are shared and reported separately from installed environment bytes. Models and global caches are not deleted. A SIGKILL can leave an inactive candidate; it cannot interrupt atomic activation halfway through. Such candidates are not automatically treated as successful installations.

## Local qualification, 6 October 2026

Both RX 7900 XTX cards passed convolution, FFT, attention, NMS, and deformable-convolution checks with the split runtime. CPU 2.12.1 also passed these checks. The twelve retained PyTorch models were compared against the existing 2.12.0+ROCm7.1 environment on the licensed Black Jack fixture:

- LaMa Manga, Big LaMa, and AOT used the production cleaner, rectangular and square inputs, exact preservation outside the approved mask, and masked error limits of mean 1/max 8 byte values.
- SAM used the production geometry operation; Koharu used publisher preprocessing and production BF16 inference, with mask IoU ≥0.99.
- RT-DETR and CTD used production detection and postprocessing. COO compared both its region output and raw probability map; this particular fixture produced no COO regions.
- Hayai OCR, Manga OCR, Opus-MT, and Imsbee ran complete generation with production settings. Generated text matched exactly.

These are fixture regression checks, not a comprehensive model-quality evaluation. The production workflow's warmup also succeeded under its memory limit.

Measured allocated footprint, deduplicating hardlinks within each environment and excluding shared caches and model weights:

- Review: 14,714,990,592 → 6,544,257,024 bytes (about 55.5% smaller).
- Workflow: 14,571,110,400 → 6,375,415,808 bytes (about 56.2% smaller).

The previous environments belong to `/www/scan` and were preserved. These per-environment measurements are not a claim that those bytes were freed from the filesystem. uv may share package inodes across environments and its cache, so summing environment footprints overstates unique physical disk use.

A sequential same-input LaMa 512×512 GPU comparison with four CPU threads and 30 warmed runs measured median 25.44 ms on the old runtime and 25.92 ms on the split runtime. Process-to-first-result was 6.72 s versus 5.12 s. Both tensor comparisons passed. Driver/kernel caches were already populated; these are not pristine first-install timings. The split run had a higher transient PyTorch VRAM allocation peak (3.58 GB versus 0.39 GB), despite lower peak process RSS (2.43 GB versus 3.19 GB). Runtime selection is primarily a disk-footprint improvement.

Machine-local receipts, fixture outputs, and timing data are under `data/python-env-validation/` and `data/benchmarks/torch-profiles/`; they are ignored by git. Reproduce model comparisons with `scripts/validate-python-models.py --env ... --python ... --device ... --out ... --reference ...`.

Installer regression tests cover selection, driver/architecture compatibility, multiple cards, integrated GPUs, overrides, idempotence, legacy receipts, cancellation, rollback, cleanup failure, and symlink ownership. Worker maintenance tests cover draining, nested work, cancellation, and the ROCm launcher override. Svelte checking reports zero errors and the existing 99 warnings. Full CI has an existing `fresh-install.test.ts:205` task-readiness assertion failure, reproduced on the untouched baseline; `setup-report.test.ts` also has existing task-readiness expectations that do not provide current qualification evidence.
