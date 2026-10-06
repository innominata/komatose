#!/usr/bin/env python3
"""Compare retained application models across two runtimes on licensed fixtures.

Each model runs in an isolated child. No checkpoint or processor downloads are
allowed. References, crops and measurements are machine-local, under data/.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
MODELS = {'workflow': ['lama-manga', 'big-lama', 'aot', 'sam', 'koharu', 'rtdetr', 'ctd', 'coo'],
          'review': ['hayai-ocr-v2', 'manga-ocr', 'opus-mt-ja-en', 'imsbee-ko-en-translator']}
sys.path.insert(0, str(ROOT / 'ocr'))


def available(model_id):
    if model_id in ('hayai-ocr-v2', 'manga-ocr'):
        folder = Path(os.environ.get('SCAN_REVIEW_MODELS_DIR', ROOT / 'data/models/review')) / model_id
        return (folder / 'model.safetensors').is_file()
    if model_id in ('opus-mt-ja-en', 'imsbee-ko-en-translator'):
        folder = Path(os.environ.get('SCAN_TRANSLATION_MODELS_DIR', ROOT / 'data/models/translation')) / model_id
        return (folder / ('sentence-base/best.pt' if model_id.startswith('imsbee') else 'pytorch_model.bin')).is_file()
    if model_id == 'koharu':
        import koharu_mask
        return koharu_mask.installed()
    if model_id == 'coo':
        import coo
        return coo.model_path().is_file()
    from huggingface_hub import hf_hub_download
    weights = {
      'lama-manga': ('mayocream/lama-manga', 'lama-manga.safetensors', 'f91c85b26913b3e83f9877867b4c336da3675238', 'SCAN_LAMA_CHECKPOINT'),
      'big-lama': ('dreMaz/AnimeMangaInpainting', 'lama_large_512px.ckpt', '2953a4e935bf01ad1471f6cbfd26ab81abeeb92d', 'SCAN_BIG_LAMA_CHECKPOINT'),
      'aot': ('ogkalu/aot-inpainting', 'aot_traced.pt', '42ffc84ff1bd46dd95f1c5a41e83ee7e98f39189', ''),
      'sam': ('facebook/sam2.1-hiera-small', 'sam2.1_hiera_small.pt', None, 'SCAN_SAM_CHECKPOINT'),
      'rtdetr': ('ogkalu/comic-text-and-bubble-detector', 'model.safetensors', '16e8a622f91fabc6b5b65c96d32d1183f8843546', ''),
      'ctd': ('mayocream/comic-text-detector', 'yolo-v5.safetensors', '15ade029f4dabd502bc97af6051c8b9f2bec24d5', ''),
    }
    repo, file, revision, override = weights[model_id]
    if override and os.environ.get(override):
        return Path(os.environ[override]).is_file()
    try:
        hf_hub_download(repo, file, revision=revision, local_files_only=True)
        return True
    except OSError:
        return False


def probe(model_id, device):
    import numpy as np
    import torch
    from PIL import Image
    torch.set_num_threads(4)
    torch.manual_seed(17)
    torch.set_grad_enabled(False)
    full = Image.open(ROOT / 'fixtures/test-pages/004.jpg').convert('RGB')
    crop = full.crop((451, 410, 963, 922))
    review = Path(os.environ.get('SCAN_REVIEW_MODELS_DIR', ROOT / 'data/models/review'))
    translation = Path(os.environ.get('SCAN_TRANSLATION_MODELS_DIR', ROOT / 'data/models/translation'))
    arrays, details = {}, {}
    if model_id in ('lama-manga', 'big-lama', 'aot'):
        import workflow
        for index, size in enumerate([(320, 256), (512, 512)]):
            image = np.array(crop.resize(size))[:, :, ::-1].copy()
            mask = np.zeros(image.shape[:2], np.uint8)
            mask[80:180, 90:200] = 255
            method = 'lama' if model_id == 'lama-manga' else model_id
            value, used = workflow.clean(image, mask, {'method': method, 'device': device})
            if not np.array_equal(value[mask == 0], image[mask == 0]):
                raise AssertionError('Cleaner changed pixels outside approved mask')
            arrays[f'clean-{index}'] = value[mask > 0]
            details[f'method-{index}'] = used
    elif model_id == 'sam':
        import workflow
        details = workflow.geometry(np.array(full)[:, :, ::-1].copy(), {
            'method': 'sam', 'device': device, 'box': [.34, .20, .18, .12], 'kind': 'bubble'})
    elif model_id == 'koharu':
        import koharu_mask
        arrays['mask'] = koharu_mask.predict(np.array(full)[:, :, ::-1].copy(), device)
    elif model_id in ('rtdetr', 'ctd'):
        import detect
        details['regions'] = detect.detect(np.array(full)[:, :, ::-1].copy(), backend=model_id,
                                           device=device, supplement=False)
    elif model_id == 'coo':
        import coo
        image = np.array(full)[:, :, ::-1].copy()
        details['regions'] = coo.detect(image, device=device)
        inner = coo._models[(str(coo.model_path()), device)]
        arrays['probability'] = inner(torch.from_numpy(coo.prepare(image)))[0, 0].cpu().numpy()
    elif model_id == 'hayai-ocr-v2':
        from transformers import AutoModel, AutoProcessor, PreTrainedTokenizerFast
        folder = review / model_id
        model = AutoModel.from_pretrained(folder, local_files_only=True, trust_remote_code=True).to(device).eval()
        processor = AutoProcessor.from_pretrained('google/siglip2-base-patch16-naflex', local_files_only=True)
        tokenizer = PreTrainedTokenizerFast.from_pretrained(folder, local_files_only=True)
        inputs = {k: v.to(device) for k, v in processor(images=[crop], max_num_patches=512, return_tensors='pt').items()}
        details['text'] = model.generate(**inputs, tokenizer=tokenizer, max_new_tokens=512, num_beams=1)[0].strip()
    elif model_id == 'manga-ocr':
        from transformers import AutoImageProcessor, AutoTokenizer, VisionEncoderDecoderModel
        from manga_ocr_review import post_process
        folder = review / model_id
        model = VisionEncoderDecoderModel.from_pretrained(folder, local_files_only=True).to(device).eval()
        processor = AutoImageProcessor.from_pretrained(folder, local_files_only=True)
        tokenizer = AutoTokenizer.from_pretrained(folder, local_files_only=True)
        pixels = processor(crop.convert('L').convert('RGB'), return_tensors='pt').pixel_values.to(device)
        ids = model.generate(pixels, max_length=300)[0].cpu()
        details['text'] = post_process(tokenizer.decode(ids, skip_special_tokens=True))
    elif model_id == 'opus-mt-ja-en':
        from transformers import MarianMTModel, MarianTokenizer
        folder = translation / model_id
        override = os.environ.get('SCAN_TRANSLATION_OPUS_JAEN_CKPT')
        if override:
            from transformers import MarianConfig
            model = MarianMTModel(MarianConfig.from_pretrained(folder, local_files_only=True))
            model.load_state_dict(torch.load(override, map_location='cpu', weights_only=True), strict=False)
            model.tie_weights()
        else:
            model = MarianMTModel.from_pretrained(folder, local_files_only=True)
        model = model.to(device).eval()
        tokenizer = MarianTokenizer.from_pretrained(folder, local_files_only=True)
        inputs = {k: v.to(device) for k, v in tokenizer('こんにちは。ありがとうございます。', return_tensors='pt', truncation=True, max_length=512).items()}
        ids = model.generate(**inputs, max_new_tokens=256, num_beams=1)[0]
        details['text'] = tokenizer.decode(ids, skip_special_tokens=True).strip()
    else:
        from ko_en.minrnn import MinRNNConfig, MinRNNSeq2Seq
        from ko_en.model import ModelConfig, Seq2SeqTransformer
        from ko_en.tokenizer import load_tokenizer
        from ko_en.translate_runtime import beam_translate, greedy_translate
        from ko_en_translate import translate_korean
        folder = translation / model_id
        state = torch.load(os.environ.get('SCAN_TRANSLATION_KOEN_CKPT') or folder / 'sentence-base/best.pt', map_location=device, weights_only=False)
        model = MinRNNSeq2Seq(MinRNNConfig(**state['config'])) if state.get('arch') == 'minrnn' else Seq2SeqTransformer(ModelConfig(**state['config']))
        model.load_state_dict(state['model'])
        model = model.to(device).eval()
        tokenizer = load_tokenizer(folder / 'tokenizer.json')
        details['text'] = translate_korean(model, tokenizer, device, '안녕하세요. 감사합니다.', greedy_translate, beam_translate, max_new=128)
    if device.startswith('cuda'):
        torch.cuda.synchronize(device)
    return arrays, details


def compare(directory, reference, model_id):
    import numpy as np
    actual = json.loads((directory / 'result.json').read_text())
    expected = json.loads((reference / 'result.json').read_text())
    if actual['details'] != expected['details']:
        # Geometric coordinates/confidences tolerate small floating point drift,
        # whereas generated text and cleaner selection must match exactly.
        def equivalent(a, b):
            if isinstance(a, dict) and isinstance(b, dict):
                return a.keys() == b.keys() and all(equivalent(a[k], b[k]) for k in a)
            if isinstance(a, list) and isinstance(b, list):
                return len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
            if isinstance(a, (float, int)) and isinstance(b, (float, int)):
                return abs(a - b) <= 1e-3 + abs(b) * 1e-3
            return a == b
        if not equivalent(actual['details'], expected['details']):
            raise AssertionError('Generated text or geometry differs from the active runtime')
    a, b = np.load(directory / 'arrays.npz'), np.load(reference / 'arrays.npz')
    if set(a.files) != set(b.files):
        raise AssertionError('Output names differ')
    errors = {}
    for key in a.files:
        x, y = a[key], b[key]
        if x.shape != y.shape:
            raise AssertionError('Output dimensions differ')
        if not np.isfinite(x).all() or not np.isfinite(y).all():
            raise AssertionError('Non-finite model output')
        delta = np.abs(x.astype(float) - y.astype(float))
        if key == 'probability':
            if not np.allclose(x, y, atol=1e-4, rtol=1e-3):
                raise AssertionError('COO probability map differs')
        elif key == 'mask':
            intersection = np.logical_and(x > 0, y > 0).sum()
            union = np.logical_or(x > 0, y > 0).sum()
            if union and intersection / union < .99:
                raise AssertionError('Mask IoU below .99')
        elif delta.max(initial=0) > 8 or delta.mean() > 1:
            raise AssertionError('Cleaning masked error exceeds mean1/max8 byte values')
        errors[key] = {'meanAbsError': float(delta.mean()) if delta.size else 0, 'maxAbsError': float(delta.max(initial=0))}
    return {'passed': True, 'errors': errors, 'detailsMatched': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env', choices=MODELS, required=True)
    parser.add_argument('--model', choices=sum(MODELS.values(), []))
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--python', default=sys.executable)
    parser.add_argument('--available-only', action='store_true', help='Only validate already downloaded models')
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', SAM2_BUILD_CUDA='0')
    if args.model:
        if args.model in ('hayai-ocr-v2', 'manga-ocr'):
            base = Path(os.environ.get('SCAN_REVIEW_MODELS_DIR', ROOT / 'data/models/review'))
            os.environ['HF_HOME'] = str(base / 'hf-cache')
        import numpy as np
        import torch
        start = time.perf_counter()
        with contextlib.redirect_stdout(sys.stderr):
            arrays, details = probe(args.model, args.device)
        first = time.perf_counter() - start
        np.savez(args.out / 'arrays.npz', **arrays)
        result = {'model': args.model, 'device': args.device, 'torch': torch.__version__, 'firstResultSeconds': first,
                  'details': details, 'fixtureSHA256': hashlib.sha256((ROOT / 'fixtures/test-pages/004.jpg').read_bytes()).hexdigest()}
        (args.out / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
        if args.reference:
            result['comparison'] = compare(args.out, args.reference, args.model)
            (args.out / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n')
        print(json.dumps(result, ensure_ascii=False))
        return
    rows = []
    for model in MODELS[args.env]:
        if args.available_only and not available(model):
            rows.append({'model': model, 'skipped': True, 'reason': 'Weights are not installed'})
            continue
        folder = args.out / model
        folder.mkdir(exist_ok=True)
        cmd = [args.python, str(Path(__file__).resolve()), '--env', args.env, '--model', model, '--device', args.device, '--out', str(folder)]
        if args.reference:
            cmd += ['--reference', str(args.reference / model)]
        print('Validating', model, flush=True)
        with (folder / 'process.log').open('w') as log:
            try:
                p = subprocess.run(cmd, stdout=log, stderr=log, timeout=300, check=False)
                rows.append({'model': model, 'passed': p.returncode == 0, 'returncode': p.returncode})
            except subprocess.TimeoutExpired:
                rows.append({'model': model, 'passed': False, 'timedOut': True})
    report = {'passed': all(r.get('passed', r.get('skipped', False)) for r in rows), 'models': rows, 'comparison': bool(args.reference)}
    (args.out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    if not report['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
