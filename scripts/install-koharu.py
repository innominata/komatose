#!/usr/bin/env python3
"""Install Koharu SAM-TS-L text weights + Hi-SAM source (text mask detector).

Weights come from Hugging Face (pinned revision, SHA256 verified). The Hi-SAM
source comes from a bench checkout if one exists on this machine, otherwise
from GitHub. No bench tree is required — a fresh clone installs the same files
the working reference install runs.

Run with the workflow Python so the import smoke test has torch/cv2:

    .venv-workflow/bin/python scripts/install-koharu.py
"""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
REVISION = '5dd97423e0fbf2404264979136d47e8101144046'
WEIGHT_SHA256 = 'bcd9525291677f467f0603509a0ca3df35711b4e3417cefce8da6bfc97164f45'
WEIGHT_BYTES = 1355824988
HI_SAM_REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'
HF_BASE = 'https://huggingface.co/mayocream/koharu-text-sam-ts-l'
# Hi-SAM lives at ymy-k/Hi-SAM; its main branch is pinned to HI_SAM_REVISION.
CODELOAD_SAM_HQ = f'https://codeload.github.com/ymy-k/Hi-SAM/zip/{HI_SAM_REVISION}'
# Pinned by the HF commit URL; only the weights carry a checksum we verify.
REPO_FILES = ['model.safetensors', 'inference.py', 'config.json']


def models_dir():
    override = os.environ.get('SCAN_KOHARU_DIR')
    return Path(override) if override else ROOT / 'data/models/koharu-text-sam-ts-l'


def hi_sam_dir():
    override = os.environ.get('SCAN_KOHARU_HISAM_ROOT')
    return Path(override) if override else ROOT / f'data/models/hi-sam-{HI_SAM_REVISION}'


def _bench():
    return ROOT / 'data/bench-lettering/model-comparison'


def fetch(url, destination, sha256=None, size=None):
    """Stream url into destination (.download first), verifying sha256/size when known."""

    def already_good():
        if not destination.is_file():
            return False
        if size is not None and destination.stat().st_size != size:
            return False
        if sha256 and hashlib.sha256(destination.read_bytes()).hexdigest() != sha256:
            return False
        # Unpinned small files (inference.py) are immutable via their commit URL.
        return True

    if already_good():
        print(f'Already verified {destination}', flush=True)
        return
    if destination.is_file():
        destination.unlink()
    destination.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(8):
        partial = destination.with_suffix(destination.suffix + '.download')
        try:
            digest = hashlib.sha256()
            print(f'Downloading {url}', flush=True)
            with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            written = partial.stat().st_size
            if size and written != size:
                raise RuntimeError(f'Size mismatch for {destination.name}: {written} != {size}')
            if sha256 and digest.hexdigest() != sha256:
                raise RuntimeError(f'Checksum mismatch for {destination.name}')
            os.replace(partial, destination)
            print(f'Verified {destination}', flush=True)
            return
        except Exception as exc:  # noqa: BLE001 - retry any transport/verify error
            last_error = exc
            partial.unlink(missing_ok=True)
            if attempt == 7:
                break
            pause = min(30, 2 ** (attempt + 1))
            print(f'Download failed ({type(exc).__name__}); retrying in {pause}s', flush=True)
            time.sleep(pause)
    raise SystemExit(f'Could not download {url}: {last_error}')


def install_weights(destination):
    for filename in REPO_FILES:
        target = destination / filename
        sha = WEIGHT_SHA256 if filename == 'model.safetensors' else None
        size = WEIGHT_BYTES if filename == 'model.safetensors' else None
        if target.is_file() and size and target.stat().st_size == size:
            if sha:
                if hashlib.sha256(target.read_bytes()).hexdigest() == sha:
                    print(f'Already verified {target}', flush=True)
                    continue
                target.unlink()
            else:
                print(f'Already present {target}', flush=True)
                continue
        fetch(f'{HF_BASE}/resolve/{REVISION}/{filename}', target, sha256=sha, size=size)


def _find_hisam_root(base, depth=2):
    if (base / 'hi_sam').is_dir():
        return base
    if depth <= 0 or not base.is_dir():
        return None
    for child in sorted(base.iterdir()):
        if child.is_dir():
            found = _find_hisam_root(child, depth - 1)
            if found:
                return found
    return None


def _adopt(source_root, destination):
    """Move a checked-out tree's contents into destination so hi_sam sits at its root."""
    destination.mkdir(parents=True, exist_ok=True)
    for item in source_root.iterdir():
        shutil.move(str(item), destination / item.name)


def _verify_hisam(destination):
    if not (destination / 'hi_sam/modeling/build.py').is_file():
        raise SystemExit(f'Hi-SAM source incomplete at {destination}')
    print(f'Hi-SAM source ready at {destination}', flush=True)


def install_from_zip(zip_path, destination):
    with tempfile.TemporaryDirectory(prefix='koharu-hisam-') as tmp:
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(tmp)
        root = _find_hisam_root(Path(tmp))
        if not root:
            raise SystemExit(f'No hi_sam/ directory inside {zip_path}')
        _adopt(root, destination)
    _verify_hisam(destination)


def install_hi_sam(destination):
    if (destination / 'hi_sam/modeling/build.py').is_file():
        print(f'Hi-SAM source already present at {destination}', flush=True)
        return
    bench_dir = _bench() / f'Hi-SAM-{HI_SAM_REVISION}'
    if (bench_dir / 'hi_sam').is_dir():
        print(f'Copying Hi-SAM source from {bench_dir}', flush=True)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(bench_dir, destination)
        _verify_hisam(destination)
        return
    bench_zip = _bench() / 'hi-sam-source.zip'
    if bench_zip.is_file():
        print(f'Extracting Hi-SAM source from {bench_zip}', flush=True)
        install_from_zip(bench_zip, destination)
        return
    # Fresh machine: pull from GitHub — codeload zip needs no git checkout.
    with tempfile.TemporaryDirectory(prefix='koharu-hisam-dl') as tmp:
        zip_path = Path(tmp) / 'hi-sam.zip'
        fetch(CODELOAD_SAM_HQ, zip_path)
        install_from_zip(zip_path, destination)


def verify():
    weight = models_dir() / 'model.safetensors'
    if not weight.is_file() or weight.stat().st_size != WEIGHT_BYTES:
        raise SystemExit(f'Missing or partial weight: {weight}')
    if hashlib.sha256(weight.read_bytes()).hexdigest() != WEIGHT_SHA256:
        raise SystemExit(f'Checksum mismatch: {weight} (delete it and rerun this installer)')
    for name in ('inference.py',):
        if not (models_dir() / name).is_file():
            raise SystemExit(f'Missing {models_dir() / name}')
    build = hi_sam_dir() / 'hi_sam/modeling/build.py'
    if not build.is_file():
        raise SystemExit(f'Missing {build}')
    print('All Koharu files verified.', flush=True)


def smoke(device='cpu'):
    """Real inference pass — skipped, not failed, when the workflow env is missing."""
    sys.path.insert(0, str(ROOT / 'ocr'))
    try:
        import cv2  # noqa: F401
        import numpy as np
        import torch
        import koharu_mask
    except ImportError as exc:
        print(f'Skipping inference smoke test ({exc}).', flush=True)
        print('Run again with the workflow Python once it exists: '
              '.venv-workflow/bin/python scripts/install-koharu.py', flush=True)
        return
    if device.startswith('cuda') and not torch.cuda.is_available():
        print('GPU smoke skipped: CUDA unavailable', file=sys.stderr)
        device = 'cpu'

    image = np.zeros((128, 160, 3), np.uint8)
    cv2.putText(image, 'A', (40, 90), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 0), 3)
    out = koharu_mask.predict(image, device)
    assert out.shape == image.shape[:2]
    print(f'Koharu smoke OK on {device} ({out.sum()} mask bytes)', flush=True)


if __name__ == '__main__':
    model_dir = Path(os.environ.get('SCAN_KOHARU_DIR') or ROOT / 'data/models/koharu-text-sam-ts-l')
    hi_sam = Path(os.environ.get('SCAN_KOHARU_HISAM_ROOT') or ROOT / f'data/models/hi-sam-{HI_SAM_REVISION}')
    install_weights(model_dir)
    install_hi_sam(hi_sam)
    verify()
    device = 'cuda:0' if '--gpu' in sys.argv else 'cpu'
    smoke(device)
