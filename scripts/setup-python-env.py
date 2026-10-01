#!/usr/bin/env python3
"""Create one of Komatose's Python environments: .venv-ocr, .venv-review, .venv-workflow.

Uses `uv` when it is on PATH (much faster), otherwise the standard-library
`venv` module plus `pip`. PyTorch comes from the CPU wheel index by default so a
fresh install works on any machine; `--torch cuda` or `--torch rocm` fetches a
GPU build, and `--torch auto` picks one when a GPU driver is present.

    python3 scripts/setup-python-env.py --env ocr
    python3 scripts/setup-python-env.py --env review --torch auto
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

# Wheel indexes per PyTorch build. SCAN_TORCH_INDEX overrides the choice outright
# when a site needs a specific CUDA/ROCm minor version.
TORCH_INDEXES = {
    "cpu": "https://download.pytorch.org/whl/cpu",
    "cuda": "https://download.pytorch.org/whl/cu126",
    "rocm": "https://download.pytorch.org/whl/rocm7.1",
}


def detect_torch_variant() -> str:
    """CUDA when the NVIDIA driver is present, else ROCm on AMD hosts, else CPU."""
    if shutil.which("nvidia-smi"):
        return "cuda"
    if shutil.which("rocminfo") or Path("/opt/rocm/lib/libamdhip64.so").exists():
        return "rocm"
    return "cpu"

ENVS = {
    "ocr": {
        "dir": ROOT / ".venv-ocr",
        "requirements": "ocr/requirements.txt",
        "torch": False,
        "env": {},
        "purpose": "text detection + OCR worker",
    },
    "review": {
        "dir": ROOT / ".venv-review",
        "requirements": "ocr/requirements-review.txt",
        "torch": True,
        "env": {},
        "purpose": "Hayai/Manga OCR, reviewers, specialist translators",
    },
    "workflow": {
        "dir": ROOT / ".venv-workflow",
        "requirements": "ocr/requirements-workflow.txt",
        "torch": True,
        # SAM-2's setup.py probes CUDA unless told otherwise; the wheels are CPU.
        "env": {"SAM2_BUILD_CUDA": "0"},
        "purpose": "cleaning, masking, inpainting worker",
    },
}

MARKER = ".komatose-env"


def run(cmd, extra_env=None):
    env = {**os.environ, **(extra_env or {})}
    print("+", " ".join(str(part) for part in cmd), flush=True)
    subprocess.run([str(part) for part in cmd], cwd=ROOT, env=env, check=True)


def create_venv(path: Path):
    if (path / "bin/python").is_file():
        print(f"Using existing {path}", flush=True)
        return
    uv = shutil.which("uv")
    if uv:
        run([uv, "venv", "--python", "3.12", path])
        return
    base = shutil.which("python3") or sys.executable
    print(f"uv not found; creating {path} with {base} -m venv (slower)", flush=True)
    run([base, "-m", "venv", path])


def install(python: Path, packages, index_url=None, extra_env=None):
    uv = shutil.which("uv")
    if uv:
        cmd = [uv, "pip", "install", "--python", python, *packages]
        if index_url:
            cmd += ["--index-url", index_url]
    else:
        cmd = [python, "-m", "pip", "install", "--disable-pip-version-check", *packages]
        if index_url:
            cmd += ["--index-url", index_url]
    run(cmd, extra_env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", choices=sorted(ENVS), required=True, help="Which environment to create")
    parser.add_argument("--force", action="store_true", help="Reinstall even when already set up")
    parser.add_argument(
        "--torch",
        choices=["auto", "cpu", "cuda", "rocm"],
        default="auto",
        help="Which PyTorch build to fetch (auto picks from the host's driver)",
    )
    args = parser.parse_args()

    spec = ENVS[args.env]
    path: Path = spec["dir"]
    marker = path / MARKER
    if marker.is_file() and not args.force:
        print(f"{path} is already set up ({spec['purpose']}). Use --force to reinstall.", flush=True)
        return

    create_venv(path)
    python = path / "bin/python"
    if not python.is_file():
        raise SystemExit(f"Environment creation failed: {python} does not exist")

    if spec["torch"]:
        variant = detect_torch_variant() if args.torch == "auto" else args.torch
        index = os.environ.get("SCAN_TORCH_INDEX") or TORCH_INDEXES[variant]
        print(f"Installing PyTorch ({variant} build from {index})", flush=True)
        install(python, ["torch", "torchvision"], index_url=index)

    requirements = ROOT / spec["requirements"]
    install(python, ["-r", str(requirements)], extra_env=spec["env"])

    marker.write_text(f"{args.env}\n")
    print(f"Ready: {python} ({spec['purpose']})", flush=True)


if __name__ == "__main__":
    main()
