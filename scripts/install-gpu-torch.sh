#!/usr/bin/env bash
# ROCm PyTorch for Hayai, SAM, Big-LaMa, and AOT on the second 7900 XTX.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
uv pip install --python "$ROOT/.venv-workflow/bin/python" --index-url https://download.pytorch.org/whl/rocm7.1 --upgrade 'torch==2.12.0' 'torchvision==0.27.0'
uv pip install --python "$ROOT/.venv-review/bin/python" --index-url https://download.pytorch.org/whl/rocm7.1 --upgrade 'torch==2.12.0' 'torchvision==0.27.0'
