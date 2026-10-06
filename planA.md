# Plan A: Hardware-aware PyTorch installation

Implemented as the production fallback after the ExecuTorch feasibility experiment. See [implementation and qualification results](docs/PYTORCH-INSTALLATION.md). The workflow and review environments on this host now use the qualified split ROCm profile; external legacy targets remain preserved.

## Package selection

- Linux x86-64, Python 3.12 initially. Install only required torch/torchvision packages, without torchaudio or development SDKs.
- AMD: evaluate TheRock's split device wheels, pinned torch 2.13.0+rocm10.0.0 and torchvision 0.28.0+rocm10.0.0 from `https://stable.repo.amd.com/rocm/whl-next/`. Select the union of supported discrete GPU architectures; this host needs `device-gfx1100`. Include integrated GPUs only when explicitly selected. Lock dependencies and validate all application models before promotion.
- NVIDIA: official CUDA wheels, with CUDA 12.6 or 13.0 chosen using compute capability and driver compatibility. Never prune shared libraries with nvprune.
- Intel: CPU wheels initially; native XPU support is a separate follow-up.
- Preserve explicit cpu/cuda/rocm selections, configured interpreters, device overrides, and SCAN_TORCH_INDEX. Validate custom profiles rather than replacing them.

## Installation and upgrade

- Centralize bounded hardware discovery and package planning. Auto prefers usable NVIDIA, then supported AMD, then CPU; unsupported hardware must not silently download an all-architecture GPU installation.
- Unify setup, package lifecycle, and the GPU helper; remove hardcoded reinstalls which override the selected profile.
- Add read-only JSON planning and explicit runtime upgrade modes to setup-python-env.py. Keep uv/pip compatibility and existing ONNX CPU repair behavior.
- Store a structured receipt with requirement hash, profile, architecture union, versions, validation, and installed bytes. Recognize legacy receipts.
- Expose profile, architectures, installed bytes, upgrade availability, and reasons through setup status. Queue explicit upgrades for workflow/review environments.
- Create environments in permanent generation directories; atomically switch the `.venv-*` symlink after validation, draining and restarting workers and invalidating probes.
- Preserve the active environment on failure/cancellation. After successful activation, remove only application-owned old generations. Never delete external symlink targets or configured interpreters, including this machine's `/www/scan` environments.
- Report caches separately. Do not clear global package caches or model weights.

## Verification

Test discovery, multiple architectures, integrated GPUs, incompatible drivers, overrides, CPU-only systems, all installer entry points, idempotence, legacy receipts, cancellation, rollback, and symlink ownership. Validate convolution, FFT, attention, NMS, and every retained PyTorch model against licensed fixtures. Measure actual disk use, startup, and warmed latency. Require real NVIDIA/Intel hardware before advertising their profiles as verified.
