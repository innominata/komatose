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
    "hayai-ocr-v2.5-nova": (
        "JustANormalTinkerer/hayai-ocr-v2.5-nova",
        "39680c6b2cd1ed17bb15a4cfd9fc2273fdb4cfb6",
        ["*.json", "*.py", "*.safetensors", "README.md"],
        1,
    ),
    "pp-ocrv5-korean": (
        "PaddlePaddle/korean_PP-OCRv5_mobile_rec",
        "117ed1ae00c304d03012ba9d9e4234fae509d5b4",
        ["config.json", "inference.json", "inference.pdiparams", "inference.yml"],
        1,
    ),
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
PPOCR_DETECTOR = ("PaddlePaddle/PP-OCRv5_server_det", "ca867c897ecbca8873081573a802ad70d499cb94")
PPOCR_WEIGHT_SHA256 = {
    "korean_PP-OCRv5_mobile_rec": "cac3e5f12cf04aaa77f6a5bc704e4e736ef2908476551891d84b41b4e9090462",
    "PP-OCRv5_server_det": "183146fe9d9910352f68482f623bcbbb9fa7b9e8fa1463b9ad288cef00524d2d",
}


def install_paddle_cache(cache):
    """Reuse official PaddleX assets offline after checking pinned weight hashes."""
    plans = [("recognizer", MODELS["pp-ocrv5-korean"][:2]), ("detector", PPOCR_DETECTOR)]
    verified = []
    for part, (repo, revision) in plans:
        folder = Path(cache) / repo.split("/")[-1]
        files = {}
        for name in MODELS["pp-ocrv5-korean"][2]:
            path = folder / name
            if not path.is_file() or path.stat().st_size == 0:
                raise RuntimeError(f"Cached model file missing: {path}")
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if name == "inference.pdiparams" and digest != PPOCR_WEIGHT_SHA256[repo.split("/")[-1]]:
                raise RuntimeError(f"Cached weight SHA256 mismatch: {path}")
            files[name] = {"bytes": path.stat().st_size, "sha256": digest}
        verified.append((part, folder, {"repo": repo, "revision": revision, "files": files,
                                       "source": "paddlex-cache", "configuration": "local-cache"}))
    # Validate both models before replacing any destination assets.
    record = {}
    for part, folder, receipt in verified:
        destination = DEST / "pp-ocrv5-korean" / part
        destination.mkdir(parents=True, exist_ok=True)
        for name in receipt["files"]:
            shutil.copyfile(folder / name, destination / name)
        record[part] = receipt
    return record


def verified_paddle_install(installed):
    """Reuse complete, pinned receipt-verified assets without a download-service call."""
    if not isinstance(installed, dict):
        return None
    record = installed.get("pp-ocrv5-korean")
    if not isinstance(record, dict):
        return None
    plans = [("recognizer", MODELS["pp-ocrv5-korean"][:2]), ("detector", PPOCR_DETECTOR)]
    for part, (repo, revision) in plans:
        receipt = record.get(part, {})
        if not isinstance(receipt, dict) or not isinstance(receipt.get("files"), dict):
            return None
        if receipt.get("repo") != repo or receipt.get("revision") != revision:
            return None
        for name in MODELS["pp-ocrv5-korean"][2]:
            expected = receipt.get("files", {}).get(name, {})
            if not isinstance(expected, dict):
                return None
            path = DEST / "pp-ocrv5-korean" / part / name
            try:
                if not expected.get("sha256") or path.stat().st_size != expected.get("bytes") or path.stat().st_size == 0:
                    return None
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                if digest != expected["sha256"]:
                    return None
                if name == "inference.pdiparams" and digest != PPOCR_WEIGHT_SHA256[repo.split("/")[-1]]:
                    return None
            except OSError:
                return None
    return record


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
    parser.add_argument("--paddlex-cache", type=Path,
                        help="Install only PP-OCRv5 Korean from a local official_models cache; pinned weights are checked without network access.")
    args = parser.parse_args()
    names = selected_names(args.models)
    if args.paddlex_cache and names != ["pp-ocrv5-korean"]:
        parser.error("--paddlex-cache requires --model pp-ocrv5-korean only")
    DEST.mkdir(parents=True, exist_ok=True)
    marker = DEST / "installed.json"
    installed = {}
    if marker.is_file():
        try:
            installed = json.loads(marker.read_text())
        except json.JSONDecodeError:
            installed = {}
    existing_paddle = verified_paddle_install(installed) if "pp-ocrv5-korean" in names and not args.paddlex_cache else None
    need = sum(MODELS[name][3] for name in names if name != "pp-ocrv5-korean" or existing_paddle is None)
    if shutil.disk_usage(DEST).free < need * 1024**3:
        raise SystemExit(f"At least {need} GiB free is required for {', '.join(names)}.")
    for name in names:
        repo, revision, patterns, _gib = MODELS[name]
        if name == "pp-ocrv5-korean":
            if existing_paddle is not None:
                print("PP-OCRv5 Korean is already installed; verified both models locally, no download needed", flush=True)
                continue
            installed[name] = install_paddle_cache(args.paddlex_cache) if args.paddlex_cache else {
                "recognizer": install_one(f"{name}/recognizer", repo, revision, patterns),
                "detector": install_one(f"{name}/detector", *PPOCR_DETECTOR, patterns),
            }
        else:
            installed[name] = install_one(name, repo, revision, patterns)
        if name in ("hayai-ocr-v2", "hayai-ocr-v2.5-nova"):
            install_hayai_vision(installed)
    marker.with_suffix(".tmp").write_text(json.dumps(installed, indent=2) + "\n")
    marker.with_suffix(".tmp").replace(marker)
    print(f"Installed and verified {', '.join(names)} in {DEST}", flush=True)


if __name__ == "__main__":
    main()
