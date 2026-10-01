#!/usr/bin/env python3
"""Verify Koharu masking against frozen benchmark outputs (offline; no DB writes)."""
import hashlib
import json
import pathlib
import statistics
import sys
import time

import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ocr'))
BENCH = ROOT / 'data/bench-lettering/model-comparison'
sys.path.insert(0, str(ROOT / 'ocr'))
import lettering  # noqa: E402
import workflow  # noqa: E402


def regions_for(snapshot, page):
    documents = {d['id']: d['data'] for d in snapshot['workflow_docs']}
    regions = []
    for line in snapshot['lines']:
        if line['image_id'] != page['id'] or line['source_state'] == 'ignored':
            continue
        x, y, w, h = [line[k] for k in ('x', 'y', 'w', 'h')]
        if any(v is None for v in (x, y, w, h)) or w <= 0 or h <= 0:
            continue
        poly = documents.get('region:' + line['id'], {}).get('polygon')
        regions.append(poly if poly and len(poly) >= 3 else [
            {'x': x, 'y': y}, {'x': x + w, 'y': y},
            {'x': x + w, 'y': y + h}, {'x': x, 'y': y + h}])
    return regions


def main():
    import torch
    device = 'cuda:0' if torch.cuda.is_available() and '--cpu' not in sys.argv else 'cpu'
    snapshot = json.loads((BENCH / 'inputs/snapshot.json').read_text())
    sfx = json.loads((ROOT / 'tests/fixtures/lettering/sfx.json').read_text())
    report = {'device': device, 'engine': 'koharu', 'pages': [], 'workflowPages': []}
    load_start = time.perf_counter()
    lettering.propose_koharu(np.zeros((64, 64, 3), np.uint8), [[{'x': 0, 'y': 0}, {'x': 1, 'y': 0}, {'x': 1, 'y': 1}]], 0, device)
    if device.startswith('cuda'):
        torch.cuda.synchronize()
    report['warmLoadSeconds'] = time.perf_counter() - load_start
    for n, page in enumerate(snapshot['images'], 1):
        path = BENCH / 'inputs' / f'{n}-prepared.png'
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        image = cv2.imread(str(path))
        regions = regions_for(snapshot, page)
        if device.startswith('cuda'):
            torch.cuda.synchronize()
        start = time.perf_counter()
        mask, diagnostics, meta = lettering.propose(image, regions, 3, engine='koharu', device=device)
        if device.startswith('cuda'):
            torch.cuda.synchronize()
        seconds = time.perf_counter() - start
        reference = cv2.imread(str(BENCH / 'koharu' / f'{n}-mask.png'), 0)
        diff = int(np.count_nonzero(mask != reference)) if reference is not None else -1
        union = np.count_nonzero((mask > 0) | (reference > 0))
        inter = np.count_nonzero((mask > 0) & (reference > 0))
        iou = inter / union if union else 1.0
        scored = digest == json.loads((ROOT / 'tests/fixtures/lettering/annotations.json').read_text()).get(str(n), {}).get('sourceSha256')
        record = {'page': n, 'seconds': seconds, 'maskIoU': iou, 'pixelsDifferent': diff,
                  'scoredAgainstAnnotations': scored, 'meta': meta,
                  'peakAllocatedGiB': torch.cuda.max_memory_allocated(device) / 1024 ** 3 if device.startswith('cuda') else 0}
        report['pages'].append(record)
        out = pathlib.Path('/tmp') / f'komatose-koharu-verify-{n}.png'
        req = {'detect': True, 'regions': regions, 'expansion': 3, 'maskEngine': 'koharu', 'device': device}
        workflow_mask = workflow.removal_mask(image, req)
        workflow_meta = req.get('_maskMeta', {})
        report['workflowPages'].append({'page': n, 'matchesLettering': bool(np.array_equal(workflow_mask, mask)),
                                        'engine': workflow_meta.get('engine'), 'version': workflow_meta.get('version')})
        print(json.dumps(record), flush=True)
    warm = [p['seconds'] for p in report['pages'][1:]]
    report['medianWarmSeconds'] = statistics.median(warm) if warm else report['pages'][0]['seconds']
    report['sfx'] = {}
    for target in sfx.get('targets', []):
        page = target['page']
        path = BENCH / 'inputs' / f'{page}-prepared.png'
        image = cv2.imread(str(path))
        x0, y0, x1, y1 = target['box']
        h, w = image.shape[:2]
        left, top, right, bottom = int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)
        mask, _, _ = lettering.propose(image, regions_for(snapshot, snapshot['images'][page - 1]), 3, engine='koharu', device=device)
        crop = mask[top:bottom, left:right]
        ref = cv2.imread(str(BENCH / 'koharu' / f'{page}-mask.png'), 0)[top:bottom, left:right]
        union = np.count_nonzero((crop > 0) | (ref > 0))
        inter = np.count_nonzero((crop > 0) & (ref > 0))
        report['sfx'][target['id']] = {'maskIoU': inter / union if union else 1.0}
    out_path = BENCH / 'koharu-integration-verify.json'
    out_path.write_text(json.dumps(report, indent=2))
    print('Median warm seconds', report['medianWarmSeconds'], 'written', out_path, flush=True)


if __name__ == '__main__':
    main()
