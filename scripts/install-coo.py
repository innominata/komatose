#!/usr/bin/env python3
"""Install the official COO DBNet++ checkpoint, verifying its exact checksum.

Run with the workflow Python after installing ocr/requirements-workflow.txt.
No upstream training code or custom CUDA extension is installed.
"""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
URL = 'https://www.dropbox.com/s/zu47mriwv2i9npr/DB%2B%2B_finetune_COO?dl=1'
SHA256 = '889a26c041cc03be7c3864de940368dc393b46d036da49f9bf762a8b798724cf'


def install(destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == SHA256:
        print(f'COO checkpoint verified: {destination}')
        return
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.download', delete=False) as out:
            temporary = Path(out.name)
            digest = hashlib.sha256()
            with urllib.request.urlopen(URL, timeout=120) as response:
                while chunk := response.read(1024*1024):
                    digest.update(chunk)
                    out.write(chunk)
        if digest.hexdigest() != SHA256:
            raise RuntimeError('COO download checksum mismatch; the existing model was not changed')
        os.replace(temporary, destination)
        print(f'COO checkpoint installed: {destination}')
    finally:
        if temporary: temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    import torch
    import torchvision
    import pyclipper
    destination = Path(os.environ.get('SCAN_COO_MODEL') or ROOT/'data/models/coo/dbnetpp-coo.pt')
    install(destination)
    sys.path.insert(0, str(ROOT/'ocr'))
    from coo_model import COOModel
    torch.set_num_threads(2)
    prediction = COOModel(destination)(torch.zeros(1,3,64,96))
    assert tuple(prediction.shape) == (1,1,64,96) and torch.isfinite(prediction).all()
    print(f'COO inference ready (torch {torch.__version__}, torchvision {torchvision.__version__})')
