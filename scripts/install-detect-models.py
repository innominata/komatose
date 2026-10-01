#!/usr/bin/env python3
"""Prefetch pinned text-detection weights into the Hugging Face cache.

ocr/detect.py downloads these on first use; installing them up front means the
first Transcribe run does not pay the download and Setup can show them as
installed. Revisions are pinned so the cached graph is the tested one.

    .venv-ocr/bin/python scripts/install-detect-models.py --model rtdetr
    .venv-ocr/bin/python scripts/install-detect-models.py --model ctd
"""
import argparse
import os
from pathlib import Path
import time

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODELS = {
    "rtdetr": {
        "repo": "ogkalu/comic-text-and-bubble-detector",
        "revision": "16e8a622f91fabc6b5b65c96d32d1183f8843546",
        "files": ["detector.onnx", "config.json", "preprocessor_config.json"],
        "label": "RT-DETR comic region detector (default)",
    },
    "ctd": {
        "repo": "mayocream/comic-text-detector-onnx",
        "revision": "a5d67ec772adef819ef5b0e7aa701fcf4c8bf74a",
        "files": ["comic-text-detector.onnx"],
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
    print(f"Verified {name} ({total / 1e6:.1f} MB in the Hugging Face cache)", flush=True)


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
            "Run: python3 scripts/setup-python-env.py --env ocr")
    for name in names:
        install_one(name, MODELS[name])


if __name__ == "__main__":
    main()
