#!/usr/bin/env python3
"""Prefetch pinned text-detection weights into the Hugging Face cache.

ocr/detect.py downloads these on first use; installing them up front means the
first Transcribe run does not pay the download and Setup can show them as
installed. Both native weights and CPU fallback graphs use pinned revisions.

    .venv-workflow/bin/python scripts/install-detect-models.py --model rtdetr
    .venv-workflow/bin/python scripts/install-detect-models.py --model ctd
"""
import argparse
import os
from pathlib import Path
import time
import hashlib
import sys
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ocr'))
from native_detect import (CTD_REPO, CTD_REVISION, CTD_SOURCE_REVISION,
                           CTD_SOURCE_FILES, ctd_source_root)

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODELS = {
    "rtdetr": {
        "repo": "ogkalu/comic-text-and-bubble-detector",
        "revision": "16e8a622f91fabc6b5b65c96d32d1183f8843546",
        "files": ["model.safetensors", "detector.onnx", "config.json", "preprocessor_config.json"],
        "label": "RT-DETR comic region detector (default)",
    },
    "ctd": {
        "repo": CTD_REPO,
        "revision": CTD_REVISION,
        "files": ["yolo-v5.safetensors", "unet.safetensors", "dbnet.safetensors", "config.json"],
        "label": "Comic Text Detector (YOLOv5 blocks + UNet mask)",
    },
}


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


def install_one(name, spec):
    from huggingface_hub import hf_hub_download

    print(f"Installing {name} — {spec['label']} @ {spec['revision'][:12]}", flush=True)
    total = 0
    for filename in spec["files"]:
        path = retry(lambda filename=filename: hf_hub_download(
            repo_id=spec["repo"], filename=filename, revision=spec["revision"]))
        size = Path(path).stat().st_size
        total += size
        print(f"  {filename} — {size / 1e6:.1f} MB", flush=True)
    if name == 'ctd':
        fallback = retry(lambda: hf_hub_download('mayocream/comic-text-detector-onnx',
              'comic-text-detector.onnx', revision='a5d67ec772adef819ef5b0e7aa701fcf4c8bf74a'))
        size = Path(fallback).stat().st_size
        total += size
        print(f'  comic-text-detector.onnx (CPU fallback) — {size / 1e6:.1f} MB', flush=True)
        install_ctd_source()
    print(f"Verified {name} ({total / 1e6:.1f} MB in the Hugging Face cache)", flush=True)


def install_ctd_source():
    """Fetch only the native architecture, unchanged, with its upstream license."""
    root = ctd_source_root()
    base = f'https://raw.githubusercontent.com/dmMaze/BallonsTranslator/{CTD_SOURCE_REVISION}/'
    for name, digest in CTD_SOURCE_FILES.items():
        target = root / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
            continue
        remote = name if name == 'LICENSE' else 'ballontranslator/dl/textdetector/' + name
        def fetch():
            with urllib.request.urlopen(base + remote, timeout=60) as response:
                return response.read()
        data = retry(fetch)
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError(f'CTD upstream source checksum mismatch: {name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(target.suffix + '.download')
        temp.write_bytes(data)
        os.replace(temp, target)
    for directory in [root, root / 'ctd', root / 'yolov5']:
        initializer = directory / '__init__.py'
        if not initializer.is_file() or initializer.read_text() != '':
            initializer.write_text('')
    print(f'CTD native architecture verified: {root}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=["all", *MODELS], default="all",
                        help="Which detector to prefetch (default all)")
    args = parser.parse_args()
    names = list(MODELS) if args.model == "all" else [args.model]
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        raise SystemExit(
            "huggingface-hub is not installed for this Python. "
            "Run: python3 scripts/setup-python-env.py --env workflow")
    for name in names:
        install_one(name, MODELS[name])


if __name__ == "__main__":
    main()
