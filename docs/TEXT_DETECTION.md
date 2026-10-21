# Text detection and removal

Three components: **RT-DETR** locates text and speech bubbles, **COO** proposes
free-floating sound effects, and **Koharu** produces the mask used to remove
lettering. Detection and masking are separate stages and use separate models.
Chapter transcription cross-checks several detectors (see Cross-check fusion).

## Requirements

```bash
python -m venv .venv && . .venv/bin/activate
pip install onnxruntime huggingface-hub numpy opencv-python-headless   # CPU fallback
pip install torch torchvision --index-url https://download.pytorch.org/whl/rocm7.1
SAM2_BUILD_CUDA=0 pip install -r ocr/requirements-workflow.txt
```

`pyclipper` is required for COO polygon expansion. Koharu additionally needs the
Hi-SAM source tree (see below).

The app runs RT-DETR and CTD on GPU through native eager PyTorch in the workflow
worker. ONNX is exclusively a CPU fallback. The example below documents that
fallback's tensor interface; the native adapter preserves the same crop geometry.
`scripts/install-detect-models.py` installs both native weights and CPU fallback.

## RT-DETR

### Weights

| | |
| --- | --- |
| Repository | `ogkalu/comic-text-and-bubble-detector` |
| Revision | `16e8a622f91fabc6b5b65c96d32d1183f8843546` |
| Files | `model.safetensors` (native), `detector.onnx` (CPU fallback), `config.json`, `preprocessor_config.json` |
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

Koharu SAM-TS-L produces a full-page lettering mask, in the publisher
preprocessing lineage. It is the masking stage, and during transcription its
blocks also find lettering the box detectors missed (see Cross-check fusion).

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

### Reading resolution

The model reads the whole page shrunk to 1024 on its long side. Reading large
pages in full-resolution 1024 tiles was measured and rejected: on the bundled
gold pages (1414 × 2000 and 941 × 1672) it lowered RT-DETR + Koharu F1 from
0.869 to 0.847 (Japanese) and 0.958 to 0.946 (Korean), at four times the cost.

### Mask post-processing

Each region's mask is fitted by where its text sits (`ocr/mask_fit.py`). The
place comes from the Director's reading of the enclosure, then the detector's
class, then the bubble line types (`maskPlacement`):

- **Inside a balloon or box**, each glyph cluster grows past its anti-aliasing
  until it would cross a strong edge (the balloon's outline) or the paper beside
  it stops being one tone, up to 4 px at a 1024 scale. Ink the model missed
  within reach (dakuten, furigana, thin tips) is added while the paper is flat.
- **Outside**, the lettering grows by half its own stroke width, up to 8 px at a
  1024 scale, so the outline drawn around a sound effect is removed too and an
  inpainter does not paint the letters back in the outline's colour.
- **Unknown** places keep the plain dilation, but a glyph that pokes slightly out of the region box is kept whole within the same reach, so a tight detected box does not cut strokes off (Koharu engine).
- A fitted glyph that pokes slightly out of its region box is kept whole rather
  than cut at the box edge.
- The radius is clamped to 0–20 px; the application uses 3 for OCR crops and 5
  for removal masks, as the floor of fitted growth.

Paper counts as one tone when 90% of it sits within a tolerance of its median:
2.5 × the page's noise floor, between 6 and 20 levels. Automatic cleaning uses
the same test on the ring around each hole: flat paper of any colour gets a fill
in its own tone, and only the rest goes to LaMa. This follows Manga Cleaner
(github.com/k-omiq/Bear), used with its author's permission.
- Merge glyph boxes into lines using a gap fraction of 0.6 and an alignment
  threshold of 0.4. Sound effects must not set the gap threshold; measure
  against the merged line height.
- Strength thresholds are 150 (strong) and 65 (weak).

## Cross-check fusion

No single detector is both sensitive and precise on comics, so chapter
transcription runs several and lets them vote (`src/lib/server/detectFusion.ts`).
The pipeline in `detectRegions` is:

1. The setup's base detector runs.
2. Its **cross-check partner** runs too (`rtdetr` is checked by `ctd` and `ctd`
   by `rtdetr`), when installed. The partner gets `supplement=false` so RT-DETR
   does not run CTD a second time internally.
3. COO adds free-floating sound-effect polygons when the setup has `+coo`.
4. Koharu's text mask supplies blocks when the setup has `+koharu`. Each block
   records how much of its box the mask fills and its median stroke width.
5. `fuseDetections` merges everything. Seeds are taken in the order COO,
   RT-DETR, CTD, Paddle, Koharu. A candidate joins a seed when the boxes share a
   class and overlap (IoU 0.4, or 0.6 across classes), when it is a fragment of
   the seed (80% inside it, one column of a bubble), or when it is the same
   lettering with a looser margin. Each region records the detectors that
   found it in `provenance.sources`.
   Sure RT-DETR `bubble` boxes (0.5 and up) are **walls**: two boxes whose
   centres sit in different balloons are never merged, however they overlap.
6. A box found by only one detector survives only above its own threshold
   (RT-DETR bubble 0.5, RT-DETR free 0.6, CTD 0.6). A Paddle or Koharu block
   that swallows two or more other regions is a line-grouping artefact and is
   dropped.
7. **Pixel-first pass** (`adoptLettering`). The mask decides what is lettering
   and the boxes label it:
   - A block a box holds half of, but not all, means the box cut the lettering
     short; the box grows to hold it, to at most twice its area.
   - A block no box claimed is still lettering and becomes a region: bubble text
     when a sure balloon holds its centre, free text otherwise. Blocks within
     half a glyph of each other (at most 96 px), in the same balloon or both in
     none, are one region, so an effect the boxes cut in pieces is one region.
   - A block the mask fills more than 60%, or whose strokes are 40% of its short
     side, is a shape (a highlight, a white bar), not lettering, and is skipped.
   - Such a region scores 0.5 and must be 1.5 times the size floor.
   - **Confirm, then keep.** Recognisers invent characters from artwork, mostly
     Han, digits or the other language's script, so transcription keeps a
     mask-only region only when a reading holds the page language's own script
     (kana for Japanese, Hangul for Korean), or Latin when English is being
     transcribed (`readsAsLettering`).
8. The minimum region size scales with the page (1.2% of the short side, between
   10 px and 30 px), so one-character lettering on a low-resolution scan is
   kept and speckle on a large scan is not. A box the detector is at least 0.7
   sure of is kept down to half the floor: the floor is aimed at speckle, which
   detectors score low, and it was dropping short columns of dialogue.

The pixel-first pass and the confidence exemption are adapted from Manga
Cleaner (github.com/k-omiq/Bear), with its author's permission. Measured on
the bundled gold pages with RT-DETR + Koharu, before recognition confirms
anything: Japanese recall 0.895 to 0.974 (sound effects 3/7 to 6/7) with 8
more false alarms, nearly all artwork on one colour page; Korean F1 0.929 to
0.958 (sound effects 9/14 to 14/14) with 3 more false alarms. Reading the
Japanese mask-only regions, the script rule kept every real one and dropped 7
of 9 artwork blocks; on the Korean pages it dropped all 3 artwork blocks and
kept 4 of 6 real ones.

Unknown regions are no longer typed as dialogue. The kind comes from the
detector's own class (`text_free` and COO are free text), then from the reading
(`looksLikeOnomatopoeia`, `looksLikeSentence` in `src/lib/sfx.ts`). Short
hiragana in a bubble, such as a sigh, stays dialogue. A hangul sound effect is
classified from the Korean dictionary even inside a bubble; a hangul sentence
stays dialogue.

`SCAN_DETECT_CROSSCHECK=0` turns the partner off and runs the base alone.

The COO adapter in `modelImageAdapters.ts` must pass the polygon through;
chapter transcription rejects a COO region without its contour.

### Measuring changes

`scripts/eval-detection.ts` scores setups against the gold boxes (recall,
precision, F1, sound effects found, false alarms). `collect` runs the detectors
once and caches the raw output; `score` replays the fusion on the cache, so
tuning `FUSION` takes seconds instead of minutes. `--misses` lists what each
setup missed or invented. Benchmark setups include the partner part, so the
Models page scores the same pipeline production runs.

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
| `SCAN_DETECT_DEVICE` | `auto` | `auto` uses native PyTorch ROCm/CUDA when available; `cpu` forces CPU ONNX. ONNX never runs on GPU. |
| `SCAN_DETECT_THREADS` | `0` | `0` lets onnxruntime choose |
| `SCAN_DETECT_CTD_SUPPLEMENT` | `1` | `0` disables the CTD supplement |
| `SCAN_DETECT_CROSSCHECK` | `1` | `0` disables the cross-check partner (host side) |
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
.venv-workflow/bin/python scripts/install-detect-models.py            # RT-DETR and CTD
.venv-workflow/bin/python scripts/install-detect-models.py --model rtdetr
.venv-workflow/bin/python scripts/install-coo.py                      # COO weights, verifies SHA256
.venv-workflow/bin/python scripts/install-koharu.py [--gpu]           # Koharu weights + Hi-SAM source
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
| `src/lib/server/detectFusion.ts` | cross-check voting and merging |
| `scripts/eval-detection.ts` | gold-box scoring harness |

## Korean benchmark dataset

Admin → Models → Benchmark has a dataset selector. `manga-ja`
is the existing Japanese default; `manhwa-ko` contains all eight synthetic pages
from ManhwaFixture, chapter 1. Both use the same detection and OCR scoring, with
separate saved results and dataset versions. Korean OCR/translation choices obey
the models' declared language support and existing task qualification.

The Korean gold includes visually checked source-pixel boxes, printed Korean,
natural/literal English text and meaning alternatives. It has no English page
images. See [the fixture notes](../fixtures/manhwa-pages/README.md) for review,
uncertain-lettering exclusions and limitations. This is a small synthetic fixture,
not a representative assessment of all manhwa.

The detection evaluator accepts `--dataset manhwa-ko` on collection and scoring:

```sh
node --import tsx scripts/eval-detection.ts collect --dataset manhwa-ko
node --import tsx scripts/eval-detection.ts --dataset manhwa-ko rtdetr
node --import tsx scripts/eval-detection.ts --dataset manhwa-ko --misses rtdetr
```

Caches include dataset/version metadata; a mismatched `DETECT_EVAL_CACHE` is
rejected. Benchmark API GET/image queries and POST run bodies accept `dataset`;
omitting it retains Japanese behavior. English images for text-only datasets
return 404. Existing Japanese saved results still load; new results are written
to dataset/version-specific files in the ignored data directory.
