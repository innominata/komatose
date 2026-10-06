#!/usr/bin/env bash
# Uses the same planner, validation and activation transaction as app setup.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
for environment in workflow review; do
  python3 scripts/setup-python-env.py --env "$environment" --torch "${SCAN_TORCH_VARIANT:-auto}" --upgrade-runtime "$@"
done
