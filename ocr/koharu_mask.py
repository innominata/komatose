"""Koharu SAM-TS-L full-page text removal proposals (publisher preprocessing)."""
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPO = 'mayocream/koharu-text-sam-ts-l'
REVISION = '5dd97423e0fbf2404264979136d47e8101144046'
WEIGHT_SHA256 = 'bcd9525291677f467f0603509a0ca3df35711b4e3417cefce8da6bfc97164f45'
HI_SAM_REVISION = '69009434d4dba5541f228d8f5acb0754c333d417'
VERSION = f'koharu-sam-ts-l-{REVISION[:7]}-v1'
IMAGE_SIZE = 1024

_BENCH = ROOT / 'data/bench-lettering/model-comparison'
_MODELS = {}


def weights_path():
    override = os.environ.get('SCAN_KOHARU_WEIGHTS')
    if override:
        return Path(override)
    prod = ROOT / 'data/models/koharu-text-sam-ts-l/model.safetensors'
    if prod.is_file():
        return prod
    bench = _BENCH / 'koharu-text-sam-ts-l/model.safetensors'
    return bench if bench.is_file() else prod


def hi_sam_root():
    override = os.environ.get('SCAN_KOHARU_HISAM_ROOT')
    if override:
        return Path(override)
    prod = ROOT / f'data/models/hi-sam-{HI_SAM_REVISION}'
    if (prod / 'hi_sam').is_dir():
        return prod
    bench = _BENCH / f'Hi-SAM-{HI_SAM_REVISION}'
    return bench if (bench / 'hi_sam').is_dir() else prod


def installed():
    path = weights_path()
    if not path.is_file():
        return False
    try:
        import hashlib
        if hashlib.sha256(path.read_bytes()).hexdigest() != WEIGHT_SHA256:
            return False
    except OSError:
        return False
    root = hi_sam_root()
    return (root / 'hi_sam' / 'modeling' / 'build.py').is_file()


def _publisher_module():
    inference = ROOT / 'data/models/koharu-text-sam-ts-l/inference.py'
    if not inference.is_file():
        inference = _BENCH / 'koharu-text-sam-ts-l/inference.py'
    if not inference.is_file():
        raise RuntimeError('Koharu inference helper missing; run scripts/install-koharu.py')
    spec = importlib.util.spec_from_file_location('koharu_publisher_inference', inference)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load(device):
    import torch
    from PIL import Image
    from safetensors.torch import load_file

    key = ('koharu', str(device))
    if key in _MODELS:
        return _MODELS[key]
    if not installed():
        raise RuntimeError('Koharu model missing or checksum mismatch; run scripts/install-koharu.py')
    publisher = _publisher_module()
    publisher.install_checkpoint_compatibility()
    root = hi_sam_root()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    from hi_sam.modeling.build import model_registry

    args = SimpleNamespace(checkpoint=None, model_type='vit_l', attn_layers=1, prompt_len=12, hier_det=False)
    model = model_registry['vit_l'](args=args)
    model.load_state_dict(load_file(str(weights_path()), device='cpu'), strict=True)
    model = model.eval()
    if str(device).startswith('cuda'):
        if not torch.cuda.is_available():
            raise RuntimeError('GPU requested for Koharu but PyTorch cannot execute on a GPU')
        model = model.to(device)
    _MODELS[key] = (model, publisher, Image)
    return _MODELS[key]


def predict(image, device='cpu'):
    """Return a full-page uint8 mask in source dimensions before region clipping."""
    import torch
    from PIL import Image

    model, publisher, Image = _load(device)
    h, w = image.shape[:2]
    rgb = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    tensor, (nw, nh) = publisher.prepare(rgb)
    dev = torch.device(device if str(device).startswith('cuda') else 'cpu')
    tensor = tensor.to(dev)
    with torch.inference_mode(), torch.autocast(
        device_type=dev.type,
        dtype=torch.bfloat16,
        enabled=dev.type == 'cuda',
    ):
        outputs = model(
            [{'image': tensor.contiguous(), 'original_size': (IMAGE_SIZE, IMAGE_SIZE)}],
            multimask_output=False,
        )
    raw = outputs[4][0, 0, :nh, :nw].byte().cpu().numpy() * 255
    return np.asarray(Image.fromarray(raw).resize((w, h), Image.Resampling.NEAREST)).copy()


def runtime_backend(device):
    dev = str(device or 'cpu')
    if dev.startswith('cuda'):
        import torch
        name = torch.cuda.get_device_name(torch.device(dev))
        hip = os.environ.get('HIP_VISIBLE_DEVICES') or os.environ.get('CUDA_VISIBLE_DEVICES')
        label = f'{dev} · GPU ({name})'
        if hip:
            label += f' · HIP {hip}'
        return label
    return 'CPU'
