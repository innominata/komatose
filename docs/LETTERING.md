# Text detection and lettering masks

RT-DETR remains the primary detector. It sees a whole-page context view, overlapping square crops, and full-width strips. Results retain source crop coordinates and truncation flags. Complete detections take precedence over seam fragments; only aligned, overlapping fragments from different crops are joined. Small nested lettering remains distinct during both detection and saved-region matching.

CTD contributes additional text candidates at confidence >= 0.4 (or the higher explicitly requested detection confidence). RT-DETR retains its classification where the models agree. Missing CTD dependencies do not disable RT-DETR. `SCAN_DETECT_CTD_SUPPLEMENT=0` disables supplementation for comparison. No new model is required.

**Koharu SAM-TS-L** (`mayocream/koharu-text-sam-ts-l`) is the quality-oriented full-page text model when installed. Chapter transcription runs it during the initial region pass, after RT-DETR, the CTD supplement, and COO. Connected mask components become text blocks. A block already inside a detector box is not added again; a box that clips the same text grows to include it; text no box detector saw is saved as its own region. The same full-page mask, expanded once, is reused for that page's OCR crops. It uses the publisher preprocessing (RGB 0–255, longest side 1024, bottom/right pad 128, high-resolution mask, nearest resize to source pixels). GPU inference uses bfloat16 autocast with float32 weights. **CTD** (`ocr/lettering.py`) remains available for comparison: full-page and region-crop CTD probabilities with strong/weak thresholds 150/65, local contrast, block evidence, connected ink, and bounded white-outline recovery.

`SCAN_KOHARU_DETECT=auto` (default) follows the mask engine: Koharu when that engine is `auto` or `koharu` and the weights are installed, and off when the mask engine is `ctd`. `1` requires Koharu and fails the page if it is missing or broken. `0` leaves detection on the box detectors only. While a transcription or mask job is running, its status and job log name the current step and the model actually in that step, including RT-DETR, Comic Text Detector, COO DBNet++, Koharu SAM-TS-L, and the OCR models.

`SCAN_MASK_ENGINE=auto` (default) selects Koharu when pinned weights and Hi-SAM source are installed; `ctd` forces CTD; `koharu` requires Koharu and fails visibly if missing or broken. Detection padding is applied once. Every proposal is clipped to the saved region union, including supplied draft strokes. Saved masks never acquire additional padding during approval or cleaning.

Install Koharu in the workflow environment:

```
.venv-workflow/bin/python scripts/install-koharu.py
.venv-workflow/bin/python scripts/install-koharu.py --gpu
```

Production paths live under `data/models/koharu-text-sam-ts-l/` and `data/models/hi-sam-<revision>/`. The installer reuses a verified download under `data/bench-lettering/model-comparison/` when present.

Mask diagnostics record the source asset, mask asset, region IDs/revisions/boundaries, engine, backend, and algorithm version. Stale diagnostics are omitted from workflow state. Manual mask edits invalidate them through the mask asset identity. Review reasons identify empty coverage, boundary contact, or rejected uncertain components. They are review hints, not calibrated probabilities.

## Validation

- `npm run test:lettering` checks tiling, source-coordinate mapping, seam merging, nested regions, conservative refinement, bold/outlined ink, clipping, and diagnostic invalidation.
- `npm run test:geometry` checks existing geometry, region containment, mask stability, and cleaning behavior.
- `python3 scripts/capture-lettering-baseline.py EPISODE --out data/bench-lettering/new-baseline` snapshots a named episode using a read-only database connection. It refuses to overwrite a baseline.
- `.venv-workflow/bin/python scripts/bench-lettering.py data/bench-lettering/baseline --out data/bench-lettering/results` writes per-page overlays, detection boxes, timings, diagnostics, and metrics. It does not modify the database. Saved source hashes identify the exact algorithm used.

The supplied episode’s frozen inputs and results are under `data/bench-lettering/`. Reusable annotations are under `tests/fixtures/lettering/`; their README explains the sampled coverage and box-matching limitations.

## Limits

Decorative SFX, faint headings, and text touching artwork can still be incomplete or include nearby marks. Keep proposals unapproved until reviewed. Hard region boundaries can clip outlines; increase the region explicitly when the diagnostic identifies clipping. Confidence thresholds and padding are source-pixel heuristics, not guarantees for every scan resolution.

No database migration is needed. Existing masks remain readable, and new detection runs produce reviewable proposals. Restart running application/OCR workers after deployment so they load the new Python modules.

## COO sound-effect detection

RT-DETR is supplemented by the **COO-trained DBNet++** checkpoint when installed. COO is the training dataset/project; DBNet++ is the selected detector. This uses the [checkpoint linked by the COO authors](https://github.com/ku21fan/COO-Comic-Onomatopoeia#text-detection), not generic scene-text DBNet weights. Dialogue detection stays with RT-DETR/CTD. COO returns normalized source contours and `text_free` classifications; contours stay editable and survive the bubble-geometry pass and saved-region writes. Similar boxes are suppressed, while small nested dialogue remains separate.

Install in the existing workflow environment (with compatible torch/torchvision already installed):

```
uv pip install --python .venv-workflow/bin/python 'pyclipper>=1.3,<2'
.venv-workflow/bin/python scripts/install-coo.py
```

The installer downloads only the official 111 MiB checkpoint, verifies SHA-256 `889a26c041cc03be7c3864de940368dc393b46d036da49f9bf762a8b798724cf`, then runs a real inference smoke check. It does not install the upstream legacy CUDA extension. `ocr/coo_model.py` implements inference using current torch/torchvision, following [MhLiao/DB](https://github.com/MhLiao/DB) commit `65ca77a0bcfbd7114b916cf8a1e9ca85114286ce`. It preserves the original stride-two DCNv2 offset memory layout; replacing that with ordinary spatial subsampling changes the trained model. All weights load with `weights_only=True` after checksum validation. Training-only threshold/classification heads are unused. A local comparison of this inference implementation and upstream ResNet/ASF modules using the same torchvision compatibility operator had zero maximum output difference.

`SCAN_COO=auto` (default) enables the pass when the model exists; `0` disables it, and `1` requires it. `SCAN_COO_MODEL` overrides its path. Installed-model inference failures fail detection visibly rather than silently dropping SFX. `SCAN_COO_CONF=0.60` is the contour confidence threshold, independent of RT-DETR confidence. The probability threshold is 0.3; polygon expansion uses the upstream area/perimeter ratio 2. Input short side is 736, capped at 1536 on the long side, rounded to multiples of 32. Pages over 1600 pixels additionally use 1280-pixel crops with 320-pixel overlap. `SCAN_COO_THREADS=4` limits CPU threads; the workflow worker owns the torch runtime. No images leave the machine.

COO outputs text-region probabilities, **not lettering-removal masks**. They are never directly applied as erase pixels. Existing CTD mask refinement, saved-mask stability, region limits, approval, and undo still apply. Decorative lettering can still need manual mask refinement even when its region is now detected.

Validation:

```
npm run test:coo
.venv-workflow/bin/python scripts/bench-coo.py data/bench-lettering/baseline --out data/bench-lettering/coo-validated --previous data/bench-lettering/final/results.json
```

Six manually bounded large-SFX targets on pages 4, 5, 7, and 8 improved from 2/6 to 6/6 matching boxes at IoU >= 0.5. This is a targeted regression set, not general recall or a mask-coverage score. The eight-page run produced 17 COO proposals; warmed CPU inference was approximately 1.2–1.7 seconds per page on this host. Results and source hashes are saved under `data/bench-lettering/coo-validated`. Restart the app and workflow worker after deployment.
