#!/usr/bin/env bash
# Explicit experiment tooling; never replaces a production virtual environment.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../.." && pwd)"
task_dir="${KOMATOSE_ET_DIR:-$repo_dir/data/benchmarks/executorch}"
source_dir="$task_dir/toolchain/executorch"
export_python="$task_dir/toolchain/exporter/bin/python"
mode="${1:-prepare}"
jobs="${KOMATOSE_ET_BUILD_JOBS:-8}"
case "$mode" in prepare|build|cpu|selective) ;; *) echo 'Usage: bash bootstrap.sh prepare|build|cpu|selective [MODEL.pte]'; exit 2 ;; esac
if ! [[ "$jobs" =~ ^[0-9]+$ ]] || (( jobs < 1 || jobs > 16 )); then
  echo 'KOMATOSE_ET_BUILD_JOBS must be between1 and16' >&2; exit 2
fi
if [[ "$mode" == prepare ]]; then
  command -v uv >/dev/null
  mkdir -p "$task_dir/toolchain"
  if [[ ! -x "$export_python" ]]; then uv venv --python 3.12 "$task_dir/toolchain/exporter"; fi
  SAM2_BUILD_CUDA=0 uv pip install --python "$export_python" \
    --index-strategy unsafe-best-match --extra-index-url https://download.pytorch.org/whl/test/cpu \
    --extra-index-url https://download.pytorch.org/whl/nightly/cpu \
    -r "$script_dir/requirements.lock"
  if [[ ! -d "$source_dir/.git" ]]; then
    git clone --depth 1 --branch v1.5.1 https://github.com/pytorch/executorch.git "$source_dir"
  fi
  if [[ "$(git -C "$source_dir" rev-parse HEAD)" != 3b60683923245cf472b7323426920e15623ba361 ]]; then
    echo 'Unexpected ExecuTorch checkout; use a separate KOMATOSE_ET_DIR' >&2; exit 1
  fi
  git -C "$source_dir" submodule update --init --depth 1 \
    third-party/flatbuffers third-party/flatcc third-party/gflags third-party/json third-party/pocketfft \
    kernels/optimized/third-party/eigen backends/vulkan/third-party/Vulkan-Headers \
    backends/vulkan/third-party/VulkanMemoryAllocator backends/vulkan/third-party/volk \
    backends/xnnpack/third-party/FP16 backends/xnnpack/third-party/FXdiv \
    backends/xnnpack/third-party/XNNPACK backends/xnnpack/third-party/cpuinfo \
    backends/xnnpack/third-party/pthreadpool
  exit 0
fi
cmake="$task_dir/toolchain/exporter/bin/cmake"
build_dir="$task_dir/toolchain/native-v1"
options=(-DEXECUTORCH_BUILD_VULKAN=ON -DEXECUTORCH_BUILD_XNNPACK=OFF -DEXECUTORCH_BUILD_KERNELS_OPTIMIZED=ON)
if [[ "$mode" == cpu ]]; then
  build_dir="$task_dir/toolchain/native-cpu"
  package_dir="$($export_python -c 'import pathlib,executorch; print(pathlib.Path(executorch.__path__[0]))')"
  options=(-DEXECUTORCH_PACKAGE_DIR="$package_dir")
elif [[ "$mode" == selective ]]; then
  if [[ $# != 2 || ! -f "$2" ]]; then echo 'selective requires an exported MODEL.pte' >&2; exit 2; fi
  build_dir="$task_dir/toolchain/native-selective"
  options+=(-DEXECUTORCH_SELECT_OPS_MODEL="$(realpath "$2")" -DEXECUTORCH_OPTIMIZE_SIZE=ON)
fi
if [[ "$mode" != cpu ]]; then command -v glslc >/dev/null; fi
"$cmake" -S "$script_dir/native" -B "$build_dir" \
  -DEXECUTORCH_SOURCE="$source_dir" -DPYTHON_EXECUTABLE="$export_python" \
  -DCMAKE_BUILD_TYPE=Release "${options[@]}"
"$cmake" --build "$build_dir" --target komatose-et-runner -j "$jobs"
ldd "$build_dir/komatose-et-runner"
