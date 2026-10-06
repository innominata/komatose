"""Tensor-only adapters for a feasibility experiment, never production imports.

The installed application's checkpoint loaders and preprocessing remain the source
of truth. Dependencies are imported lazily so inventory/reporting need no torch.
"""
from dataclasses import dataclass
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ocr'))
MODEL_IDS = ('lama-manga', 'big-lama', 'aot', 'sam', 'koharu', 'rtdetr',
             'ctd', 'coo', 'hayai-ocr-v2', 'manga-ocr', 'opus-mt-ja-en',
             'imsbee-ko-en-translator')
GENERATIVE = {'hayai-ocr-v2', 'manga-ocr', 'opus-mt-ja-en', 'imsbee-ko-en-translator'}
HF_WEIGHTS = {
    'lama-manga': ('mayocream/lama-manga', 'f91c85b26913b3e83f9877867b4c336da3675238', 'lama-manga.safetensors', 'SCAN_LAMA_CHECKPOINT'),
    'big-lama': ('dreMaz/AnimeMangaInpainting', '2953a4e935bf01ad1471f6cbfd26ab81abeeb92d', 'lama_large_512px.ckpt', 'SCAN_BIG_LAMA_CHECKPOINT'),
    'aot': ('ogkalu/aot-inpainting', '42ffc84ff1bd46dd95f1c5a41e83ee7e98f39189', 'aot_traced.pt', ''),
    'rtdetr': ('ogkalu/comic-text-and-bubble-detector', '16e8a622f91fabc6b5b65c96d32d1183f8843546', 'model.safetensors', ''),
    'ctd': ('mayocream/comic-text-detector', '15ade029f4dabd502bc97af6051c8b9f2bec24d5', 'yolo-v5.safetensors', ''),
    'sam': ('facebook/sam2.1-hiera-small', None, 'sam2.1_hiera_small.pt', 'SCAN_SAM_CHECKPOINT'),
}


def weight_path(model_id):
    from huggingface_hub import hf_hub_download
    repo, revision, filename, override = HF_WEIGHTS[model_id]
    if override and os.environ.get(override):
        return Path(os.environ[override])
    return Path(hf_hub_download(repo, filename, revision=revision, local_files_only=True))


def model_directory(model_id):
    if model_id in ('hayai-ocr-v2', 'manga-ocr'):
        base = Path(os.environ.get('SCAN_REVIEW_MODELS_DIR', ROOT / 'data/models/review'))
    else:
        base = Path(os.environ.get('SCAN_TRANSLATION_MODELS_DIR', ROOT / 'data/models/translation'))
    return base / model_id


def page(size=None):
    import cv2
    image = cv2.imread(str(ROOT / 'fixtures/test-pages/004.jpg'))
    if image is None:
        raise RuntimeError('Licensed fixture 004.jpg is missing')
    if size:
        h, w = size
        # Fixed licensed crop; no private working material is used.
        image = image[410:922, 451:963]
        image = cv2.resize(image, (w, h), interpolation=cv2.INTER_AREA)
    return image


@dataclass
class Stage:
    name: str
    module: object
    inputs: tuple
    input_names: tuple
    dynamic_shapes: object = None
    contract: str = ''


def stages(model_id, device='cpu'):
    import torch
    import numpy as np
    from torch import nn
    from PIL import Image

    def wrap(module, fn):
        class Adapter(nn.Module):
            def __init__(self):
                super().__init__()
                self.inner = module
                self._feasibility_varargs = True
            def forward(self, *args):
                return fn(self.inner, *args)
        return Adapter().eval().to(device)

    def tensor(value):
        return torch.as_tensor(np.ascontiguousarray(value)).to(device)

    if model_id in ('lama-manga', 'big-lama', 'aot'):
        x = tensor(page((512, 512))[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255)
        m = torch.zeros((1, 1, 512, 512), device=device)
        m[:, :, 180:330, 200:310] = 1
        if model_id == 'lama-manga':
            import worker
            descriptor = worker._get_lama(device)
            model = descriptor.model
        elif model_id == 'big-lama':
            from spandrel import ModelLoader
            state = torch.load(weight_path(model_id), map_location='cpu', weights_only=True)
            state = state.get('gen_state_dict', state.get('state_dict', state))
            state = {('generator.' + k if k.startswith('model.') else k): v for k, v in state.items()}
            model = ModelLoader().load_from_state_dict(state).model.to(device).eval()
        else:
            model = torch.jit.load(str(weight_path(model_id)), map_location=device).eval()
            # torch.export cannot export ScriptModule. Attempt its documented
            # conversion in export.py rather than quietly substituting weights.
            x = (x * 2 - 1) * (1 - m)
        h = 8 * torch.export.Dim('height_units', min=1, max=128)
        w = 8 * torch.export.Dim('width_units', min=1, max=128)
        yield Stage('forward', model, (x, m), ('image', 'mask'),
                    ({2: h, 3: w}, {2: h, 3: w}),
                    'RGB float32 0..1, 1=hole; AOT uses masked RGB -1..1. Current stride-8 padding and compositing remain outside graph.')
        return

    if model_id == 'rtdetr':
        from native_detect import RtdetrSession
        session = RtdetrSession(device)
        pixels = session.processor(images=Image.fromarray(page()[:, :, ::-1]), return_tensors='pt').pixel_values.to(device)
        def rtdetr_forward(model, x):
            output = model(pixel_values=x)
            return output.logits, output.pred_boxes
        yield Stage('forward', wrap(session.model, rtdetr_forward),
                    (pixels,), ('image',), contract='HF processor; logits and normalized boxes. HF label/box postprocessing requires a torch-free equivalent.')
        return

    if model_id == 'ctd':
        from native_detect import CtdSession
        session = CtdSession(device)
        class CTD(nn.Module):
            def __init__(self):
                super().__init__()
                self.backbone, self.seg, self.lines = session.models
            def forward(self, x):
                blocks, features = self.backbone(x, detect=True)
                mask, features = self.seg(*features, forward_mode=2)
                return blocks[0], mask, self.lines(*features, step_eval=False)
        image = tensor(page((1024, 1024))[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255)
        yield Stage('forward', CTD().eval(), (image,), ('image',), contract='Combined pinned YOLO, Unet and DBHead; application letterbox/NMS/geometry still required.')
        return

    if model_id == 'coo':
        from coo import model_path, prepare
        from coo_model import COOModel
        inner = COOModel(model_path(), device)
        class COO(nn.Module):
            def __init__(self):
                super().__init__()
                for index, (key, value) in enumerate(inner.s.items()):
                    self.register_buffer(f'weight_{index}', value)
                    inner.s[key] = getattr(self, f'weight_{index}')
            def forward(self, x):
                return inner(x)
        x = tensor(prepare(page()))
        yield Stage('forward', COO().eval(), (x,), ('image',), contract='BGR mean-subtracted /255, proportional short-side736/max1536/stride32; OpenCV/pyclipper contours outside graph.')
        return

    if model_id == 'koharu':
        import koharu_mask
        model, publisher, _ = koharu_mask._load(device)
        x, _ = publisher.prepare(Image.fromarray(page()[:, :, ::-1]))
        x = x.to(device)
        yield Stage('forward', wrap(model, lambda m, x: m([{'image': x, 'original_size': (1024, 1024)}], multimask_output=False)[4]),
                    (x,), ('image',), contract='Publisher Hi-SAM preprocessing and output[4]. FP32 reference; production GPU autocast BF16 must be compared separately.')
        return

    if model_id == 'sam':
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        model = build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', str(weight_path(model_id)), device=device, apply_postprocessing=False)
        predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
        with torch.inference_mode():
            predictor.set_image(page()[:, :, ::-1].copy())
        x = predictor._transforms(Image.fromarray(page()[:, :, ::-1])).unsqueeze(0).to(device)
        yield Stage('image_encoder', wrap(model, lambda m, x: m.forward_image(x)['backbone_fpn']),
                    (x,), ('image',), contract='SAM2 image features; no video/memory tracking.')
        coords = torch.tensor([[[512., 512.], [100., 100.], [900., 900.]]], device=device)
        labels = torch.tensor([[1, 2, 3]], dtype=torch.int32, device=device)
        prompt = wrap(model.sam_prompt_encoder, lambda m, p, l: m(points=(p, l), boxes=None, masks=None))
        yield Stage('prompt_encoder', prompt, (coords, labels), ('points', 'labels'),
                    ({1: torch.export.Dim('point_count', min=1, max=32)}, {1: torch.export.Dim('point_count', min=1, max=32)}),
                    'Source coordinates transformed to 1024; box corners labelled2,3 as predictor does.')
        with torch.no_grad():
            sparse, dense = prompt(coords, labels)
        embedding = predictor._features['image_embed'].clone()
        high = [feature.clone() for feature in predictor._features['high_res_feats']]
        pe = model.sam_prompt_encoder.get_dense_pe().to(device)
        decoder = wrap(model.sam_mask_decoder, lambda m, e, pe, s, d, h0, h1: m(image_embeddings=e, image_pe=pe, sparse_prompt_embeddings=s,
                       dense_prompt_embeddings=d, multimask_output=True, repeat_image=False, high_res_features=[h0, h1])[:2])
        decoder_inputs = tuple(v.detach().clone(memory_format=torch.contiguous_format) for v in (embedding, pe, sparse, dense, *high))
        yield Stage('mask_decoder', decoder, decoder_inputs,
                    ('embedding', 'position', 'sparse', 'dense', 'high0', 'high1'), contract='Masks and IoU scores; predictor resizing, best-mask choice, and geometry outside graph.')
        return

    if model_id in ('manga-ocr', 'opus-mt-ja-en'):
        from transformers import AutoImageProcessor, AutoTokenizer, VisionEncoderDecoderModel, MarianMTModel, MarianTokenizer
        directory = model_directory(model_id)
        if model_id == 'manga-ocr':
            model = VisionEncoderDecoderModel.from_pretrained(directory, local_files_only=True).to(device).eval()
            processor = AutoImageProcessor.from_pretrained(directory, local_files_only=True)
            image = Image.fromarray(page((192, 384))[:, :, ::-1]).convert('L').convert('RGB')
            pixels = processor(image, return_tensors='pt').pixel_values.to(device)
            encoder = wrap(model.encoder, lambda m, x: m(pixel_values=x, return_dict=False)[0])
            yield Stage('encoder', encoder, (pixels,), ('image',), contract='Grayscale->RGB then installed HF image processor.')
            with torch.no_grad():
                memory = encoder(pixels)
            if getattr(model, 'enc_to_dec_proj', None) is not None:
                memory = model.enc_to_dec_proj(memory)
                encoder = wrap(model, lambda m, x: m.enc_to_dec_proj(m.encoder(pixel_values=x, return_dict=False)[0]))
                # Replace the prior stage if projected dimensions are required.
                yield Stage('projected_encoder', encoder, (pixels,), ('image',))
            bos = model.config.decoder_start_token_id
            decoder = wrap(model.decoder, lambda m, ids, memory: m(input_ids=ids, encoder_hidden_states=memory, use_cache=False, return_dict=False)[0][:, -1, :])
            inputs = (torch.tensor([[bos]], device=device), memory)
            yield Stage('decoder', decoder, inputs, ('tokens', 'memory'),
                        ({1: torch.export.Dim('tokens', min=1, max=300)}, {}),
                        'Full-prefix logits for greedy decoding; generation/tokenizer/postprocess validation required.')
        else:
            model = MarianMTModel.from_pretrained(directory, local_files_only=True).to(device).eval()
            tokenizer = MarianTokenizer.from_pretrained(directory, local_files_only=True)
            source = tokenizer('こんにちは。ありがとうございます。', return_tensors='pt')
            ids, mask = source.input_ids.to(device), source.attention_mask.to(device)
            encoder = wrap(model.model.encoder, lambda m, ids, mask: m(input_ids=ids, attention_mask=mask, return_dict=False)[0])
            source_dim = torch.export.Dim('source_tokens', min=1, max=512)
            yield Stage('encoder', encoder, (ids, mask), ('tokens', 'attention_mask'), ({1: source_dim}, {1: source_dim}))
            with torch.no_grad():
                memory = encoder(ids, mask)
            decoder = wrap(model, lambda m, ids, memory, mask: m.lm_head(m.model.decoder(input_ids=ids, encoder_hidden_states=memory,
                           encoder_attention_mask=mask, use_cache=False, return_dict=False)[0][:, -1, :]) + m.final_logits_bias)
            yield Stage('decoder', decoder, (torch.tensor([[model.config.decoder_start_token_id]], device=device), memory, mask),
                        ('tokens', 'memory', 'attention_mask'), ({1: torch.export.Dim('decoder_tokens', min=1, max=256)}, {1: source_dim}, {1: source_dim}),
                        'Greedy full-prefix decoder; installed Marian tokenizer, EOS and max_new_tokens256.')
        return

    if model_id == 'imsbee-ko-en-translator':
        from ko_en.minrnn import MinRNNConfig, MinRNNSeq2Seq
        from ko_en.model import ModelConfig, Seq2SeqTransformer
        from ko_en.tokenizer import load_tokenizer, encode, tag_id, BOS_ID
        directory = model_directory(model_id)
        checkpoint = torch.load(directory / 'sentence-base/best.pt', map_location='cpu', weights_only=False)
        model = (MinRNNSeq2Seq(MinRNNConfig(**checkpoint['config'])) if checkpoint.get('arch') == 'minrnn'
                 else Seq2SeqTransformer(ModelConfig(**checkpoint['config'])))
        model.load_state_dict(checkpoint['model'])
        model = model.to(device).eval()
        tokenizer = load_tokenizer(directory / 'tokenizer.json')
        ids = torch.tensor([[tag_id('en'), *encode(tokenizer, '안녕하세요.', add_eos=True)]], device=device)
        encoder = wrap(model, lambda m, ids: m.encode(ids))
        seq = torch.export.Dim('source_tokens', min=1, max=128)
        yield Stage('encoder', encoder, (ids,), ('tokens',), ({1: seq},), 'Existing minRNN or Transformer architecture and installed tokenizer.')
        with torch.no_grad():
            memory = encoder(ids)
        decoder = wrap(model, lambda m, tokens, memory, source: m.lm_head(m.decode(tokens, memory, source))[:, -1, :])
        yield Stage('decoder', decoder, (torch.tensor([[BOS_ID]], device=device), memory, ids), ('tokens', 'memory', 'source'),
                    ({1: torch.export.Dim('decoder_tokens', min=1, max=128)}, {1: seq}, {1: seq}),
                    'Full-prefix logits; production sentence/chunk routing and beam5 length_penalty0.8 still required.')
        return

    if model_id == 'hayai-ocr-v2':
        from transformers import AutoModel, AutoProcessor, PreTrainedTokenizerFast
        directory = model_directory(model_id)
        model = AutoModel.from_pretrained(directory, trust_remote_code=True, local_files_only=True).to(device).eval()
        tokenizer = PreTrainedTokenizerFast.from_pretrained(directory, local_files_only=True)
        processor = AutoProcessor.from_pretrained('google/siglip2-base-patch16-naflex', local_files_only=True)
        values = processor(images=[Image.fromarray(page((192, 384))[:, :, ::-1])], max_num_patches=512, return_tensors='pt')
        inputs = tuple(values[key].to(device) for key in ('pixel_values', 'pixel_attention_mask', 'spatial_shapes'))
        encoder = wrap(model.vision_encoder, lambda m, x, mask, shapes: m(pixel_values=x, pixel_attention_mask=mask, spatial_shapes=shapes).last_hidden_state)
        yield Stage('encoder', encoder, inputs, ('patches', 'attention_mask', 'spatial_shapes'), contract='Installed Siglip2 naflex processor, max512 patches.')
        with torch.no_grad():
            memory = encoder(*inputs)
        bos = tokenizer.bos_token_id
        decoder = wrap(model.decoder, lambda m, memory, shapes, tokens: m(memory, shapes, tokens)[:, -1, :])
        yield Stage('decoder', decoder, (memory, inputs[2], torch.tensor([[bos]], device=device)), ('memory', 'spatial_shapes', 'tokens'),
                    contract='Publisher decoder uses data-dependent .item() and complex RoPE; full-prefix export is only a probe, KV-cache/repetition-penalty generation equivalence remains required.')
        return
    raise ValueError(model_id)
