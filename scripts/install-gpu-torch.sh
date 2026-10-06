#!/usr/bin/env bash
# ROCm PyTorch and runtime dependencies for native detectors, OCR, and cleaning.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
for environment in workflow review; do
  python3 scripts/setup-python-env.py --env "$environment" --torch rocm
  python_path="$ROOT/.venv-$environment/bin/python"
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$python_path" --index-url https://download.pytorch.org/whl/rocm7.1 --reinstall 'torch==2.12.0' 'torchvision==0.27.0'
  else
    "$python_path" -m pip install --index-url https://download.pytorch.org/whl/rocm7.1 --force-reinstall 'torch==2.12.0' 'torchvision==0.27.0'
  fi
done
