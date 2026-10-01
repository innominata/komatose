#!/usr/bin/env python3
"""Compare removal masks on an immutable episode snapshot; never writes the DB.

Weights and their pinned metadata live below --root. Download/verify them before
running. Uses publisher preprocessing, saved region geometry, and 3px padding.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import resource
import sys
import time
from types import SimpleNamespace

import cv2
import numpy as np
from PIL import Image

PROJECT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / 'ocr'))


def regions_for(snapshot, page):
    documents = {d['id']: d['data'] for d in snapshot['workflow_docs']}
    regions, boxes = [], []
    for line in snapshot['lines']:
        if line['image_id'] != page['id'] or line['source_state'] == 'ignored':
            continue
        x, y, w, h = [line[k] for k in ('x', 'y', 'w', 'h')]
        if any(v is None for v in (x, y, w, h)) or w <= 0 or h <= 0:
            continue
        poly = documents.get('region:' + line['id'], {}).get('polygon')
        regions.append(poly if poly and len(poly) >= 3 else [
            {'x': x, 'y': y}, {'x': x+w, 'y': y},
            {'x': x+w, 'y': y+h}, {'x': x, 'y': y+h}])
        # This model is trained on detector crops, so use the saved text box
        # rather than enlarging its input to the whole speech balloon polygon.
        boxes.append([x, y, x+w, y+h])
    return regions, boxes


def region_mask(shape, regions):
    h, w = shape
    mask = np.zeros(shape, np.uint8)
    for poly in regions:
        vertices = np.array([[round(p['x']*w), round(p['y']*h)] for p in poly], np.int32)
        cv2.fillPoly(mask, [vertices], 255)
    return mask


def load_model(name, root, threads):
    if name == 'ctd':
        import detect
        detect._session(detect.CTD_REPO, detect.CTD_FILE, threads)
        return None
    import torch
    torch.set_num_threads(threads)
    if name == 'comic':
        return torch.jit.load(str(root/'comic-text-mask/model.pt'), map_location='cpu').eval()
    from safetensors.torch import load_file
    revision = (root/'hi-sam-revision.txt').read_text().strip()
    sys.path.insert(0, str(root/('Hi-SAM-'+revision)))
    spec = importlib.util.spec_from_file_location('publisher_inference', root/'koharu-text-sam-ts-l/inference.py')
    publisher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(publisher)
    publisher.install_checkpoint_compatibility()
    from hi_sam.modeling.build import model_registry
    args = SimpleNamespace(checkpoint=None, model_type='vit_l', attn_layers=1, prompt_len=12, hier_det=False)
    model = model_registry['vit_l'](args=args)
    model.load_state_dict(load_file(str(root/'koharu-text-sam-ts-l/model.safetensors')), strict=True)
    return model.eval(), publisher


def comic_mask(model, image, boxes, size=384):
    import torch
    h, w = image.shape[:2]
    full = np.zeros((h, w), np.uint8)
    crops = []
    for x0, y0, x1, y1 in boxes:
        left, top = max(0, int(x0*w)-8), max(0, int(y0*h)-8)
        right, bottom = min(w, int(np.ceil(x1*w))+8), min(h, int(np.ceil(y1*h))+8)
        if right <= left or bottom <= top:
            continue
        rgb = cv2.cvtColor(image[top:bottom, left:right], cv2.COLOR_BGR2RGB)
        ch, cw = rgb.shape[:2]
        scale = size/max(ch, cw)
        nw, nh = max(1, round(cw*scale)), max(1, round(ch*scale))
        px, py = (size-nw)//2, (size-nh)//2
        square = np.zeros((size, size, 3), np.uint8)
        square[py:py+nh, px:px+nw] = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
        tensor = torch.from_numpy(square).permute(2, 0, 1).unsqueeze(0)
        with torch.inference_mode():
            probability = model(tensor)[0, 0].cpu().numpy()
        # Match the publisher: threshold in model space, then nearest resize.
        mask = (probability[py:py+nh, px:px+nw] > .5).astype(np.uint8)*255
        full[top:bottom, left:right] |= cv2.resize(mask, (cw, ch), interpolation=cv2.INTER_NEAREST)
        crops.append([left, top, right, bottom])
    return full, crops


def koharu_mask(loaded, image):
    import torch
    model, publisher = loaded
    h, w = image.shape[:2]
    rgb = Image.fromarray(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))
    tensor, (nw, nh) = publisher.prepare(rgb)
    with torch.inference_mode():
        outputs = model([{'image': tensor.contiguous(), 'original_size': (1024, 1024)}], multimask_output=False)
    raw = outputs[4][0, 0, :nh, :nw].byte().cpu().numpy()*255
    return np.asarray(Image.fromarray(raw).resize((w, h), Image.Resampling.NEAREST)).copy()


def metrics(mask, allowed, page_number, digest):
    fixture = PROJECT/'tests/fixtures/lettering'
    annotations = json.loads((fixture/'annotations.json').read_text())
    annotation = annotations.get(str(page_number), {})
    if annotation.get('sourceSha256') != digest:
        return {'scored': False, 'reason': 'Source hash differs from the frozen pixel annotations'}
    result = {'scored': True}
    for kind in ('required', 'protected'):
        truth = cv2.imread(str(fixture/annotation[kind]), cv2.IMREAD_GRAYSCALE) > 0
        if truth.shape != mask.shape:
            raise ValueError('Annotation dimensions differ from source')
        result[kind+'Pixels'] = int(truth.sum())
        result[kind+'MaskedPixels'] = int((truth & (mask > 0)).sum())
        result[kind+'InsideRegions'] = int((truth & (allowed > 0)).sum())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, default=PROJECT/'data/bench-lettering/model-comparison')
    parser.add_argument('--model', choices=('ctd', 'comic', 'koharu'), required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--pages', nargs='+', type=int)
    args = parser.parse_args()
    snapshot = json.loads((args.root/'inputs/snapshot.json').read_text())
    output = args.root/args.model
    output.mkdir(exist_ok=True)
    start = time.perf_counter()
    model = load_model(args.model, args.root, args.threads)
    loaded_seconds = time.perf_counter()-start
    print(f'{args.model} loaded in {loaded_seconds:.2f}s', flush=True)
    report_path = output/'results.json'
    report = json.loads(report_path.read_text()) if report_path.exists() else {'pages': []}
    report.update(model=args.model, device='cpu', threads=args.threads,
                  loadSeconds=loaded_seconds, padding=3,
                  scriptSha256=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest())
    for n, page in enumerate(snapshot['images'], 1):
        if args.pages and n not in args.pages:
            continue
        path = args.root/'inputs'/f'{n}-prepared.png'
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        image = cv2.imread(str(path))
        regions, boxes = regions_for(snapshot, page)
        allowed = region_mask(image.shape[:2], regions)
        start = time.perf_counter()
        extra = {}
        if args.model == 'ctd':
            import lettering
            final, diagnostics, _meta = lettering.propose(image, regions, 3)
            seconds = time.perf_counter()-start
            raw, _, _meta = lettering.propose(image, regions, 0)
            extra['diagnostics'] = diagnostics
        else:
            if args.model == 'comic':
                raw, crops = comic_mask(model, image, boxes)
                extra['crops'] = crops
            else:
                raw = koharu_mask(model, image)
            # Keep full predictions for diagnosis, apply exactly the same saved
            # region limits and source-pixel expansion for the removal proposal.
            final = cv2.bitwise_and(cv2.dilate(raw, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))), allowed)
            seconds = time.perf_counter()-start
        overlay = image.copy()
        overlay[final > 0] = (overlay[final > 0]*.45 + np.array([48, 70, 240])*.55).astype(np.uint8)
        for suffix, array in [('raw', raw), ('mask', final), ('overlay', overlay), ('regions', allowed)]:
            cv2.imwrite(str(output/f'{n}-{suffix}.png'), array)
        record = {'page': n, 'imageId': page['id'], 'filename': page['filename'],
                  'sourceSha256': digest, 'seconds': seconds,
                  'maskPixels': int((final > 0).sum()),
                  'metrics': metrics(final, allowed, n, digest), **extra}
        report['pages'] = sorted([r for r in report['pages'] if r['page'] != n]+[record], key=lambda r: r['page'])
        report['peakRssMiB'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024
        report_path.write_text(json.dumps(report, indent=2))
        print(f'Page {n}: {seconds:.2f}s, {record["maskPixels"]} mask pixels, {record["metrics"]}', flush=True)


if __name__ == '__main__':
    main()
