#!/usr/bin/env python3
"""Pluggable comic text-region detectors.

Long-strip webtoons are far taller than any detector's input size, so every
backend walks the page in overlapping vertical tiles and merges the results.

Backends
--------
rtdetr    RT-DETR v2 fine-tuned on ~11k manga/webtoon/manhua/comic pages.
          Emits bubble / text_bubble / text_free, so free-floating SFX and
          narration are first-class rather than accidental. Default.
ctd       comic-text-detector (BallonsTranslator): YOLOv5 text blocks plus a
          UNet text mask. Also returns the mask, which is useful for cleaning.
paddle    PaddleOCR's own DB detector run over the full page. No extra model
          download, but it scores text lines rather than text regions, so
          lines get clustered into blocks afterwards.
"""

from __future__ import annotations

import os
from typing import Any, Iterator, Sequence

import cv2
import numpy as np

BACKENDS = ("rtdetr", "ctd", "paddle")

# Regions carrying text that should be handed to the recogniser. `bubble` is
# emitted for context (grouping, cleaning) but is not itself an OCR target.
TEXT_CLASSES = ("text_bubble", "text_free", "text")

RTDETR_REPO = "ogkalu/comic-text-and-bubble-detector"
RTDETR_FILE = os.environ.get("SCAN_RTDETR_FILE", "detector.onnx")
RTDETR_SIZE = 640
RTDETR_LABELS = {0: "bubble", 1: "text_bubble", 2: "text_free"}

CTD_REPO = "mayocream/comic-text-detector-onnx"
CTD_FILE = "comic-text-detector.onnx"
CTD_SIZE = 1024

_sessions: dict[str, Any] = {}


class DetectorUnavailable(RuntimeError):
    """Backend cannot run — missing package or weights."""


# ---------------------------------------------------------------- geometry


def _tiles(height: int, tile: int, overlap: int) -> Iterator[tuple[int, int]]:
    """Yield (y0, y1) spans covering `height`, overlapping by `overlap` px."""
    if tile <= 0:
        yield 0, height
        return
    step = max(1, tile - max(0, overlap))
    y = 0
    while True:
        y1 = min(height, y + tile)
        yield y, y1
        if y1 >= height:
            return
        y += step


def _letterbox(img: np.ndarray, size: int) -> tuple[np.ndarray, float, int, int]:
    """Resize preserving aspect, pad to square. Returns (img, scale, padx, pady)."""
    h, w = img.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    padx, pady = (size - nw) // 2, (size - nh) // 2
    out = np.full((size, size, 3), 114, dtype=img.dtype)
    out[pady : pady + nh, padx : padx + nw] = resized
    return out, scale, padx, pady


def _iou_min(a: Sequence[float], b: Sequence[float]) -> float:
    """Intersection over the *smaller* box: catches containment as well as overlap."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    sa = max(1.0, (a[2] - a[0]) * (a[3] - a[1]))
    sb = max(1.0, (b[2] - b[0]) * (b[3] - b[1]))
    return inter / min(sa, sb)


def _merge_box(a: list[float], b: list[float]) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _dedupe(regions: list[dict], iou: float = 0.4) -> list[dict]:
    """Prefer complete detections; only union aligned fragments at crop seams.

    Containment alone is not evidence of duplication: small side lettering
    frequently sits inside the bounds of a larger text block.
    """
    kept: list[dict] = []
    for r in sorted(regions, key=lambda r: (bool(r.get("truncated")), -r["score"])):
        hit = None
        for k in kept:
            if k["cls"] != r["cls"]:
                continue
            a, b = r["box"], k["box"]
            aa = max(1, (a[2]-a[0])*(a[3]-a[1]))
            ab = max(1, (b[2]-b[0])*(b[3]-b[1]))
            overlap = _iou_min(a, b)
            if r.get("truncated") and k.get("truncated") and r.get("crop") != k.get("crop"):
                ox = max(0, min(a[2],b[2])-max(a[0],b[0]))/max(1,min(a[2]-a[0],b[2]-b[0]))
                oy = max(0, min(a[3],b[3])-max(a[1],b[1]))/max(1,min(a[3]-a[1],b[3]-b[1]))
                if overlap > .25 and (ox > .8 or oy > .8):
                    k["box"] = _merge_box(a,b)
                    hit = k
                    break
            if overlap > iou and min(aa, ab)/max(aa, ab) > .55:
                hit = k
                break
            # A clipped fragment can be swallowed by a complete crop result.
            if r.get("truncated") and overlap > .85 and aa < ab:
                hit = k
                break
        if hit is None:
            kept.append(dict(r))
    return sorted(kept, key=lambda r: (r["box"][1], r["box"][0]))


def _crops(width: int, height: int, tile: int, overlap: int):
    """Source-space rectangles, including a context pass without duplicates."""
    yield (0, 0, width, height)
    if tile <= 0 or (width <= tile and height <= tile):
        return
    # Keep the original full-width strip view as well: stylized lettering
    # sometimes needs context extending beyond a square crop.
    for y0, y1 in _tiles(height, tile, overlap):
        if width > tile and y1-y0 >= 64:
            yield (0, y0, width, y1)
        for x0, x1 in _tiles(width, tile, overlap):
            if x1-x0 >= 64 and y1-y0 >= 64:
                yield (x0, y0, x1, y1)


def _clip(regions: list[dict], W: int, H: int, min_side: int = 6) -> list[dict]:
    out = []
    for r in regions:
        x0, y0, x1, y1 = r["box"]
        x0 = float(min(max(0.0, x0), W))
        y0 = float(min(max(0.0, y0), H))
        x1 = float(min(max(0.0, x1), W))
        y1 = float(min(max(0.0, y1), H))
        if x1 - x0 < min_side or y1 - y0 < min_side:
            continue
        out.append({**r, "box": [x0, y0, x1, y1]})
    return out


# ---------------------------------------------------------------- sessions


def _session(repo: str, filename: str, threads: int = 0) -> Any:
    key = f"{repo}/{filename}"
    if key in _sessions:
        return _sessions[key]
    try:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
    except ImportError as e:  # pragma: no cover - environment problem
        raise DetectorUnavailable(f"onnxruntime/huggingface_hub missing: {e}") from e

    try:
        path = hf_hub_download(repo, filename)
    except Exception as e:
        raise DetectorUnavailable(f"could not fetch {key}: {e}") from e

    opts = ort.SessionOptions()
    if threads > 0:
        opts.intra_op_num_threads = threads
    providers = _providers()
    _sessions[key] = ort.InferenceSession(path, opts, providers=providers)
    return _sessions[key]


def _providers() -> list[str]:
    """Prefer a GPU execution provider when the build offers one."""
    import onnxruntime as ort

    want = os.environ.get("SCAN_DETECT_DEVICE", "auto").lower()
    have = set(ort.get_available_providers())
    if want == "cpu":
        return ["CPUExecutionProvider"]
    ranked = ["ROCMExecutionProvider", "MIGraphXExecutionProvider", "CUDAExecutionProvider"]
    return [p for p in ranked if p in have] + ["CPUExecutionProvider"]


def threads_from_env() -> int:
    try:
        return int(os.environ.get("SCAN_DETECT_THREADS", "0"))
    except ValueError:
        return 0


# ---------------------------------------------------------------- rtdetr


def detect_rtdetr(
    img: np.ndarray,
    conf: float = 0.20,
    tile: int = 690,
    overlap: int = 172,
    *,
    progress=None,
) -> list[dict]:
    if progress:
        progress("RT-DETR", "Detecting regions")
    sess = _session(RTDETR_REPO, RTDETR_FILE, threads_from_env())
    H, W = img.shape[:2]
    rows: list[dict] = []
    for x0, y0, x1, y1 in _crops(W, H, tile, overlap):
        crop = img[y0:y1, x0:x1]
        th, tw = crop.shape[:2]
        if th < 64:
            continue
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        # The checkpoint's processor does a plain resize (no letterbox, no
        # mean/std) and rescales by 1/255.
        inp = cv2.resize(rgb, (RTDETR_SIZE, RTDETR_SIZE), interpolation=cv2.INTER_LINEAR)
        inp = (inp.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        labels, boxes, scores = sess.run(
            None,
            {"images": inp, "orig_target_sizes": np.array([[tw, th]], dtype=np.int64)},
        )
        for lb, bx, sc in zip(labels[0], boxes[0], scores[0]):
            if float(sc) < conf:
                continue
            rows.append(
                {
                    "cls": RTDETR_LABELS.get(int(lb), str(int(lb))),
                    "backend": "rtdetr",
                    "score": float(sc),
                    "box": [float(bx[0]) + x0, float(bx[1]) + y0, float(bx[2]) + x0, float(bx[3]) + y0],
                    "crop": [x0, y0, x1, y1],
                    "truncated": bool((x0 > 0 and bx[0] < 6) or
                                      (y0 > 0 and bx[1] < 6) or
                                      (x1 < W and bx[2] > tw-6) or
                                      (y1 < H and bx[3] > th-6)),
                }
            )
    out = _dedupe(_clip(rows, W, H))
    # CTD contributes small lettering that RT-DETR sometimes misses. Keep the
    # RT-DETR classes and geometry wherever the models agree.
    if os.environ.get("SCAN_DETECT_CTD_SUPPLEMENT", "1") != "0":
        try:
            if progress:
                progress("Comic Text Detector", "Detecting regions")
            extra = detect_ctd(img, conf=max(.4, conf))
            for candidate in extra:
                a = candidate["box"]
                area = max(1, (a[2]-a[0])*(a[3]-a[1]))
                duplicate = False
                for existing in out:
                    if existing["cls"] not in TEXT_CLASSES:
                        continue
                    b = existing["box"]
                    other = max(1, (b[2]-b[0])*(b[3]-b[1]))
                    if (_iou_min(a,b) > .65 and min(area,other)/max(area,other) > .3) or (existing["cls"] == "text_bubble" and area < other and _iou_min(a,b) > .9):
                        duplicate = True
                        break
                if not duplicate:
                    out.append({**candidate, "backend": "ctd"})
        except DetectorUnavailable:
            # Standalone RT-DETR installations remain usable.
            pass
    return out


# ---------------------------------------------------------------- ctd


def _nms(boxes: np.ndarray, scores: np.ndarray, iou: float = 0.35) -> list[int]:
    order = scores.argsort()[::-1]
    areas = (boxes[:, 2] - boxes[:, 0]) * (boxes[:, 3] - boxes[:, 1])
    keep: list[int] = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx0 = np.maximum(boxes[i, 0], boxes[rest, 0])
        yy0 = np.maximum(boxes[i, 1], boxes[rest, 1])
        xx1 = np.minimum(boxes[i, 2], boxes[rest, 2])
        yy1 = np.minimum(boxes[i, 3], boxes[rest, 3])
        inter = np.maximum(0.0, xx1 - xx0) * np.maximum(0.0, yy1 - yy0)
        ovr = inter / np.maximum(1e-6, areas[i] + areas[rest] - inter)
        order = rest[ovr <= iou]
    return keep


def detect_ctd(
    img: np.ndarray,
    conf: float = 0.35,
    tile: int = 1024,
    overlap: int = 256,
    want_mask: bool = False,
) -> list[dict] | tuple[list[dict], np.ndarray]:
    sess = _session(CTD_REPO, CTD_FILE, threads_from_env())
    H, W = img.shape[:2]
    rows: list[dict] = []
    mask = np.zeros((H, W), dtype=np.uint8) if want_mask else None

    for y0, y1 in _tiles(H, tile, overlap):
        crop = img[y0:y1]
        th, tw = crop.shape[:2]
        if th < 64:
            continue
        rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        boxed, scale, padx, pady = _letterbox(rgb, CTD_SIZE)
        inp = (boxed.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        blk, seg, _det = sess.run(None, {"images": inp})

        raw = blk[0]
        obj = raw[:, 4]
        cls = raw[:, 5:]
        score = obj * cls.max(axis=1)
        pick = score >= conf
        if pick.any():
            sel = raw[pick]
            sc = score[pick]
            cx, cy, bw, bh = sel[:, 0], sel[:, 1], sel[:, 2], sel[:, 3]
            xyxy = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], axis=1)
            xyxy[:, [0, 2]] = (xyxy[:, [0, 2]] - padx) / scale
            xyxy[:, [1, 3]] = (xyxy[:, [1, 3]] - pady) / scale
            for i in _nms(xyxy, sc):
                b = xyxy[i]
                rows.append(
                    {
                        "cls": "text",
                        "score": float(sc[i]),
                        "box": [float(b[0]), float(b[1]) + y0, float(b[2]), float(b[3]) + y0],
                    }
                )

        if mask is not None:
            m = (seg[0, 0] * 255).astype(np.uint8)
            nh, nw = int(round(th * scale)), int(round(tw * scale))
            m = m[pady : pady + nh, padx : padx + nw]
            if m.size:
                mask[y0:y1] = np.maximum(mask[y0:y1], cv2.resize(m, (tw, th)))

    out = _dedupe(_clip(rows, W, H))
    if mask is not None:
        return out, mask
    return out


# ---------------------------------------------------------------- paddle


def _cluster_lines(lines: list[dict], gap_y: float = 0.7, gap_x: float = 1.2) -> list[dict]:
    """Group OCR text lines into blocks. Two lines join when they overlap
    horizontally and sit within `gap_y` line-heights of each other."""
    remaining = sorted(lines, key=lambda r: (r["box"][1], r["box"][0]))
    blocks: list[dict] = []
    for line in remaining:
        b = line["box"]
        h = max(1.0, b[3] - b[1])
        placed = False
        for blk in blocks:
            k = blk["box"]
            kh = max(1.0, k[3] - k[1])
            ref = min(h, kh)
            x_overlap = min(b[2], k[2]) - max(b[0], k[0])
            near_x = x_overlap > -gap_x * ref
            vgap = max(b[1] - k[3], k[1] - b[3])
            if near_x and vgap < gap_y * ref:
                blk["box"] = _merge_box(k, b)
                blk["score"] = max(blk["score"], line["score"])
                blk["n"] += 1
                placed = True
                break
        if not placed:
            blocks.append({"cls": "text", "score": line["score"], "box": list(b), "n": 1})
    return blocks


def detect_paddle(
    img: np.ndarray,
    ocr: Any,
    conf: float = 0.3,
    tile: int = 1400,
    overlap: int = 220,
    upscale: float = 2.0,
) -> list[dict]:
    if ocr is None:
        raise DetectorUnavailable("PaddleOCR instance not available")
    H, W = img.shape[:2]
    lines: list[dict] = []
    for y0, y1 in _tiles(H, tile, overlap):
        crop = img[y0:y1]
        if crop.shape[0] < 32:
            continue
        if upscale and upscale != 1.0:
            crop = cv2.resize(
                crop, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC
            )
        s = upscale or 1.0
        results = ocr.predict(crop)
        if not results:
            continue
        res = results[0]
        polys = list(res.get("rec_polys") or []) if hasattr(res, "get") else []
        scores = list(res.get("rec_scores") or []) if hasattr(res, "get") else []
        for i, poly in enumerate(polys):
            sc = float(scores[i]) if i < len(scores) else 0.0
            if sc < conf:
                continue
            xs = [float(p[0]) / s for p in poly]
            ys = [float(p[1]) / s for p in poly]
            lines.append(
                {
                    "cls": "text",
                    "score": sc,
                    "box": [min(xs), min(ys) + y0, max(xs), max(ys) + y0],
                }
            )
    merged = _dedupe(lines, iou=0.3)
    return _dedupe(_cluster_lines(merged), iou=0.5)


# ---------------------------------------------------------------- dispatch


def detect(
    img: np.ndarray,
    backend: str = "rtdetr",
    conf: float | None = None,
    tile: int | None = None,
    overlap: int | None = None,
    ocr: Any = None,
    *,
    progress=None,
) -> list[dict]:
    backend = (backend or "rtdetr").lower()
    if backend == "rtdetr":
        t = tile or 690
        return detect_rtdetr(
            img, conf if conf is not None else 0.20, t, overlap or int(t * 0.25), progress=progress)
    if backend == "ctd":
        if progress:
            progress("Comic Text Detector", "Detecting regions")
        t = tile or 1024
        out = detect_ctd(img, conf if conf is not None else 0.22, t, overlap or int(t * 0.25))
        return out if isinstance(out, list) else out[0]
    if backend == "paddle":
        if progress:
            progress("PaddleOCR", "Detecting regions")
        t = tile or 1400
        return detect_paddle(img, ocr, conf if conf is not None else 0.3, t, overlap or 220)
    raise DetectorUnavailable(f"unknown backend: {backend}")
