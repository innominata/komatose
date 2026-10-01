#!/usr/bin/env python3
"""Install the translation registry's pinned weights using only the Python standard library."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODELS = json.loads((ROOT / 'src/lib/translationModels.json').read_text())


def verified(path, spec):
    if not path.is_file() or path.stat().st_size != spec['bytes']:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == spec['sha256']


def download(url, path, spec):
    path.parent.mkdir(parents=True, exist_ok=True)
    if verified(path, spec):
        print(f"Already verified {path}", flush=True)
        return
    if shutil.disk_usage(path.parent).free < spec['bytes'] + 128 * 1024**2:
        raise RuntimeError(f"Insufficient disk space for {path.name}")
    partial = path.with_suffix(path.suffix + '.download')
    print(f"Downloading {url} ({spec['bytes']:,} bytes)", flush=True)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if not verified(partial, spec):
            raise RuntimeError(f"Size or SHA256 verification failed for {path.name}")
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)
    print(f"Verified {path}", flush=True)


def has_module(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def pip_install(packages):
    """Install into this interpreter. uv-created venvs have no `pip` module."""
    uv = shutil.which('uv')
    if uv:
        subprocess.check_call([uv, 'pip', 'install', '--python', sys.executable, *packages], cwd=ROOT)
        return
    if not has_module('pip'):
        subprocess.check_call([sys.executable, '-m', 'ensurepip', '--upgrade'], cwd=ROOT)
    subprocess.check_call(
        [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', *packages],
        cwd=ROOT,
    )


SUGOI_DEPS = [('ctranslate2', 'ctranslate2==4.8.2'), ('sentencepiece', 'sentencepiece==0.2.1')]


def ensure_sugoi_deps():
    missing = [spec for name, spec in SUGOI_DEPS if not has_module(name)]
    if not missing:
        return
    print('Installing ' + ' '.join(missing), flush=True)
    pip_install(missing)
    still = [spec for name, spec in SUGOI_DEPS if not has_module(name)]
    if still:
        raise RuntimeError('Failed to import ' + ', '.join(still) + ' after install')


def install(model, dest):
    if model['id'] == 'sugoi-v4-ja-en':
        ensure_sugoi_deps()
    weights = model['weights']
    if not weights:
        print(f"{model['id']}: upstream has not published weights. Convert this "
              f"fine-tune to GGUF and set {model['envPrefix']}_GGUF, place the "
              f".gguf in {dest / model['id']}/, or set {model['envPrefix']}_URL.", flush=True)
        return False
    folder = dest / model['id']
    files = [weights, *weights.get('extras', [])]
    for spec in files:
        url = f"https://huggingface.co/{model['repository']}/resolve/{weights['revision']}/{spec['filename']}"
        download(url, folder / spec['filename'], spec)
    marker = folder / 'installed.json'
    marker.write_text(json.dumps({'repository': model['repository'], **{
        key: weights[key] for key in weights if key != 'extras'
    }, 'extras': weights.get('extras', [])}, indent=2) + '\n')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['all'] + [m['id'] for m in MODELS], default='all')
    parser.add_argument('--dest', type=Path, default=Path(os.environ.get('SCAN_TRANSLATION_MODELS_DIR', ROOT / 'data/models/translation')))
    args = parser.parse_args()
    selected = [m for m in MODELS if args.model in ('all', m['id'])]
    installed = [install(model, args.dest) for model in selected]
    if not any(installed):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
