#!/usr/bin/env python3
"""Download pinned AI Review weights without changing the main OCR environment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parents[1]
DEST = Path(os.environ.get("SCAN_REVIEW_MODELS_DIR", ROOT / "data/models/review"))
os.environ.setdefault("HF_HOME", str(DEST / "hf-cache"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from huggingface_hub import HfApi, snapshot_download

MODELS = {
    "hayai-ocr-v2": (
        "JustANormalTinkerer/hayai-ocr-v2",
        "4cf1398f8d9a56a2d4bd7c1d2fb7648773660a62",
        ["*.json", "*.py", "*.safetensors", "README.md"],
        4,
    ),
    "paddleocr-vl-1.6": (
        "PaddlePaddle/PaddleOCR-VL-1.6-GGUF",
        "511b09642bb324401f15f97cc23bc67e8f0a291d",
        ["*.gguf", "chat_template.jinja", "README.md"],
        3,
    ),
    "qwen3-vl-8b": (
        "unsloth/Qwen3-VL-8B-Instruct-GGUF",
        "b93a7ee713758252c555be4210c00540df954dc2",
        ["Qwen3-VL-8B-Instruct-Q8_0.gguf", "mmproj-F16.gguf", "README.md"],
        10,
    ),
    "manga-ocr": (
        "mayocream/manga-ocr",
        "4380edba990b959c508752350955350c1c80c31c",
        ["*.json", "*.safetensors", "*.txt", "README.md"],
        1,
    ),
}
DEFAULT_MODELS = ("hayai-ocr-v2", "paddleocr-vl-1.6", "qwen3-vl-8b")


def retry(operation):
    for attempt in range(8):
        try:
            return operation()
        except Exception as exc:
            if attempt == 7:
                raise
            pause = min(30, 2 ** (attempt + 1))
            print(f"Download service unavailable ({type(exc).__name__}); retrying in {pause}s", flush=True)
            time.sleep(pause)


def install_one(name, repo, revision, patterns):
    import fnmatch
    print(f"Installing {name} at revision {revision}", flush=True)
    retry(lambda: snapshot_download(repo, revision=revision, local_dir=DEST / name,
                                    allow_patterns=patterns, max_workers=1))
    info = retry(lambda: HfApi().model_info(repo, revision=revision, files_metadata=True))
    files = {}
    for f in info.siblings:
        if not any(fnmatch.fnmatch(f.rfilename, p) for p in patterns):
            continue
        path = DEST / name / f.rfilename
        if f.size is not None and path.stat().st_size != f.size:
            raise RuntimeError(f"Incomplete download: {path}")
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if f.lfs and digest != f.lfs.sha256:
            raise RuntimeError(f"SHA256 mismatch: {path}")
        files[f.rfilename] = {"bytes": path.stat().st_size, "sha256": digest}
    print(f"Verified {name}", flush=True)
    return {"repo": repo, "revision": revision, "files": files}


def install_hayai_vision(installed):
    repo = "google/siglip2-base-patch16-naflex"
    revision = retry(lambda: HfApi().model_info(repo)).sha
    retry(lambda: snapshot_download(repo, revision=revision, allow_patterns=["*.json", "*.model"], max_workers=1))
    refs = Path(os.environ["HF_HOME"]) / "hub" / "models--google--siglip2-base-patch16-naflex" / "refs"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / "main").write_text(revision)
    installed["hayai-vision-config"] = {"repo": repo, "revision": revision}


def selected_names(values):
    names = []
    for value in values or ["default"]:
        if value == "default":
            names.extend(DEFAULT_MODELS)
        elif value == "all":
            names.extend(MODELS)
        else:
            names.append(value)
    seen = []
    for name in names:
        if name not in seen:
            seen.append(name)
    return seen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        action="append",
        dest="models",
        choices=["default", "all", *MODELS],
        help="Install default Hayai+Paddle+Qwen3-VL-8B, all optional models, or one id. Repeatable.",
    )
    args = parser.parse_args()
    names = selected_names(args.models)
    DEST.mkdir(parents=True, exist_ok=True)
    need = sum(MODELS[name][3] for name in names)
    if shutil.disk_usage(DEST).free < need * 1024**3:
        raise SystemExit(f"At least {need} GiB free is required for {', '.join(names)}.")
    marker = DEST / "installed.json"
    installed = {}
    if marker.is_file():
        try:
            installed = json.loads(marker.read_text())
        except json.JSONDecodeError:
            installed = {}
    for name in names:
        repo, revision, patterns, _gib = MODELS[name]
        installed[name] = install_one(name, repo, revision, patterns)
        if name == "hayai-ocr-v2":
            install_hayai_vision(installed)
    marker.with_suffix(".tmp").write_text(json.dumps(installed, indent=2) + "\n")
    marker.with_suffix(".tmp").replace(marker)
    print(f"Installed and verified {', '.join(names)} in {DEST}", flush=True)


if __name__ == "__main__":
    main()
