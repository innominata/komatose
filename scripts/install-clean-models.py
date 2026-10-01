#!/usr/bin/env python3
"""Prefetch pinned inpainting weights into the Hugging Face cache.

ocr/workflow.py downloads these on first use of the Big-LaMa / AOT / lama-Manga
clean methods. Installing them up front means Cleaning works offline afterwards
and Setup can show them as installed. Revisions are pinned to the tested files.

    .venv-workflow/bin/python scripts/install-clean-models.py --model big-lama
    .venv-workflow/bin/python scripts/install-clean-models.py --model all
"""
import argparse
import os
from pathlib import Path
import time

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

MODELS = {
    "big-lama": {
        "repo": "dreMaz/AnimeMangaInpainting",
        "revision": "2953a4e935bf01ad1471f6cbfd26ab81abeeb92d",
        "files": ["lama_large_512px.ckpt"],
        "label": "AnimeManga Big-LaMa 512px inpainting checkpoint",
    },
    "aot": {
        "repo": "ogkalu/aot-inpainting",
        "revision": "42ffc84ff1bd46dd95f1c5a41e83ee7e98f39189",
        "files": ["aot_traced.pt", "aot.onnx"],
        "label": "AOT inpainting (traced GPU build + CPU ONNX build)",
    },
    "lama-manga": {
        "repo": "ogkalu/lama-manga-onnx-dynamic",
        "revision": "ee4ed4a8447b6730fc41d34f90876b6c48af925a",
        "files": ["lama-manga-dynamic.onnx"],
        "label": "LaMa-manga dynamic ONNX (CPU balloon fill)",
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
                        help="Which clean model to prefetch (default all)")
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
