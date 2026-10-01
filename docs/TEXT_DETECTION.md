# Text detection and removal

Three components: **RT-DETR** locates text and speech bubbles, **COO** proposes
free-floating sound effects, and **Koharu** produces the mask used to remove
lettering. Detection and masking are separate stages and use separate models.

## Requirements

```bash
python -m venv .venv && . .venv/bin/activate
pip install onnxruntime huggingface-hub numpy opencv-python-headless   # RT-DETR
pip install torch torchvision pyclipper                               # COO, Koharu
```

`pyclipper` is required for COO polygon expansion. Koharu additionally needs the
Hi-SAM source tree (see below).

## RT-DETR

### Weights

| | |
| --- | --- |
| Repository | `ogkalu/comic-text-and-bubble-detector` |
| Revision | `16e8a622f91fabc6b5b65c96d32d1183f8843546` |
| Files | `detector.onnx`, `config.json`, `preprocessor_config.json` |
| Classes | `0: bubble`, `1: text_bubble`, `2: text_free` |
| Input size | 640 × 640 |

`bubble` marks the container and is used for grouping and cleaning. The
recogniser targets are `text_bubble` and `text_free`.

Pass `revision=` to `huggingface_hub.hf_hub_download`; without it the resolved
graph is whatever is cached or current, which varies between machines.
`scripts/install-detect-models.py` prefetches these files at the pinned revision.

### Input

1. Convert BGR to RGB.
2. Resize to 640 × 640 with `cv2.resize`. No letterboxing and no padding.
3. Divide by 255 and convert to float32.
4. Transpose HWC to CHW and add a batch dimension.

Do not normalise with mean and standard deviation, and do not square-pad.

### Inference

| Input | Shape | Dtype |
| --- | --- | --- |
| `images` | `(1, 3, 640, 640)` | float32 |
| `orig_target_sizes` | `[[w, h]]` | int64 |

`orig_target_sizes` is the width and height of the crop being processed. The
model returns `labels`, `boxes`, `scores`, with boxes in crop coordinates.

```python
import cv2, numpy as np, onnxruntime as ort
from huggingface_hub import hf_hub_download

REPO = "ogkalu/comic-text-and-bubble-detector"
REVISION = "16e8a622f91fabc6b5b65c96d32d1183f8843546"
LABELS = {0: "bubble", 1: "text_bubble", 2: "text_free"}

sess = ort.InferenceSession(
    hf_hub_download(REPO, "detector.onnx", revision=REVISION),
    providers=["CPUExecutionProvider"],
)

def detect_crop(img, crop, conf=0.20):
    x0, y0, x1, y1 = crop
    c = img[y0:y1, x0:x1]
    th, tw = c.shape[:2]
    rgb = cv2.cvtColor(c, cv2.COLOR_BGR2RGB)
    inp = cv2.resize(rgb, (640, 640)).astype(np.float32) / 255.0
    inp = inp.transpose(2, 0, 1)[None]
    labels, boxes, scores = sess.run(
        None,
        {"images": inp, "orig_target_sizes": np.array([[tw, th]], np.int64)},
    )
    return [
        {"cls": LABELS[int(lb)], "score": float(sc),
         "box": [bx[0] + x0, bx[1] + y0, bx[2] + x0, bx[3] + y0]}
        for lb, bx, sc in zip(labels[0], boxes[0], scores[0])
        if sc >= conf
    ]
```

### Tiling

Long strips exceed any detector input height, so pages are processed in
overlapping crops and the results merged:

- Run the full page once as a context pass.
- Walk vertically in tiles of 690 px with 172 px of overlap (25%).
- Split each vertical band into square crops horizontally.
- Retain a full-width strip for each band alongside the square crops, so
  lettering with wide context is not clipped.
- Skip crops smaller than 64 px on either axis.

Default confidence is 0.20. Regions without readable text are discarded later by
the recogniser.

### Merging

Two results are the same region when they share a class, their intersection over
the smaller box exceeds 0.4, and their area ratio exceeds 0.55. Intersection over
the smaller box is used rather than IoU so that containment counts.

Boxes clipped by a tile boundary are marked `truncated` when a coordinate falls
within 6 px of a crop edge, and are merged as follows:

- Two truncated results from different crops merge when their intersection over
  the smaller box exceeds 0.25 and they overlap by more than 0.8 along either axis.
- A truncated result is absorbed by a complete result covering it when the
  intersection over the smaller box exceeds 0.85 and its area is smaller.

Overlap alone does not imply duplication. Side lettering often falls inside the
bounds of a larger text block, so retain a scale check alongside the overlap
check.

### CTD supplement

comic-text-detector (`mayocream/comic-text-detector-onnx`, revision
`a5d67ec772adef819ef5b0e7aa701fcf4c8bf74a`) runs alongside RT-DETR by default to
recover small stylised lettering, and adds results RT-DETR did not report. Its
confidence floor in this mode is `max(0.4, conf)`.

Preprocessing letterboxes to 1024 with padding value 114 and restores scale and
pad offsets afterwards. Scores are `objectness × max(class)`, boxes are `cxcywh`
converted to `xyxy`, and NMS uses IoU 0.35 over tiles of 1024 with 256 overlap.

A candidate is discarded when RT-DETR already covers it: intersection over the
smaller box above 0.65 with an area ratio above 0.3, or a smaller box inside a
`text_bubble` at above 0.9. Disable with `SCAN_DETECT_CTD_SUPPLEMENT=0`.

Note that RT-DETR resizes directly to its input size while CTD letterboxes. The
two paths intentionally differ.

## COO

COO is a DBNet++ fine-tune (`MhLiao/DB` at commit
`65ca77a0bcfbd7114b916cf8a1e9ca85114286ce`) that proposes free-floating sound
effects as polygons under the `text_free` class.

### Weights

| | |
| --- | --- |
| Source | `https://www.dropbox.com/s/zu47mriwv2i9npr/DB%2B%2B_finetune_COO?dl=1` |
| SHA256 | `889a26c041cc03be7c3864de940368dc393b46d036da49f9bf762a8b798724cf` |
| Default path | `data/models/coo/dbnetpp-coo.pt` |
| Version tag | `coo-dbnetpp-889a26c-v1` |

Verify the checksum at load. `scripts/install-coo.py` downloads and checks the
file.

### Inference

1. Read BGR.
2. Scale so the short side is 736 and the long side is at most 1536:
   `min(736 / min(h, w), 1536 / max(h, w))`, then round both dimensions **up** to
   a multiple of 32.
3. Subtract the mean `[122.67891434, 116.66876762, 104.00698793]`, divide by 255.
4. Transpose to CHW and produce a contiguous `(1, 3, H, W)` float32 tensor.

The mean is applied to BGR. The constant is named `RGB_MEAN` upstream.

Process the full page when `max(h, w) ≤ 1600`, otherwise use 1280 px crops with
320 px overlap.

Deformable convolution uses `torchvision.ops.deform_conv2d` rather than the
legacy DCNv2 extension. At stride-two stage entries the offset and mask must be
reshaped as the first `18·H·W` and `9·H·W` elements of a compact grid before use
(`legacy_offsets` in `ocr/coo_model.py`); the offset predictor is stride one but
the original kernel indexes it as a subsampled output grid. The checkpoint's
training-only threshold head is unused.

### Polygon extraction

1. Threshold the probability map at 0.3 and run `cv2.findContours` with
   `RETR_EXTERNAL` and `CHAIN_APPROX_SIMPLE`.
2. Keep the 1024 largest contours by area.
3. Approximate with `cv2.approxPolyDP(0.002 × arcLength)`, closed. Discard
   shapes with fewer than 3 points.
4. Score is the mean probability inside the filled polygon; discard below 0.6.
5. Expand with `pyclipper.PyclipperOffset(JT_ROUND, ET_CLOSEDPOLYGON)` at offset
   `2 × area / perimeter`.
6. Discard when the short side of `minAreaRect` is below 5 px.
7. Scale to source pixels and approximate again with `approxPolyDP(0.5)`.

Deduplicate by suppression only. Unioning results would leave stored polygon
geometry inconsistent with its bounding box. A result is dropped when its
intersection over the smaller box exceeds 0.65 and its area ratio exceeds 0.35.

DBNet probabilities describe shrunken text regions. They are not erasure masks
and must not be used directly to paint out lettering; use the mask stage below.

## Koharu

Koharu SAM-TS-L produces a full-page text-removal mask, in the publisher
preprocessing lineage. It is the masking stage; it is not the text detector.

### Weights and source

| | |
| --- | --- |
| Weights | `mayocream/koharu-text-sam-ts-l` at `5dd97423e0fbf2404264979136d47e8101144046` |
| Files | `model.safetensors`, `inference.py`, `config.json` |
| Weight size | 1,355,824,988 bytes |
| Weight SHA256 | `bcd9525291677f467f0603509a0ca3df35711b4e3417cefce8da6bfc97164f45` |
| Source | `ymy-k/Hi-SAM` at `69009434d4dba5541f228d8f5acb0754c333d417` |
| Default weight path | `data/models/koharu-text-sam-ts-l/model.safetensors` |
| Default source path | `data/models/hi-sam-<revision>` |

The Hi-SAM source can be fetched as the codeload zip at that commit; no git
checkout is required. The tree must contain `hi_sam/modeling/build.py`.
`scripts/install-koharu.py` installs and verifies both parts.

### Loading

1. Call `install_checkpoint_compatibility()` from the downloaded `inference.py`.
2. Add the Hi-SAM root to `sys.path` and build with
   `model_registry['vit_l'](attn_layers=1, prompt_len=12, hier_det=False)`.
3. Load `model.safetensors` with `load_state_dict(..., strict=True)` and call
   `eval()`.

### Inference

Convert BGR to RGB and to PIL, then run the model's `prepare` on it. Set
`IMAGE_SIZE = 1024`. On CUDA use `torch.autocast(bfloat16)`.

The mask is `outputs[4][0, 0, :nh, :nw]`. Resize it back to the source
dimensions with `NEAREST`; other interpolations soften the boundary and make it
unsuitable for thresholding.

### Mask post-processing

- Clip the mask to the region polygon so adjacent bubbles are left untouched.
- Optionally expand with an elliptical structuring element. The radius is
  clamped to 0–20 px; the application uses 3.
- Merge glyph boxes into lines using a gap fraction of 0.6 and an alignment
  threshold of 0.4. Sound effects must not set the gap threshold; measure
  against the merged line height.
- Strength thresholds are 150 (strong) and 65 (weak).

## Optional: Koharu region supplementation

Koharu can also contribute text region boxes to the detection stage when the
detector setup includes `+koharu` (see Configuration). Its boxes supplement
those from the base detector. Before an admin saves a setup, the fallback reads
`SCAN_KOHARU_DETECT`: `auto` follows `SCAN_MASK_ENGINE`, `1` requires the
weights, `0` disables it.

## Configuration

Chapter transcription runs a **detector setup**, written `base[+coo][+koharu]`
(for example `ctd+koharu`). The base is `ctd`, `rtdetr`, `paddle` or
`heuristic`. COO and Koharu can be added to any base except `heuristic`. These
are the same ids the benchmark scores. The setup is chosen in this order:

1. An explicit `detectorSetup` in the transcribe request.
2. The chapter's own choice in Chapter settings (`detectorSetup`). Chapters
   saved before setups existed keep their old `detector`, which gets COO
   (RT-DETR only) and Koharu under the old automatic rules.
3. The admin default in **Admin → Models → Jobs & defaults**, stored in
   `data/detector-config.json` as `{ "version": 1, "setup", "conf" }`.
4. If no admin default has been saved: `SCAN_DETECTOR`, plus COO and Koharu per
   `SCAN_COO` and `SCAN_KOHARU_DETECT`, with confidence `SCAN_DETECT_CONF`.

Confidence follows the same order, and a chapter can leave it blank to use the
default. If a setup asks for an add-on that is not installed, the add-on is
dropped and the job log says so.

Read by the Python layer:

| Variable | Default | Effect |
| --- | --- | --- |
| `SCAN_DETECTOR` | `rtdetr` | `rtdetr`, `ctd`, or `paddle`; legacy fallback only |
| `SCAN_DETECT_DEVICE` | `auto` | `auto` prefers ROCm, MIGraphX or CUDA; `cpu` forces CPU |
| `SCAN_DETECT_THREADS` | `0` | `0` lets onnxruntime choose |
| `SCAN_DETECT_CTD_SUPPLEMENT` | `1` | `0` disables the CTD supplement |
| `SCAN_RTDETR_FILE` | `detector.onnx` | alternate ONNX filename |
| `SCAN_COO` | `auto` | `auto` or `1` enables, `0` disables |
| `SCAN_COO_THREADS` | `4` | torch intra-op threads |
| `SCAN_COO_MODEL` | `data/models/coo/dbnetpp-coo.pt` | checkpoint path |
| `SCAN_MASK_ENGINE` | `auto` | `auto`, `koharu`, or `ctd` |
| `SCAN_KOHARU_DIR` | `data/models/koharu-text-sam-ts-l` | weights directory |
| `SCAN_KOHARU_WEIGHTS` | `<dir>/model.safetensors` | weight file override |
| `SCAN_KOHARU_HISAM_ROOT` | `data/models/hi-sam-<revision>` | Hi-SAM source override |

Read by the host application and passed as per-request arguments:

| Variable | Default | Effect |
| --- | --- | --- |
| `SCAN_DETECT_CONF` | `0.20` | detector confidence; legacy fallback only |
| `SCAN_DETECT_TILE` | `690` | detector tile height |
| `SCAN_COO_CONF` | `0.60` | COO polygon confidence |
| `SCAN_KOHARU_DETECT` | `auto` | Koharu region supplementation |

## Installers

```bash
python scripts/install-detect-models.py            # RT-DETR and CTD
python scripts/install-detect-models.py --model rtdetr
python scripts/install-coo.py                      # COO weights, verifies SHA256
python scripts/install-koharu.py [--gpu]           # Koharu weights + Hi-SAM source
```

## Reference implementations

| File | Contents |
| --- | --- |
| `ocr/detect.py` | RT-DETR, CTD and Paddle backends, tiling and merging |
| `ocr/coo.py` | COO preprocessing and polygon extraction |
| `ocr/coo_model.py` | DBNet++ inference |
| `ocr/lettering.py` | mask engine selection and mask post-processing |
| `ocr/koharu_mask.py` | Koharu loading and inference |
| `src/lib/server/detect.ts` | stage orchestration |
