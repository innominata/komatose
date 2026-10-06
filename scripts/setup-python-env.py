#!/usr/bin/env python3
"""Create one of Komatose's Python environments: .venv-ocr, .venv-review, .venv-workflow.

Uses `uv` when it is on PATH (much faster), otherwise the standard-library
`venv` module plus `pip`. PyTorch defaults to automatic driver detection;
`--torch cpu`, `--torch cuda`, or `--torch rocm` selects a particular build.

    python3 scripts/setup-python-env.py --env ocr
    python3 scripts/setup-python-env.py --env review --torch auto
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import hashlib

ROOT = Path(__file__).resolve().parents[1]

# Importable both as a CLI and from regression tests.
import json
import signal
import time
import uuid
import fcntl
import ctypes
import shlex
sys.path.insert(0, str(Path(__file__).resolve().parent))
from torch_profiles import TORCH_INDEXES, discover, plan as torch_plan


def detect_torch_variant() -> str:
    return torch_plan()['variant']

ENVS = {
    "ocr": {
        "dir": ROOT / ".venv-ocr",
        "requirements": "ocr/requirements.txt",
        "torch": False,
        "env": {},
        "purpose": "text detection + OCR worker",
    },
    "review": {
        "dir": ROOT / ".venv-review",
        "requirements": "ocr/requirements-review.txt",
        "torch": True,
        "env": {},
        "purpose": "Hayai/Manga OCR, reviewers, specialist translators",
    },
    "workflow": {
        "dir": ROOT / ".venv-workflow",
        "requirements": "ocr/requirements-workflow.txt",
        "torch": True,
        # Disable SAM-2's optional CUDA extension; core model inference uses torch.
        "env": {"SAM2_BUILD_CUDA": "0"},
        "purpose": "cleaning, masking, inpainting worker",
    },
}

MARKER = ".komatose-env"


def run(cmd, extra_env=None):
    env = {**os.environ, **(extra_env or {})}
    print("+", " ".join(str(part) for part in cmd), flush=True)
    subprocess.run([str(part) for part in cmd], cwd=ROOT, env=env, check=True)


def create_venv(path: Path):
    if (path / "bin/python").is_file():
        print(f"Using existing {path}", flush=True)
        return
    uv = shutil.which("uv")
    if uv:
        run([uv, "venv", "--python", "3.12", "--allow-existing", path])
        return
    base = shutil.which("python3.12")
    if not base:
        raise SystemExit("Python 3.12 or uv is required to create a supported environment")
    print(f"uv not found; creating {path} with {base} -m venv (slower)", flush=True)
    run([base, "-m", "venv", path])


def install(python: Path, packages, index_url=None, extra_env=None, reinstall=False, constraints=None):
    uv = shutil.which("uv")
    if uv:
        cmd = [uv, "pip", "install", "--python", python, *packages]
        if reinstall:
            cmd += ['--reinstall']
        if index_url:
            cmd += ["--index-url", index_url]
    else:
        cmd = [python, "-m", "pip", "install", "--disable-pip-version-check", *packages]
        if reinstall:
            cmd += ['--force-reinstall']
        if index_url:
            cmd += ["--index-url", index_url]
    if constraints:
        cmd += ['-c', str(constraints)]
    run(cmd, extra_env)


def gpu_onnx_installed(python: Path) -> bool:
    result = subprocess.run([str(python), '-c',
        "import importlib.metadata as m; "
        "print(any(d.metadata['Name'].lower() in "
        "('onnxruntime-gpu', 'onnxruntime-migraphx') for d in m.distributions()))"],
        capture_output=True, text=True, timeout=20, check=True)
    return result.stdout.strip() == 'True'


def installed_torch_variant(python: Path) -> str:
    result = subprocess.run([str(python), '-c',
        "import torch; print('rocm' if torch.version.hip else "
        "'cuda' if torch.version.cuda else 'cpu')"],
        capture_output=True, text=True, timeout=20)
    return result.stdout.strip() if result.returncode == 0 else 'missing'


RECEIPT = '.komatose-runtime.json'
OWNER = '.komatose-generation'
ENV_VARIABLES = {'ocr': 'PADDLEOCR_PYTHON', 'review': 'SCAN_REVIEW_PYTHON', 'workflow': 'SCAN_WORKFLOW_PYTHON'}


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def allocated_bytes(path):
    seen, size = set(), 0
    for directory, _, files in os.walk(path, followlinks=False):
        for name in files:
            p = Path(directory) / name
            try:
                st = p.lstat()
                identity = (st.st_dev, st.st_ino)
                if identity not in seen:
                    seen.add(identity)
                    size += st.st_blocks * 512
            except OSError:
                pass
    return size


def environment_plan(name, variant='auto', architectures=None):
    spec = ENVS[name]
    path = spec['dir']
    requirements = ROOT / spec['requirements']
    selected = torch_plan(variant, architectures) if spec['torch'] else None
    receipt = read_json(path / RECEIPT)
    configured = os.environ.get(ENV_VARIABLES[name], '').strip()
    if configured:
        receipt = read_json(Path(configured).parent.parent / RECEIPT)
    current_hash = hashlib.sha256(requirements.read_bytes()).hexdigest()
    external = path.is_symlink() and not owned_generation(path.resolve(), name)
    legacy = (path / MARKER).is_file() and not receipt
    upgrade = bool(spec['torch'] and (path / 'bin/python').is_file() and
                   (not receipt or receipt.get('plan', {}).get('profile') != selected['profile']
                    or receipt.get('plan', {}).get('architectures') != selected['architectures']
                    or receipt.get('plan', {}).get('packages') != selected['packages']
                    or receipt.get('plan', {}).get('index') != selected['index']
                    or receipt.get('requirementsHash') != current_hash))
    return {'schemaVersion': 1, 'environment': name, 'path': str(path),
            'requirementsHash': current_hash, 'plan': selected, 'receipt': receipt,
            'legacyReceipt': legacy, 'externalTarget': external,
            'configuredInterpreter': configured or None, 'upgradeAvailable': upgrade and not configured,
            'installedBytes': receipt.get('installedBytes') if receipt else None,
            'caches': {'shared': True, 'includedInInstalledBytes': False, 'directories': [
                str(Path(os.environ.get('UV_CACHE_DIR', Path.home() / '.cache/uv'))),
                str(Path(os.environ.get('PIP_CACHE_DIR', Path.home() / '.cache/pip')))]},
            'reasons': ['Configured interpreter is read-only; manage it outside Komatose'] if configured else
                       ['Existing external symlink target will be preserved'] if external else []}


def generation_root():
    return ROOT / 'data/python-envs'


def owned_generation(path, name):
    try:
        return (not path.is_symlink() and path.parent.resolve() == generation_root().resolve()
                and (path / OWNER).read_text() == f'{ROOT.resolve()}\n{name}\n')
    except OSError:
        return False


def configured_interpreter_inside(path):
    for variable in [*ENV_VARIABLES.values(), 'SCAN_TRANSLATION_PYTHON']:
        configured = os.environ.get(variable, '').strip()
        if configured and (Path(configured).parent.resolve() / Path(configured).name).is_relative_to(path):
            return True
    return False


def validate(python, selected):
    if not selected:
        run([python, '-c', 'import numpy, cv2, onnxruntime'])
        return {'passed': True, 'completeModelsValidated': False}
    cmd = [str(python), str(ROOT / 'scripts/validate-torch-runtime.py'), '--variant', selected['variant'],
           '--architectures', ','.join(selected['architectures'])]
    result = subprocess.run(cmd, cwd=ROOT, env={**os.environ, 'SAM2_BUILD_CUDA': '0'},
                            capture_output=True, text=True, timeout=180, check=True)
    print(result.stderr, end='', file=sys.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


def validate_models(name, python, selected, old_python=None):
    if not selected:
        return {'passed': True, 'models': [], 'comparison': False}
    output = ROOT / 'data/python-env-validation' / uuid.uuid4().hex
    output.mkdir(parents=True)
    env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'SAM2_BUILD_CUDA': '0'}
    device = 'cpu' if selected['variant'] == 'cpu' else 'cuda:0'
    if env.get('SCAN_HIP_VISIBLE_DEVICES') and selected['variant'] == 'rocm':
        env.setdefault('HIP_VISIBLE_DEVICES', env['SCAN_HIP_VISIBLE_DEVICES'])
    # Use one validated discrete card by physical PCI order. Respect explicit masks.
    if selected['variant'] == 'rocm' and not any(key in env for key in ('HIP_VISIBLE_DEVICES', 'ROCR_VISIBLE_DEVICES', 'CUDA_VISIBLE_DEVICES')):
        cards = selected['hardware']['amd']
        selected_card = next((d for d in cards if not d['integrated'] and d['arch'] in selected['architectures']), None)
        if selected_card:
            env['HIP_VISIBLE_DEVICES'] = str(cards.index(selected_card))
    if old_python and old_python.is_file():
        old_device = 'cpu' if installed_torch_variant(old_python) == 'cpu' else device
        old_env = dict(env)
        old_receipt = read_json(old_python.parent.parent / RECEIPT)
        if selected['variant'] == 'rocm' and not (old_receipt and old_receipt.get('plan', {}).get('profile', '').startswith('rocm-split-')):
            old_env.setdefault('HSA_OVERRIDE_GFX_VERSION', '11.0.0')
        run([old_python, ROOT / 'scripts/validate-python-models.py', '--env', name, '--device', old_device,
             '--available-only', '--out', output / 'reference'], old_env)
    command = [python, ROOT / 'scripts/validate-python-models.py', '--env', name, '--device', device,
               '--available-only', '--out', output / 'candidate']
    if old_python and old_python.is_file():
        command += ['--reference', output / 'reference']
    run(command, env)
    result = read_json(output / 'candidate/report.json')
    if not result or not result['passed']:
        raise RuntimeError('Installed-model validation failed; active environment preserved')
    result['resultsDirectory'] = str(output)
    return result


def activate(name, destination, workers_drained=False):
    path = ENVS[name]['dir']
    if not owned_generation(destination, name):
        raise RuntimeError('Candidate is not an application-owned generation')
    receipt = read_json(destination / RECEIPT)
    expected = hashlib.sha256((ROOT / ENVS[name]['requirements']).read_bytes()).hexdigest()
    if not receipt or receipt.get('requirementsHash') != expected or not receipt.get('validation', {}).get('passed'):
        raise RuntimeError('Candidate receipt is missing, stale, or unvalidated')
    old = path.resolve() if path.exists() else None
    temporary = path.with_name(path.name + '.next-' + uuid.uuid4().hex)
    temporary.symlink_to(destination)
    try:
        if path.exists() and not path.is_symlink():
            # Linux renameat2 exchanges a real legacy venv and the new symlink
            # atomically. There is no missing-path window, even on SIGKILL.
            libc = ctypes.CDLL(None, use_errno=True)
            exchange = libc.renameat2
            exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            exchange.restype = ctypes.c_int
            if exchange(-100, os.fsencode(temporary), -100, os.fsencode(path), 2) != 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))
            backup = path.with_name(path.name + '.legacy-' + uuid.uuid4().hex)
            try:
                temporary.rename(backup)
            except OSError:
                print(f'Activated; preserved the legacy environment at {temporary}', file=sys.stderr)
        else:
            os.replace(temporary, path)
    finally:
        if temporary.is_symlink():
            temporary.unlink(missing_ok=True)
    if workers_drained and old and old != destination and owned_generation(old, name) and not configured_interpreter_inside(old):
        try:
            shutil.rmtree(old)
        except OSError:
            print(f'Activated; could not clean the old owned generation {old}', file=sys.stderr)
    return receipt


def install_generation(name, selected, workers_drained=False, stage_only=False):
    spec = ENVS[name]
    path, requirements = spec['dir'], ROOT / spec['requirements']
    base = generation_root()
    base.mkdir(parents=True, exist_ok=True)
    destination = base / f'{name}-{uuid.uuid4().hex}'
    destination.mkdir()
    (destination / OWNER).write_text(f'{ROOT.resolve()}\n{name}\n')
    old = path.resolve() if path.exists() else None
    activated = False
    try:
        create_venv(destination)
        python = destination / 'bin/python'
        constraints = destination / '.runtime-constraints.txt'
        if selected:
            install(python, selected['packages'], index_url=selected['index'])
            # Local version pins keep later model dependencies on this exact wheel.
            versions = subprocess.run([str(python), '-c',
                "import importlib.metadata as m; print('torch=='+m.version('torch')); print('torchvision=='+m.version('torchvision'))"],
                capture_output=True, text=True, check=True).stdout
            constraints.write_text(versions)
        install(python, ['-r', str(requirements)], extra_env=spec['env'],
                constraints=constraints if selected else None)
        # New generations contain only CPU ONNX; shared-namespace repair is not
        # needed because no previous GPU distribution has ever been installed here.
        validation = validate(python, selected)
        model_validation = validate_models(name, python, selected, path / 'bin/python' if old else None)
        validation['modelValidation'] = model_validation
        validation['completeModelsValidated'] = bool(model_validation['models']) and all(row.get('passed', False) for row in model_validation['models'])
        frozen = subprocess.run([str(python), '-c',
            "import importlib.metadata as m,json; print(json.dumps({d.metadata['Name']:d.version for d in m.distributions()}))"],
            capture_output=True, text=True, check=True)
        receipt = {'schemaVersion': 1, 'environment': name, 'createdAt': time.time(),
                   'requirementsHash': hashlib.sha256(requirements.read_bytes()).hexdigest(),
                   'plan': dict(selected, hardwareVerified=True) if selected else None, 'validation': validation, 'versions': json.loads(frozen.stdout),
                   'installedBytes': allocated_bytes(destination), 'cachesIncluded': False}
        (destination / RECEIPT).write_text(json.dumps(receipt, indent=2) + '\n')
        (destination / MARKER).write_text(f"{name}\n{receipt['requirementsHash']}\n")
        if stage_only:
            activated = True  # Retain the isolated candidate; do not change the active link.
            print(json.dumps({'candidate': str(destination), 'receipt': receipt}), flush=True)
            return receipt
        # Absolute shebangs already point at this permanent generation path.
        activate(name, destination, workers_drained)
        activated = True
        print(f"Ready: {path / 'bin/python'} ({spec['purpose']}); {receipt['installedBytes']} installed bytes; caches separate", flush=True)
        return receipt
    finally:
        if not activated and owned_generation(destination, name):
            shutil.rmtree(destination)


def load_configuration():
    """Respect installation-related .env settings without importing app dependencies."""
    names = {*ENV_VARIABLES.values(), 'SCAN_TORCH_INDEX', 'SCAN_TORCH_ARCHES', 'SCAN_TORCH_VARIANT',
             'SCAN_HIP_VISIBLE_DEVICES', 'SCAN_TRANSLATION_PYTHON', 'SCAN_REVIEW_MODELS_DIR', 'SCAN_TRANSLATION_MODELS_DIR',
             'SCAN_LAMA_CHECKPOINT', 'SCAN_BIG_LAMA_CHECKPOINT', 'SCAN_SAM_CHECKPOINT', 'SCAN_COO_MODEL',
             'SCAN_CTD_SOURCE_DIR', 'SCAN_KOHARU_WEIGHTS', 'SCAN_KOHARU_HISAM_ROOT',
             'SCAN_TRANSLATION_OPUS_JAEN_CKPT', 'SCAN_TRANSLATION_KOEN_CKPT'}
    try:
        lines = (ROOT / '.env').read_text().splitlines()
    except OSError:
        return
    for line in lines:
        key, separator, value = line.strip().removeprefix('export ').partition('=')
        if separator and key in names and key not in os.environ:
            try:
                parts = shlex.split(value, comments=True)
                os.environ[key] = ' '.join(parts)
            except ValueError:
                raise SystemExit(f'Invalid quoting for {key} in .env')


def main():
    load_configuration()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', choices=sorted(ENVS), required=True)
    parser.add_argument('--force', action='store_true', help='Rebuild in a new generation')
    parser.add_argument('--upgrade-runtime', action='store_true', help='Explicitly replace a legacy runtime with the selected profile')
    parser.add_argument('--plan-json', action='store_true', help='Read-only installation plan and status')
    parser.add_argument('--activate-candidate', type=Path, help='Revalidate and activate an owned staged generation')
    parser.add_argument('--stage-only', action='store_true', help='Build and validate a candidate without activating it')
    parser.add_argument('--workers-drained', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--torch', choices=['auto', 'cpu', 'cuda', 'rocm'], default=os.environ.get('SCAN_TORCH_VARIANT', 'auto'))
    parser.add_argument('--architectures', help='Explicit physical AMD gfx targets, comma separated')
    args = parser.parse_args()
    status = environment_plan(args.env, args.torch, args.architectures)
    if args.plan_json:
        print(json.dumps(status))
        return
    if status['configuredInterpreter']:
        raise SystemExit('Configured interpreter is read-only; unset '+ENV_VARIABLES[args.env]+' to install a Komatose-managed environment')
    spec, path = ENVS[args.env], ENVS[args.env]['dir']
    expected = f"{args.env}\n{status['requirementsHash']}\n"
    existing = (path / MARKER).is_file() and (path / 'bin/python').is_file()
    current = installed_torch_variant(path / 'bin/python') if spec['torch'] and existing else 'missing'
    repair_onnx = existing and args.env in ('ocr', 'workflow') and gpu_onnx_installed(path / 'bin/python')
    explicit_change = spec['torch'] and args.torch != 'auto' and current != args.torch
    if existing and not args.activate_candidate and (path / MARKER).read_text() == expected and not (args.force or args.upgrade_runtime or explicit_change or repair_onnx) and (not spec['torch'] or current != 'missing'):
        print(f'{path} is already set up. Use --upgrade-runtime to change its runtime profile.', flush=True)
        return
    base = generation_root()
    base.mkdir(parents=True, exist_ok=True)
    with (base / f'.{args.env}.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Another installer is updating this environment')
        if args.activate_candidate:
            candidate = args.activate_candidate.resolve()
            if not owned_generation(candidate, args.env):
                raise SystemExit('Candidate is not an application-owned generation')
            receipt = read_json(candidate / RECEIPT)
            selected = receipt.get('plan') if receipt else None
            if spec['torch'] and not selected:
                raise SystemExit('Candidate has no runtime profile receipt')
            validation = validate(candidate / 'bin/python', selected)
            models = validate_models(args.env, candidate / 'bin/python', selected, path / 'bin/python' if (path / 'bin/python').is_file() else None)
            validation['modelValidation'] = models
            validation['completeModelsValidated'] = bool(models['models']) and all(r.get('passed', False) for r in models['models'])
            receipt['validation'] = validation
            receipt['installedBytes'] = allocated_bytes(candidate)
            if selected:
                receipt['plan']['hardwareVerified'] = True
            (candidate / RECEIPT).write_text(json.dumps(receipt, indent=2) + '\n')
            activate(args.env, candidate, args.workers_drained)
            print(f'Ready: {path / "bin/python"}', flush=True)
            return
        selected = status['plan']
        if existing and spec['torch'] and args.torch == 'auto' and not (args.force or args.upgrade_runtime):
            old_receipt = read_json(path / RECEIPT)
            if old_receipt and old_receipt.get('plan'):
                selected = old_receipt['plan']
            else:
                index = {'cpu': TORCH_INDEXES['cpu'], 'cuda': TORCH_INDEXES['cuda'], 'rocm': 'https://download.pytorch.org/whl/rocm7.1'}.get(current)
                if index:
                    versions = subprocess.run([str(path / 'bin/python'), '-c',
                        "import importlib.metadata as m,json; print(json.dumps([m.version('torch'),m.version('torchvision')]))"],
                        capture_output=True, text=True, check=True)
                    torch_version, vision_version = json.loads(versions.stdout)
                    selected = dict(selected, variant=current, profile=f'legacy-{current}',
                                    index=os.environ.get('SCAN_TORCH_INDEX') or index, architectures=[],
                                    packages=[f'torch=={torch_version}', f'torchvision=={vision_version}'])
        install_generation(args.env, selected, args.workers_drained, args.stage_only)


if __name__ == '__main__':
    # Graceful cancellation unwinds the generation transaction. The caller must
    # signal the process group so package managers do not survive cancellation.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()
