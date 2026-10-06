#!/usr/bin/env python3
"""Measure the CURRENT PyTorch runtime on exactly the exported input tensors.

Run this with .venv-workflow or .venv-review, not the isolated exporter. Cold
process runs include imports and loading. No checkpoints or source are changed.
"""
import time
START = time.perf_counter()
import argparse
import json
import os
from pathlib import Path
import resource
import statistics
import sys
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('SAM2_BUILD_CUDA', '0')
from models import MODEL_IDS, stages, model_directory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=MODEL_IDS, required=True)
    parser.add_argument('--case-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--repeat', type=int, default=10)
    args = parser.parse_args()
    if args.model in ('hayai-ocr-v2', 'manga-ocr'):
        os.environ['HF_HOME'] = str(model_directory(args.model).parent / 'hf-cache')
    import numpy as np
    import torch
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    result = {'torch': torch.__version__, 'device': args.device, 'threads': args.threads, 'stages': []}
    sync = lambda: torch.cuda.synchronize() if args.device.startswith('cuda') else None
    for stage in stages(args.model, args.device):
        case_file = args.case_root / stage.name / 'case.json'
        if not case_file.is_file():
            continue
        case = json.loads(case_file.read_text())
        inputs = tuple(torch.from_numpy(np.fromfile(case_file.parent / value['file'], dtype=value['dtype']).reshape(value['shape'])).to(args.device)
                       for value in case['inputs'])
        row = {'stage': stage.name, 'warmedMs': []}
        with torch.no_grad():
            sync(); start = time.perf_counter()
            output = stage.module(*inputs)
            sync(); row['firstMs'] = (time.perf_counter() - start) * 1000
            row['processToFirstMs'] = (time.perf_counter() - START) * 1000
            for _ in range(args.repeat):
                start = time.perf_counter(); stage.module(*inputs); sync()
                row['warmedMs'].append((time.perf_counter() - start) * 1000)
        row['warmedMedianMs'] = statistics.median(row['warmedMs'])
        row['peakRssBytes'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        if args.device.startswith('cuda'):
            row['peakAllocatedVramBytes'] = torch.cuda.max_memory_allocated()
        else:
            row['peakAllocatedVramBytes'] = None
        # Comparing references catches changes in the exporter dependency stack.
        values = [output] if isinstance(output, torch.Tensor) else list(output)
        row['referenceComparisons'] = []
        for value, ref in zip(values, case['reference']):
            actual = value.detach().cpu().numpy()
            expected = np.fromfile(case_file.parent / ref['file'], dtype=ref['dtype']).reshape(ref['shape'])
            equal = actual.shape == expected.shape and np.allclose(actual, expected, atol=1e-4, rtol=1e-3)
            row['referenceComparisons'].append({'passed': bool(equal),
                'meanAbsError': float(np.abs(actual - expected).mean()) if actual.shape == expected.shape else None})
        result['stages'].append(row)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
