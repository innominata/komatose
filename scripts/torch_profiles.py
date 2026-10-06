"""Bounded, read-only hardware discovery and pinned runtime package selection.

No torch import is needed to plan an installation. Device packages are never
selected from HSA_OVERRIDE_GFX_VERSION (which can misidentify the physical GPU).
"""
import os
from pathlib import Path
import platform
import re
import subprocess

AMD_INDEX = 'https://stable.repo.amd.com/rocm/whl-next/'
TORCH_INDEXES = {
    'cpu': 'https://download.pytorch.org/whl/cpu',
    'cuda': 'https://download.pytorch.org/whl/cu126',
    'rocm': AMD_INDEX,
}
# Only device packs qualified by this application belong in the automatic set.
# Additional targets can be requested explicitly and must pass local validation.
AUTO_AMD_ARCHES = {'gfx1100'}


def output(command):
    try:
        p = subprocess.run(command, capture_output=True, text=True, timeout=8, check=False)
        return p.stdout if p.returncode == 0 else ''
    except (OSError, subprocess.TimeoutExpired):
        return ''


def properties(path):
    try:
        return dict(line.split(maxsplit=1) for line in path.read_text().splitlines())
    except (OSError, ValueError):
        return {}


def discover(sysfs=Path('/sys'), dev=Path('/dev')):
    nvidia = []
    text = output(['nvidia-smi', '--query-gpu=name,driver_version,compute_cap,pci.bus_id', '--format=csv,noheader,nounits'])
    for line in text.splitlines():
        fields = [part.strip() for part in line.split(',')]
        if len(fields) == 4:
            try:
                nvidia.append({'name': fields[0], 'driver': fields[1],
                               'capability': float(fields[2]), 'pci': fields[3]})
            except ValueError:
                pass
    amd = []
    for node in sorted((sysfs / 'class/kfd/kfd/topology/nodes').glob('*')):
        p = properties(node / 'properties')
        try:
            target = int(p.get('gfx_target_version', '0'))
            if not target or int(p.get('vendor_id', '0')) != 0x1002:
                continue
            major, minor, stepping = target // 10000, target // 100 % 100, target % 100
            arch = f'gfx{major}{minor:x}{stepping:x}'
            render = int(p['drm_render_minor'])
            device = sysfs / f'class/drm/renderD{render}/device'
            try:
                vram = int((device / 'mem_info_vram_total').read_text())
            except (OSError, ValueError):
                vram = 0
            # Unknown memory is conservative: do not silently include an APU.
            amd.append({'arch': arch, 'render': render, 'pci': device.resolve().name,
                        'integrated': vram <= 2 * 1024**3, 'vramBytes': vram,
                        'accessible': os.access(dev / 'kfd', os.R_OK | os.W_OK)
                                      and os.access(dev / f'dri/renderD{render}', os.R_OK | os.W_OK)})
        except (KeyError, ValueError):
            continue
    return {'system': platform.system(), 'machine': platform.machine(), 'nvidia': nvidia, 'amd': amd}


def plan(variant='auto', architectures=None, hardware=None, environ=None):
    env = os.environ if environ is None else environ
    hw = discover() if hardware is None else hardware
    reasons = []
    requested = variant
    explicit_arches = architectures or env.get('SCAN_TORCH_ARCHES', '')
    if isinstance(explicit_arches, str):
        explicit_arches = [a.strip() for a in explicit_arches.split(',') if a.strip()]
    if any(not re.fullmatch(r'gfx[0-9a-f]{3,5}', a) for a in explicit_arches):
        raise ValueError('Architectures must be physical gfx targets, separated by commas')
    usable_amd = [d for d in hw['amd'] if d['accessible'] and not d['integrated']]
    nvidia = hw['nvidia']
    def driver_at_least(device, minimum):
        try:
            pieces = tuple(int(p) for p in device['driver'].split('.'))
            return (pieces + (0, 0, 0))[:3] >= minimum
        except (ValueError, KeyError):
            return False
    compatible_nvidia = bool(nvidia) and all(d['capability'] >= 5.0 and driver_at_least(d, (560, 28, 3))
        and (d['capability'] < 10 or driver_at_least(d, (580, 65, 6))) for d in nvidia)
    amd_arches = sorted(set(explicit_arches or [d['arch'] for d in usable_amd]))
    supported_platform = hw['system'] == 'Linux' and hw['machine'] == 'x86_64'
    if variant == 'auto':
        if compatible_nvidia:
            variant = 'cuda'
        elif supported_platform and amd_arches and (explicit_arches or set(amd_arches) <= AUTO_AMD_ARCHES):
            variant = 'rocm'
        else:
            variant = 'cpu'
            reasons.append('No compatible NVIDIA or qualified discrete AMD architecture; using CPU wheels')
    custom = env.get('SCAN_TORCH_INDEX', '').strip()
    if custom and requested == 'auto':
        if 'rocm' in custom.lower():
            variant = 'rocm'
        elif re.search(r'(?:cuda|/cu[0-9]+)', custom.lower()) or nvidia:
            variant = 'cuda'
        elif usable_amd:
            variant = 'rocm'
    if variant == 'rocm' and not custom and (not supported_platform or not amd_arches):
        raise ValueError('Split ROCm needs Linux x86-64 and a detected discrete GPU or explicit SCAN_TORCH_ARCHES')
    if variant == 'cuda' and not custom and not compatible_nvidia:
        raise ValueError('CUDA 12.6 needs detected compute capability >=5.0 and a compatible NVIDIA driver (>=560.28.03, >=580.65.06 for Blackwell); use CPU or a custom index')
    if custom:
        index, packages, profile = custom, ['torch', 'torchvision'], f'custom-{variant}'
        reasons.append('SCAN_TORCH_INDEX is preserved; its runtime must pass validation')
    elif variant == 'rocm':
        extras = ','.join(f'device-{a}' for a in amd_arches)
        index, profile = AMD_INDEX, 'rocm-split-10.0.0'
        packages = [f'torch[{extras}]==2.13.0+rocm10.0.0', f'torchvision[{extras}]==0.28.0+rocm10.0.0']
        reasons.append('Only selected device packs; no torchaudio or devel extra')
    else:
        # CUDA 13 drops pre-Turing support; keep 12.6 for mixed/older cards.
        cuda13 = variant == 'cuda' and all(d['capability'] >= 7.5 and driver_at_least(d, (580, 65, 6)) for d in nvidia)
        flavor = 'cu130' if cuda13 else 'cu126' if variant == 'cuda' else 'cpu'
        index = f'https://download.pytorch.org/whl/{flavor}'
        profile = flavor
        packages = [f'torch==2.12.1+{flavor}', f'torchvision==0.27.1+{flavor}']
    return {'schemaVersion': 1, 'requested': requested, 'variant': variant, 'profile': profile,
            'index': index, 'packages': packages, 'architectures': amd_arches if variant == 'rocm' else [],
            'reasons': reasons, 'hardware': hw, 'hardwareVerified': False}
