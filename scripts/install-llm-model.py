#!/usr/bin/env python3
"""Install the pinned ISTA Qwen3.8 27B IQ3_S MTP GGUF used by Komatose GPU mode."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF'
REVISION = 'd562806dbafae37109975e970aae91b43e73b440'
FILES = [
    {
        'filename': 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf',
        'bytes': 12120016960,
        'sha256': '58fd826723939933dc86f45b7fe04545cbc2de1c70f6fe2cdd3858c87a98c12f',
    },
    {
        'filename': 'mmproj-Qwen3.8-27B-BF16.gguf',
        'bytes': 931146528,
        'sha256': '13cb7bebccbd04afc8f4090cb949ecf8937cdf7377c5799b1a0c594e7c0d3e16',
    },
]


def default_dest():
    return Path(os.environ.get('SCAN_LLM_MODELS_DIR') or
                Path.home() / 'models/ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF')


def verified(path, spec):
    if not path.is_file() or path.stat().st_size != spec['bytes']:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == spec['sha256']


def download_url(url, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + '.download')
    print(f'Downloading {url} ({path.name})', flush=True)
    try:
        with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        partial.replace(path)
    finally:
        partial.unlink(missing_ok=True)


def download_hub(dest, spec):
    from huggingface_hub import hf_hub_download
    print(f'Downloading {REPO}/{spec["filename"]}@{REVISION}', flush=True)
    hf_hub_download(
        repo_id=REPO,
        filename=spec['filename'],
        revision=REVISION,
        local_dir=str(dest),
    )


def install_file(dest, spec):
    path = dest / spec['filename']
    if verified(path, spec):
        print(f'Already verified {path}', flush=True)
        return
    dest.mkdir(parents=True, exist_ok=True)
    needed = spec['bytes'] + 128 * 1024**2
    if shutil.disk_usage(dest).free < needed:
        raise RuntimeError(f'Insufficient disk space for {path.name}')
    try:
        download_hub(dest, spec)
    except ImportError:
        url = f'https://huggingface.co/{REPO}/resolve/{REVISION}/{spec["filename"]}'
        download_url(url, path)
    if not verified(path, spec):
        raise RuntimeError(f'Size or SHA256 verification failed for {path.name}')
    print(f'Verified {path}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dest', type=Path, default=default_dest())
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    dest = args.dest.expanduser().resolve()
    if args.verify_only:
        missing = [spec['filename'] for spec in FILES if not verified(dest / spec['filename'], spec)]
        if missing:
            raise SystemExit('Not installed or checksum mismatch: ' + ', '.join(missing))
        print(f'Verified {dest}', flush=True)
        return
    for spec in FILES:
        install_file(dest, spec)
    marker = dest / 'installed.json'
    marker.write_text(json.dumps({
        'repository': REPO,
        'revision': REVISION,
        'files': FILES,
    }, indent=2) + '\n')


if __name__ == '__main__':
    main()
