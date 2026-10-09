#!/usr/bin/env python3
"""Install pinned d1 GGUFs or its isolated Vulkan llama.cpp runtime (stdlib only)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('SCAN_DATA_DIR', ROOT / 'data'))
RUNTIME = Path(os.environ.get('SCAN_DECIDER_RUNTIME_DIR', DATA / 'runtimes/llama-decider'))
MODELS = Path(os.environ.get('SCAN_DECIDER_MODELS_DIR', DATA / 'models/deciders')) / 'd1-3b'
COMMIT = '88dcc460d628698bb8305b98c200c34f1edfdc04'
REVISION = 'bb1e436ea78eb96a3f1acb6da865f70c2fbeb563'
FILES = {
    'd1-3B-Q8_0.gguf': (2874781280, '2f0942d5a5f64cf69c3356d2be439b71644b1f0eb3a580912a5a0179eeaba77d'),
    'mmproj-d1-3B-F16.gguf': (853993696, '093be6e3437800b868bc24df13f1d6f6da877ad28dfa5a5da5db01e9e8df7128'),
}


def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(path)


def verified(path, size, sha):
    return path.is_file() and path.stat().st_size == size and digest(path) == sha


def download(name, size, sha):
    path = MODELS / name
    if verified(path, size, sha):
        print(f'Already verified {name}', flush=True)
        return
    part = path.with_suffix('.gguf.part')
    url = f'https://huggingface.co/LiquidAI/d1-3B-GGUF/resolve/{REVISION}/{name}'
    for attempt in range(5):
        try:
            offset = part.stat().st_size if part.exists() else 0
            if offset >= size:
                if offset == size and digest(part) == sha:
                    part.replace(path)
                    return
                part.unlink()
                offset = 0
            req = urllib.request.Request(url, headers={'Range': f'bytes={offset}-'} if offset else {})
            with urllib.request.urlopen(req, timeout=60) as response:
                resumed = offset > 0 and response.status == 206
                if resumed and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                    raise RuntimeError('Download server returned an incorrect byte range')
                total = offset if resumed else 0
                last = time.monotonic()
                with part.open('ab' if resumed else 'wb') as stream:
                    while chunk := response.read(4 * 1024**2):
                        total += len(chunk)
                        if total > size:
                            raise RuntimeError('Download exceeded its pinned size')
                        stream.write(chunk)
                        if time.monotonic() - last >= 5:
                            print(f'{name}: {total / size:.0%}', flush=True)
                            last = time.monotonic()
            if not verified(part, size, sha):
                if part.stat().st_size == size:
                    part.unlink()
                raise RuntimeError(f'Size or SHA256 mismatch for {name}')
            part.replace(path)
            print(f'Verified {name}', flush=True)
            return
        except Exception as exc:
            if attempt == 4:
                raise
            print(f'Download interrupted ({type(exc).__name__}); retrying', flush=True)
            time.sleep(min(10, 2 ** attempt))


def install_weights():
    MODELS.mkdir(parents=True, exist_ok=True)
    missing = sum(size for name, (size, sha) in FILES.items() if not verified(MODELS / name, size, sha))
    if shutil.disk_usage(MODELS).free < missing + 256 * 1024**2:
        raise RuntimeError('Not enough free disk space for d1 weights')
    for name, (size, sha) in FILES.items():
        download(name, size, sha)
    atomic_json(MODELS / 'installed.json', {'revision': REVISION, 'files': {
        name: {'bytes': size, 'sha256': sha} for name, (size, sha) in FILES.items()}})


def install_runtime():
    # Preflight happens before creating or downloading a source checkout.
    missing = [name for name in ('git', 'cmake', 'c++', 'glslc') if not shutil.which(name)]
    if missing:
        raise RuntimeError('Vulkan build prerequisites missing: ' + ', '.join(missing)
                           + '. Install git, cmake, a C++ compiler, glslc, libvulkan-dev and spirv-headers.')
    RUNTIME.mkdir(parents=True, exist_ok=True)
    marker = RUNTIME / 'installed.json'
    binary = RUNTIME / 'build/bin/llama-server'
    if marker.is_file() and binary.is_file():
        receipt = json.loads(marker.read_text())
        if receipt.get('commit') == COMMIT and receipt.get('sha256') == digest(binary):
            print('Dedicated d1 runtime already verified', flush=True)
            return
    if shutil.disk_usage(RUNTIME).free < 2 * 1024**3:
        raise RuntimeError('At least 2 GiB free is needed to build the d1 runtime')
    source = RUNTIME / 'source'
    def run(*args):
        print(' '.join(map(str, args)), flush=True)
        subprocess.run(list(map(str, args)), check=True)
    if not (source / '.git').exists():
        run('git', 'init', source)
        run('git', '-C', source, 'remote', 'add', 'origin', 'https://github.com/ggml-org/llama.cpp.git')
    run('git', '-C', source, 'fetch', '--depth', '1', 'origin', COMMIT)
    run('git', '-C', source, 'checkout', '--detach', COMMIT)
    run('cmake', '-S', source, '-B', RUNTIME / 'build', '-DGGML_VULKAN=ON',
        '-DGGML_NATIVE=OFF', '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DCMAKE_BUILD_TYPE=Release')
    run('cmake', '--build', RUNTIME / 'build', '--target', 'llama-server', '--parallel', '2')
    atomic_json(marker, {'commit': COMMIT, 'backend': 'vulkan', 'sha256': digest(binary)})
    print('Dedicated d1 Vulkan runtime verified', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', action='store_true')
    args = parser.parse_args()
    install_runtime() if args.runtime else install_weights()


if __name__ == '__main__':
    main()
