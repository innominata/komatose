#!/usr/bin/env python3
"""Bounded, restartable checkpoint audit and native deployment validation.

This driver uses only the standard library except for NumPy when comparing
native tensor results. Each exporter runs in a fresh process with a timeout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import statistics
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from models import ROOT, MODEL_IDS, HF_WEIGHTS, model_directory

BACKENDS = ('portable', 'xnnpack', 'vulkan', 'cuda', 'rocm', 'openvino')


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def checkpoint_files(model_id):
    if model_id in HF_WEIGHTS:
        repo, revision, filename, override = HF_WEIGHTS[model_id]
        if override and os.environ.get(override):
            return [Path(os.environ[override])]
        hub = Path(os.environ.get('HF_HOME', Path.home() / '.cache/huggingface')) / 'hub'
        cached = hub / ('models--' + repo.replace('/', '--'))
        if not revision:
            try:
                revision = (cached / 'refs/main').read_text().strip()
            except OSError:
                return []
        snapshot = cached / 'snapshots' / revision
        # CTD is a three-checkpoint pipeline, not just its backbone.
        filenames = ('yolo-v5.safetensors', 'unet.safetensors', 'dbnet.safetensors') if model_id == 'ctd' else (filename,)
        return [snapshot / name for name in filenames if (snapshot / name).is_file()]
    if model_id == 'coo':
        return [Path(os.environ.get('SCAN_COO_MODEL', ROOT / 'data/models/coo/dbnetpp-coo.pt'))]
    if model_id == 'koharu':
        import koharu_mask
        return [koharu_mask.weights_path()]
    directory = model_directory(model_id)
    return sorted([*directory.glob('*.safetensors'), *directory.glob('*.bin'), *directory.glob('sentence-base/*.pt')])


def inventory(model_ids, out):
    result = {'schemaVersion': 1, 'models': [], 'exclusions': {
        'migan': 'Removed from Komatose by user request; downloaded files retained',
        'manga-inpainting': 'Removed from Komatose by user request; downloaded files retained',
        'paddle': 'Paddle runtime', 'sugoi-v4-ja-en': 'CTranslate2 runtime',
        'gguf-models': 'llama.cpp runtime', 'qwen-image-edit': 'External sd-server runtime'},
        'hardware': {'platform': platform.platform(), 'machine': platform.machine()}}
    for model_id in model_ids:
        row = {'id': model_id, 'files': [], 'requiredHostWork': []}
        if model_id in HF_WEIGHTS:
            repo, revision, filename, override = HF_WEIGHTS[model_id]
            row.update(repository=repo, applicationRevision=revision,
                       revisionPolicy='Pinned' if revision else 'Application currently resolves main; snapshot/checksum frozen by this inventory')
        try:
            for file in checkpoint_files(model_id):
                if file.is_file():
                    row['files'].append({'path': str(file), 'resolvedPath': str(file.resolve()),
                                         'bytes': file.stat().st_size, 'sha256': checksum(file)})
            row['installed'] = bool(row['files'])
        except Exception as exc:
            row.update(installed=False, inventoryError=f'{type(exc).__name__}: {exc}')
        manifest = read_json(ROOT / 'model-packages' / model_id / 'model.json', {})
        row['packageRevision'] = manifest.get('revision')
        row['licensePolicy'] = 'Checkpoint/publisher notices remain with existing installation; this experiment does not redistribute weights'
        result['models'].append(row)
    # Prefer local sysfs facts; GPU selection still must be explicitly recorded.
    result['hardware']['drm'] = []
    for device in sorted(Path('/sys/class/drm').glob('card[0-9]*/device')):
        row = {'path': str(device.resolve())}
        for name in ('vendor', 'device', 'mem_info_vram_total'):
            try:
                row[name] = (device / name).read_text().strip()
            except OSError:
                pass
        result['hardware']['drm'].append(row)
    (out / 'inventory.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


def bounded(command, log, timeout, env=None, stdin=None):
    started = time.perf_counter()
    with log.open('w') as stream:
        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT,
                                   env=env, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                                   start_new_session=True)
        try:
            process.communicate(stdin, timeout=timeout)
            return {'command': command, 'returncode': process.returncode,
                    'elapsedSeconds': time.perf_counter() - started, 'timedOut': False}
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return {'command': command, 'returncode': process.returncode,
                    'elapsedSeconds': time.perf_counter() - started, 'timedOut': True}


def export_all(args):
    tasks = []
    for model in args.models:
        for backend in args.backends:
            if backend in ('cuda', 'openvino') and not args.hardware_verified:
                continue
            for dynamic in ([False, True] if args.include_dynamic else [False]):
                out = args.out / 'results' / model / backend / ('dynamic' if dynamic else 'static')
                out.mkdir(parents=True, exist_ok=True)
                if args.resume and (out / 'export.json').exists():
                    continue
                command = [str(args.python), str(Path(__file__).with_name('export.py')), '--model', model,
                           '--backend', backend, '--out', str(out), '--device', args.export_device]
                if dynamic:
                    command.append('--dynamic')
                tasks.append((model, backend, dynamic, command, out))
    def execute(task):
        model, backend, dynamic, command, out = task
        print(f'Export {model} / {backend} / {"dynamic" if dynamic else "static"}', flush=True)
        result = bounded(command, out / 'process.log', args.timeout)
        (out / 'process.json').write_text(json.dumps(result, indent=2) + '\n')
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        list(pool.map(execute, tasks))


def compare_tensors(case, native, directory):
    import numpy as np
    expected = case['reference']
    actual = native['outputs']
    if len(expected) != len(actual):
        return {'passed': False, 'reason': 'Output count differs'}
    comparisons = []
    for ref, value in zip(expected, actual):
        if ref['shape'] != value['shape'] or ref['dtype'] != value['dtype']:
            comparisons.append({'passed': False, 'reason': 'Shape or dtype differs'})
            continue
        a = np.fromfile(directory / ref['file'], dtype=ref['dtype']).astype(np.float64)
        b = np.fromfile(directory / 'native' / value['file'], dtype=value['dtype']).astype(np.float64)
        if a.shape != b.shape or not np.isfinite(a).all() or not np.isfinite(b).all():
            comparisons.append({'passed': False, 'reason': 'Size differs or output is non-finite'})
            continue
        delta = np.abs(a - b)
        comparisons.append({'passed': bool(np.allclose(a, b, atol=1e-4, rtol=1e-3)),
                            'meanAbsError': float(delta.mean()) if len(delta) else 0,
                            'maxAbsError': float(delta.max()) if len(delta) else 0})
    return {'passed': all(row['passed'] for row in comparisons), 'outputs': comparisons,
            'level': 'tensor-only; complete application operation remains unvalidated'}


def native_all(args):
    if not args.runner or not args.runner.is_file():
        raise SystemExit('--runner must name a built native executable')
    dependencies = subprocess.run(['ldd', str(args.runner)], capture_output=True, text=True, check=False)
    (args.out / 'native-dependencies.txt').write_text(dependencies.stdout + dependencies.stderr)
    if dependencies.returncode or re.search(r'(libtorch|libc10|torch_python|not found)', dependencies.stdout):
        raise SystemExit('Native deployment dependency check failed; see native-dependencies.txt')
    env = {key: value for key, value in os.environ.items() if key not in ('PYTHONPATH', 'LD_LIBRARY_PATH', 'VIRTUAL_ENV')}
    env['PATH'] = '/usr/bin:/bin'
    for case_file in sorted((args.out / 'results').glob('*/*/*/*/case.json')):
        if case_file.parents[3].name not in args.models or case_file.parents[2].name not in args.backends:
            continue
        directory = case_file.parent
        artifact = directory / 'model.pte'
        if not artifact.is_file():
            continue
        result = {'runs': [], 'completeOperationValidated': False}
        native = directory / 'native'
        native.mkdir(exist_ok=True)
        print(f'Native {directory.relative_to(args.out)}', flush=True)
        for index in range(args.fresh_runs):
            command = [str(args.runner.resolve()), str(artifact.resolve()), str(case_file.resolve()),
                       str(native.resolve()), str(args.warm_runs), str(args.stability_runs) if index == 0 else '0', str(args.device_index)]
            process = bounded(command, directory / f'native-{index}.log', args.timeout, env=env)
            records = []
            for line in (directory / f'native-{index}.log').read_text(errors='replace').splitlines():
                try:
                    record = json.loads(line)
                    if isinstance(record, dict) and 'outputs' in record:
                        records.append(record)
                except ValueError:
                    pass
            result['runs'].append({**process, 'measurement': records[-1] if records else None})
            if process['returncode'] or not records:
                break
        if len(result['runs']) == args.fresh_runs and all(row['returncode'] == 0 for row in result['runs']):
            result['comparison'] = compare_tensors(read_json(case_file), result['runs'][-1]['measurement'], directory)
            samples = [value for run in result['runs'] for value in run['measurement']['warmedMs']]
            result['warmedMedianMs'] = statistics.median(samples) if samples else None
            result['fullBenchmarkCompleted'] = args.fresh_runs >= 3 and args.warm_runs >= 10 and args.stability_runs >= 100
        (directory / 'native.json').write_text(json.dumps(result, indent=2) + '\n')


def report(args):
    rows = []
    for model in args.models:
        for backend in args.backends:
            root = args.out / 'results' / model / backend
            attempts = []
            for kind in ('static', 'dynamic'):
                export = read_json(root / kind / 'export.json')
                process = read_json(root / kind / 'process.json')
                if export:
                    for stage in export['stages']:
                        stage['native'] = read_json(root / kind / stage['stage'] / 'native.json')
                    attempts.append(export)
                elif process:
                    attempts.append({'process': process, 'loadError': 'Exporter timeout/crash; see process.log'})
            errors = [a.get('loadError') for a in attempts if a.get('loadError')]
            stages = [s for a in attempts for s in a.get('stages', [])]
            errors += [f"{s['stage']} / {s['phase']}: {s.get('error', '')}" for s in stages if s['status'] == 'blocked']
            for stage in stages:
                native = stage.get('native')
                if native and any(run['returncode'] for run in native.get('runs', [])):
                    errors.append(f"{stage['stage']} / native execution failed; see native-0.log")
                elif native and not native.get('comparison', {}).get('passed', False):
                    errors.append(f"{stage['stage']} / native tensor equivalence failed")
            if not attempts:
                status = 'unverified hardware' if backend in ('cuda', 'rocm', 'openvino') else 'requires changes'
                reason = 'No run on the required hardware/toolchain' if status == 'unverified hardware' else 'Not tested yet'
            elif errors:
                status, reason = 'blocked', errors[0]
            else:
                status = 'requires changes'
                reason = 'Exported stages require complete-operation and dynamic-shape/native validation before migration'
            rows.append({'model': model, 'backend': backend, 'status': status, 'reason': reason,
                         'attempts': attempts, 'recommendedForMigration': False})
    result = {'schemaVersion': 1, 'rows': rows, 'allModelsMigrated': False,
              'productionInstallerChanged': False, 'pyTorchEnvironmentRemovable': False}
    (args.out / 'report.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# ExecuTorch checkpoint audit', '',
             'A serialized graph is not a completed migration. No production ExecuTorch profile is enabled.', '']
    for row in rows:
        reason = row['reason'].splitlines()[0][:260]
        lines.append(f"- **{row['model']} / {row['backend']} — {row['status']}**: {reason}")
    lines += ['', 'Raw results and logs are machine-local under this directory. Weights are not redistributed.',
              'PyTorch cannot be removed until every retained workflow/review operation passes native deployment and application-level validation.', '']
    (args.out / 'report.md').write_text('\n'.join(lines))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['inventory', 'export', 'native', 'report', 'all'], default='all')
    parser.add_argument('--models', nargs='+', choices=MODEL_IDS, default=list(MODEL_IDS))
    parser.add_argument('--backends', nargs='+', choices=BACKENDS, default=['portable', 'xnnpack', 'vulkan', 'cuda', 'openvino'])
    parser.add_argument('--out', type=Path, default=ROOT / 'data/benchmarks/executorch')
    parser.add_argument('--python', type=Path, default=ROOT / 'data/benchmarks/executorch/toolchain/exporter/bin/python')
    parser.add_argument('--runner', type=Path)
    parser.add_argument('--include-dynamic', action='store_true')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--jobs', type=int, choices=range(1, 5), default=1,
                        help='Independent exporter processes; each uses4 CPU threads')
    parser.add_argument('--export-device', default='cpu')
    parser.add_argument('--device-index', type=int, default=0)
    parser.add_argument('--fresh-runs', type=int, choices=range(1, 4), default=3)
    parser.add_argument('--warm-runs', type=int, default=10)
    parser.add_argument('--stability-runs', type=int, default=100)
    parser.add_argument('--hardware-verified', action='store_true', help='Enable CUDA/OpenVINO exports only on verified target hardware')
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    if not 0 <= args.warm_runs <= 10000 or not 0 <= args.stability_runs <= 10000:
        parser.error('Repeat counts must be between0 and10000')
    if args.phase in ('inventory', 'all'):
        inventory(args.models, args.out)
    if args.phase in ('export', 'all'):
        export_all(args)
    if args.phase in ('native', 'all'):
        native_all(args)
    if args.phase in ('report', 'all'):
        report(args)


if __name__ == '__main__':
    main()
