#!/usr/bin/env python3
"""Prefetch pinned inpainting weights into their model-specific caches.

Big-LaMa, AOT and LaMa Manga use the Hugging Face cache. MI-GAN and
Manga Inpainting use verified release exports under SCAN_WORKFLOW_MODELS_DIR. Installing them up front means Cleaning works offline afterwards
and Setup can show them as installed. Revisions are pinned to the tested files.

    .venv-workflow/bin/python scripts/install-clean-models.py --model big-lama
    .venv-workflow/bin/python scripts/install-clean-models.py --model all
"""
import sys
import json
import argparse
import os
from pathlib import Path
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ocr'))
from inpaint_models import EXPORTS, models_dir, download_verified

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
        "repo": "mayocream/lama-manga",
        "revision": "f91c85b26913b3e83f9877867b4c336da3675238",
        "files": ["lama-manga.safetensors", "config.json"],
        "label": "mayocream LaMa Manga SafeTensors (native PyTorch)",
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
    parser.add_argument("--model", choices=["all", *MODELS, *EXPORTS], default="all",
                        help="Which clean model to prefetch (default all)")
    args = parser.parse_args()
    names = [*MODELS, *EXPORTS] if args.model == "all" else [args.model]
    try:
        import huggingface_hub  # noqa: F401
    except ImportError:
        raise SystemExit(
            "huggingface-hub is not installed for this Python. "
            "Run: python3 scripts/setup-python-env.py --env workflow")
    for name in names:
        if name in EXPORTS:
            spec = EXPORTS[name]
            directory = models_dir() / name
            for filename, (url, checksum) in spec['files'].items():
                print(f'Installing {name}: {filename}', flush=True)
                retry(lambda url=url, filename=filename, checksum=checksum: download_verified(url, directory / filename, checksum))
            retry(lambda: download_verified(spec['license'], directory / 'LICENSE'))
            # Receipts make artifacts visible to task fingerprints even with a custom data root.
            root = Path(os.environ.get('SCAN_ROOT', str(Path(__file__).resolve().parents[1])))
            receipt_dir = Path(os.environ.get('SCAN_DATA_DIR', str(root / 'data'))) / 'models/package-installations'
            receipt_dir.mkdir(parents=True, exist_ok=True)
            receipt = {'source': spec['source'], 'artifacts': [str((directory / f).resolve()) for f in [*spec['files'], 'LICENSE']]}
            temporary = receipt_dir / f'{name}.json.tmp'
            temporary.write_text(json.dumps(receipt) + '\n')
            temporary.replace(receipt_dir / f'{name}.json')
            print(f'Verified {name} in {directory}', flush=True)
        else:
            install_one(name, MODELS[name])


if __name__ == "__main__":
    main()
