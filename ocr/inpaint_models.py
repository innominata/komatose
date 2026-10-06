"""Pinned IOPaint-compatible exports and masked inference for independent inpainters.

Export contracts/checksums: Sanster/IOPaint@61a759fb3f332bacdce8b2813f4837495c9b86e0.
"""
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
EXPORTS = {
    'manga-inpainting': {
        'files': {
            'manga_inpaintor.jit': ('https://github.com/Sanster/models/releases/download/manga/manga_inpaintor.jit', '7d8b269c4613b6b3768af714610da86c'),
            'erika.jit': ('https://github.com/Sanster/models/releases/download/manga/erika.jit', '0c926d5a4af8450b0d00bc5b9a095644'),
        },
        'license': 'https://raw.githubusercontent.com/msxie92/MangaInpainting/02b749406e9a88dcea1b98599ce33d6b075a432e/LICENSE',
        'source': 'https://github.com/msxie92/MangaInpainting',
    },
    'migan': {
        'files': {
            'migan_traced.pt': ('https://github.com/Sanster/models/releases/download/migan/migan_traced.pt', '76eb3b1a71c400ee3290524f7a11b89c'),
        },
        'license': 'https://raw.githubusercontent.com/Picsart-AI-Research/MI-GAN/2b793c5ece43f4253e32d4afc257120a5deed6f5/LICENSE-WEIGHTS',
        'source': 'https://github.com/Picsart-AI-Research/MI-GAN',
    },
}


def models_dir():
    data = Path(os.environ.get('SCAN_DATA_DIR', str(Path(os.environ.get('SCAN_ROOT', str(ROOT))) / 'data')))
    return Path(os.environ.get('SCAN_WORKFLOW_MODELS_DIR', str(data / 'models/workflow')))


def file_md5(path):
    digest = hashlib.md5()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def download_verified(url, target, checksum=None):
    """Never expose partial or invalid weights, and retain an existing valid installation."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and checksum and file_md5(target) == checksum:
        return target
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=target.name + '.', suffix='.part', delete=False) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(url, headers={'User-Agent': 'komatose-model-installer'})
            with urllib.request.urlopen(request, timeout=60) as response:
                total = 0
                for block in iter(lambda: response.read(1024 * 1024), b''):
                    output.write(block)
                    total += len(block)
                    if total % (16 * 1024 * 1024) == 0:
                        print(f'  {target.name}: {total / 1e6:.1f} MB downloaded', flush=True)
        if checksum and file_md5(temporary) != checksum:
            raise ValueError(f'Checksum mismatch for {target.name}')
        temporary.replace(target)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def require_installed(name):
    directory = models_dir() / name
    if not all((directory / filename).is_file() for filename in EXPORTS[name]['files']):
        raise ValueError(f'Install {name} in Models before cleaning')
    return directory


def require_grayscale(image):
    import numpy as np
    spread = image.max(axis=2).astype(np.int16) - image.min(axis=2).astype(np.int16)
    if np.count_nonzero(spread > 3) / spread.size > 0.001:
        raise ValueError('Manga Inpainting only supports grayscale pages. Choose another cleaner for color artwork.')


def load_models(name, device):
    import torch
    directory = require_installed(name)
    return tuple(torch.jit.load(str(directory / filename), map_location=device).eval()
                 for filename in EXPORTS[name]['files'])


def run_inpaint(image, mask, name, device, models):
    """BGR uint8 + 255=remove mask -> BGR uint8; caller composites only the mask."""
    import cv2
    import numpy as np
    import torch
    h, w = image.shape[:2]
    with torch.inference_mode():
        if name == 'migan':
            scale = min(1.0, 512 / max(h, w))
            sh, sw = max(1, round(h * scale)), max(1, round(w * scale))
            small = cv2.resize(image, (sw, sh), interpolation=cv2.INTER_AREA) if scale < 1 else image
            selected = cv2.resize(mask, (sw, sh), interpolation=cv2.INTER_NEAREST) if scale < 1 else mask
            small = cv2.copyMakeBorder(small, 0, 512 - sh, 0, 512 - sw, cv2.BORDER_REFLECT)
            selected = cv2.copyMakeBorder(selected, 0, 512 - sh, 0, 512 - sw, cv2.BORDER_CONSTANT)
            x = np.ascontiguousarray(small[:, :, ::-1].transpose(2, 0, 1)).astype(np.float32)[None] / 127.5 - 1
            m = (selected > 0).astype(np.float32)[None, None]
            x, m = torch.from_numpy(x).to(device), torch.from_numpy(m).to(device)
            prediction = models[0](torch.cat([0.5 - m, x * (1 - m)], dim=1))
            rgb = (prediction[0].permute(1, 2, 0) * 127.5 + 127.5).round().clamp(0, 255).to(torch.uint8).cpu().numpy()
            result = np.ascontiguousarray(rgb[:sh, :sw, ::-1])
        elif name == 'manga-inpainting':
            inpainter, line_extractor = models
            small = cv2.copyMakeBorder(image, 0, (-h) % 16, 0, (-w) % 16, cv2.BORDER_REFLECT)
            selected = cv2.copyMakeBorder(mask, 0, (-h) % 16, 0, (-w) % 16, cv2.BORDER_CONSTANT)
            gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)[None, None]
            gray = torch.from_numpy(gray).to(device)
            lines = line_extractor(gray).clamp(0, 255)
            m = torch.from_numpy((selected > 0).astype(np.float32)[None, None]).to(device)
            # A local generator keeps repeated runs reproducible without reseeding other models.
            generator = torch.Generator(device=device).manual_seed(42)
            noise = torch.randn(m.shape, device=device, generator=generator)
            prediction = inpainter(gray / 127.5 - 1, lines / 127.5 - 1, m, noise, torch.ones_like(m))
            gray_out = np.clip(prediction[0].permute(1, 2, 0).cpu().numpy() * 127.5 + 127.5, 0, 255).astype(np.uint8)
            result = cv2.cvtColor(gray_out[:h, :w], cv2.COLOR_GRAY2BGR)
        else:
            raise ValueError(f'Unknown model: {name}')
    return cv2.resize(result, (w, h), interpolation=cv2.INTER_CUBIC) if result.shape[:2] != (h, w) else result
