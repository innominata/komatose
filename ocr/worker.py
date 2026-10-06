#!/usr/bin/env python3
"""Persistent OCR + detection worker. One JSON object per stdin/stdout line.

Commands
--------
{"cmd":"detect","path":...,"backend":"rtdetr"}  -> {"regions":[...],"width":W,"height":H}
{"cmd":"ocr","b64":...,"upscale":2}             -> {"text":"...","score":0.93}
{"cmd":"inpaint","path":...,"x":..,"y":..,"w":..,"h":..}  -> {"method":"fill"|"inpaint"}
{"cmd":"inpaint","path":...,"poly":[[x,y],...]}          -> same, polygon mask
{"cmd":"warmup","what":"ocr"|"detect"}          -> {"ok":true}
{"cmd":"quit"}

A request with `b64`/`path` and no `cmd` is treated as `ocr`, which keeps the
original single-purpose protocol working.

Models load on first use so a detect-only run never pays for PaddleOCR (and
vice versa).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import sys
import traceback

os.environ.setdefault("FLAGS_allocator_strategy", "naive_best_fit")

logging.disable(logging.WARNING)
for name in ("paddle", "paddlex", "paddleocr"):
    logging.getLogger(name).setLevel(logging.ERROR)

_REAL_STDOUT = sys.stdout
# PaddleOCR lang code -> loaded instance. korean and japan models are separate.
_ocr_by_lang: dict[str, object] = {}


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: dict) -> None:
    _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _REAL_STDOUT.flush()


class _quiet:
    """Route library chatter to stderr so stdout stays newline-delimited JSON."""

    def __enter__(self):
        sys.stdout = sys.stderr
        return self

    def __exit__(self, *exc):
        sys.stdout = _REAL_STDOUT
        return False


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# ---------------------------------------------------------------- recogniser


def _paddle_device() -> str:
    want = (os.environ.get("SCAN_OCR_DEVICE") or "cpu").lower()
    if want in ("cpu", ""):
        return "cpu"
    try:
        import paddle

        if paddle.device.is_compiled_with_rocm() or paddle.device.cuda.device_count() > 0:
            return "gpu"
    except Exception:
        pass
    _log("SCAN_OCR_DEVICE requested gpu but paddle has no GPU build; using cpu")
    return "cpu"


def _paddle_lang(req: dict | None = None) -> str:
    """Map a request/env language to a PaddleOCR lang code (korean | japan)."""
    raw = ""
    if req is not None:
        raw = str(req.get("lang") or "")
    raw = (raw or os.environ.get("SCAN_OCR_LANG") or "japanese").strip().lower()
    if raw in ("ja", "jp", "jpn", "japanese", "japan"):
        return "japan"
    return "korean"


def _lang_label(code: str) -> str:
    return "Japanese" if code == "japan" else "Korean"


def _get_ocr(lang: str | None = None):
    key = lang or _paddle_lang()
    existing = _ocr_by_lang.get(key)
    if existing is not None:
        return existing
    device = _paddle_device()
    if device == "cpu":
        os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    with _quiet():
        from paddleocr import PaddleOCR
        import numpy as np

        _log(f"loading PaddleOCR {_lang_label(key)} PP-OCRv5 on {device}…")
        # Japanese on PP-OCRv5 is wired to the Chinese server recogniser,
        # which hallucinates LaTeX (`$\\t$`, `\frac`) on manga SFX. v6 has a
        # real multilingual rec that includes Japanese. Korean stays on v5.
        inst = PaddleOCR(
            lang=key,
            ocr_version="PP-OCRv6" if key == "japan" else "PP-OCRv5",
            device=device,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            # Manga dialogue is often vertical; webtoon Hangul is almost always horizontal.
            use_textline_orientation=key == "japan",
        )
        inst.predict(np.full((64, 64, 3), 255, dtype=np.uint8))
    _ocr_by_lang[key] = inst
    _log(f"PaddleOCR {_lang_label(key)} ready")
    return inst


def _join_texts(texts: list[str]) -> str:
    cleaned = [t.strip() for t in texts if t and str(t).strip()]
    if not cleaned:
        return ""
    if all(len(t) <= 2 for t in cleaned):
        return "".join(cleaned)
    return " ".join(cleaned)


def _poly_bbox(poly) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    try:
        for pt in poly:
            xs.append(float(pt[0]))
            ys.append(float(pt[1]))
    except (TypeError, IndexError, ValueError):
        return None
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def _reading_order(items: list[tuple[tuple[float, float, float, float] | None, str, float]], japanese: bool = False):
    """Sort recognised fragments into reading order.

    Sorting on centroid alone interleaves words in a centred, multi-line
    balloon, because each line has a different centre-x. Group fragments into
    rows by vertical overlap first, then read each row left to right.
    """
    placed = [i for i in items if i[0] is not None]
    loose = [i for i in items if i[0] is None]
    # Vertical Japanese columns run top to bottom, with columns ordered right to left.
    vertical = japanese and placed and sum((i[0][3]-i[0][1]) > (i[0][2]-i[0][0])*1.3 for i in placed) >= len(placed)/2
    if vertical:
        columns = []
        for item in sorted(placed, key=lambda i: -i[0][2]):
            x0, _, x1, _ = item[0]
            column = next((c for c in columns if min(x1,c[0][0][2])-max(x0,c[0][0][0]) > .5*min(x1-x0,c[0][0][2]-c[0][0][0])), None)
            if column is None: columns.append([item])
            else: column.append(item)
        return [item for c in columns for item in sorted(c,key=lambda i:i[0][1])] + loose
    placed.sort(key=lambda i: i[0][1])

    rows: list[list] = []
    for item in placed:
        _, y0, _, y1 = item[0]
        row = None
        for candidate in rows:
            ry0 = min(r[0][1] for r in candidate)
            ry1 = max(r[0][3] for r in candidate)
            # Same row when the vertical spans genuinely overlap, not merely
            # sit near each other: adjacent lines in a tightly set balloon are
            # only a few pixels apart.
            overlap = min(y1, ry1) - max(y0, ry0)
            if overlap > 0.5 * max(1.0, min(y1 - y0, ry1 - ry0)):
                row = candidate
                break
        if row is None:
            rows.append([item])
        else:
            row.append(item)

    out = []
    for row in rows:
        row.sort(key=lambda i: i[0][0])
        out.extend(row)
    return out + loose


def _extract(result, min_score: float, japanese: bool = False) -> tuple[str, float]:
    rec_texts: list = []
    rec_scores: list = []
    rec_polys: list = []
    if hasattr(result, "get"):
        rec_texts = list(result.get("rec_texts") or [])
        rec_scores = list(result.get("rec_scores") or [])
        rec_polys = list(result.get("rec_polys") or [])
    if not rec_texts and isinstance(result, dict):
        rec_texts = list(result.get("rec_texts") or [])
        rec_scores = list(result.get("rec_scores") or [])
        rec_polys = list(result.get("rec_polys") or [])

    items: list[tuple[tuple[float, float, float, float] | None, str, float]] = []
    for i, text in enumerate(rec_texts):
        score = float(rec_scores[i]) if i < len(rec_scores) else 1.0
        if score < min_score:
            continue
        poly = rec_polys[i] if i < len(rec_polys) else None
        items.append((_poly_bbox(poly) if poly is not None else None, str(text), score))

    ordered = _reading_order(items, japanese)
    texts = [r[1] for r in ordered]
    scores = [r[2] for r in ordered]
    avg = sum(scores) / len(scores) if scores else 0.0
    return _join_texts(texts), avg


def _decode(req: dict):
    import cv2
    import numpy as np

    raw: bytes | None = None
    path = req.get("path")
    b64 = req.get("b64")
    if path:
        with open(path, "rb") as f:
            raw = f.read()
    elif b64:
        raw = base64.b64decode(b64)
    if not raw:
        raise ValueError("missing path or b64")
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def _auto_factor(h: int, w: int) -> float:
    """Small crops recognise far better with headroom: dialogue on a 690px-wide
    webtoon is only ~25px tall. Large crops gain nothing, so leave them alone."""
    short = min(h, w)
    if short < 90:
        return 4.0
    if short < 180:
        return 3.0
    if short < 360:
        return 2.0
    return 1.0


def _upscaled(img, factor, cap: int = 2600):
    import cv2

    h, w = img.shape[:2]
    f = _auto_factor(h, w) if factor in (None, "auto") else float(factor)
    if f <= 1.0:
        return img
    f = min(f, cap / max(1, max(h, w)))
    if f <= 1.0:
        return img
    return cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)


def do_ocr(req: dict) -> dict:
    img = _decode(req)
    factor = req.get("upscale")
    if factor is None:
        factor = os.environ.get("SCAN_OCR_UPSCALE") or "auto"
    if isinstance(factor, str) and factor.lower() != "auto":
        try:
            factor = float(factor)
        except ValueError:
            factor = "auto"
    min_score = float(req.get("minScore") or _env_float("SCAN_OCR_MIN_SCORE", 0.35))
    ocr = _get_ocr(_paddle_lang(req))
    img = _upscaled(img, factor)
    with _quiet():
        results = ocr.predict(img)
    text, score = ("", 0.0)
    if results:
        text, score = _extract(results[0], min_score, _paddle_lang(req) == "japan")
    return {"text": text, "score": score}


# ---------------------------------------------------------------- detection


def do_detect(req: dict) -> dict:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import detect as D

    img = _decode(req)
    backend = str(req.get("backend") or os.environ.get("SCAN_DETECTOR") or "rtdetr").lower()
    conf = req.get("conf")
    tile = req.get("tile")
    overlap = req.get("overlap")
    def progress(model: str, step: str) -> None:
        if req.get("id") is None:
            return
        _emit({
            "id": req.get("id"),
            "ok": True,
            "progress": True,
            "model": model,
            "step": step,
        })

    with _quiet():
        regions = D.detect(
            img,
            backend=backend,
            conf=float(conf) if conf is not None else None,
            tile=int(tile) if tile else None,
            overlap=int(overlap) if overlap else None,
            ocr=_get_ocr(_paddle_lang(req)) if backend == "paddle" else None,
            progress=progress,
            supplement=req.get("supplement") is not False,
            device=req.get('device', 'cpu'),
        )
    h, w = img.shape[:2]
    payload = []
    for r in regions:
        row = {
            "cls": r["cls"],
            "score": round(float(r["score"]), 4),
            "box": [round(float(v), 1) for v in r["box"]],
        }
        if r.get("backend"):
            row["backend"] = r["backend"]
        if isinstance(r.get("crop"), (list, tuple)) and len(r["crop"]) == 4:
            row["crop"] = [round(float(v), 1) for v in r["crop"]]
        if r.get("truncated"):
            row["truncated"] = True
        payload.append(row)
    return {
        "regions": payload,
        "width": w,
        "height": h,
        "backend": backend,
    }


_lama = {}


def _get_lama(device="cpu"):
    """Native mayocream LaMa Manga, cached per PyTorch device."""
    if device not in _lama:
        import torch
        from spandrel import ModelLoader
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file

        with _quiet():
            path = os.environ.get("SCAN_LAMA_CHECKPOINT") or hf_hub_download(
                "mayocream/lama-manga", "lama-manga.safetensors",
                revision="f91c85b26913b3e83f9877867b4c336da3675238")
            state = load_file(path, device="cpu")
            # The published SafeTensors omit the generator wrapper prefix.
            state = {("generator." + k if k.startswith("model.") else k): v
                     for k, v in state.items()}
            _lama[device] = ModelLoader().load_from_state_dict(state).to(device).eval()
        runtime = ('ROCm' if torch.version.hip else 'CUDA') if str(device).startswith('cuda') else 'CPU'
        _log(f"lama-manga loaded from {path} on {device}: PyTorch {runtime}")
    return _lama[device]


def _lama_run(img, mask, device="cpu"):
    """One LaMa pass. BGR uint8 + uint8 mask (255=erase) -> full BGR result."""
    import cv2
    import numpy as np
    import torch

    model = _get_lama(device)
    h, w = img.shape[:2]
    # Native FFT accepts varying dimensions; only the model's stride needs padding.
    im = cv2.copyMakeBorder(img, 0, (-h) % 8, 0, (-w) % 8, cv2.BORDER_REFLECT)
    m = cv2.copyMakeBorder(mask, 0, (-h) % 8, 0, (-w) % 8, cv2.BORDER_CONSTANT, value=0)
    x = np.ascontiguousarray(im[:, :, ::-1].transpose(2, 0, 1))[None].astype(np.float32) / 255.0
    mm = (m > 0).astype(np.float32)[None, None]
    with torch.inference_mode():
        out = model(torch.from_numpy(x).to(device), torch.from_numpy(mm).to(device)).cpu().numpy()[0]
    res = np.clip(out.transpose(1, 2, 0) * 255.0, 0, 255).astype(np.uint8)[:, :, ::-1]
    return np.ascontiguousarray(res[:h, :w])


# Longest crop side LaMa sees after upscaling; bounds memory and inference time.
_LAMA_MAX_SIDE = 1024


def _lama_inpaint(crop, mask):
    """Replace masked pixels via LaMa. Manga pages are small, and LaMa
    hallucinates noticeably sharper detail with more pixels per feature, so
    run it up to 2x upscaled and bring the result back down."""
    import cv2

    h, w = crop.shape[:2]
    scale = min(2.0, _LAMA_MAX_SIDE / max(h, w))
    if scale > 1.05:
        big = cv2.resize(crop, (int(round(w * scale)), int(round(h * scale))), interpolation=cv2.INTER_CUBIC)
        bm = cv2.resize(mask, (big.shape[1], big.shape[0]), interpolation=cv2.INTER_NEAREST)
        bm = cv2.dilate(bm, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
        res = cv2.resize(_lama_run(big, bm), (w, h), interpolation=cv2.INTER_AREA)
    else:
        res = _lama_run(crop, mask)
    result = crop.copy()
    result[mask > 0] = res[mask > 0]
    return result


def _tone_fill(crop, mask, lama_out):
    """Screentone rescue. LaMa regresses fine stationary textures (halftone,
    hatching) to a smooth blur, which reads as a pale smudge on the page. If
    the surround is such a texture and LaMa visibly lost its high frequencies,
    patch-based shift-map synthesis reproduces the tone far better. Returns
    None when LaMa's result should stand (structured art, gradients, flats)."""
    import cv2
    import numpy as np

    if not hasattr(cv2, "xphoto"):
        return None
    g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).astype(np.float32)
    ring = cv2.subtract(cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))), mask)
    # Local 8x8 statistics, sampled only where the whole cell sits in the ring.
    cs = 8
    full = cv2.erode(ring, np.ones((cs, cs), np.uint8)) > 0
    if int(full.sum()) < 40:
        return None
    mu = cv2.blur(g, (cs, cs))
    sd = np.sqrt(np.maximum(cv2.blur(g * g, (cs, cs)) - mu * mu, 0.0))
    cell_std = float(np.median(sd[full]))  # fine texture energy
    mean_std = float(np.std(mu[full]))  # large-scale variation (edges, gradients)
    inner = cv2.erode(mask, np.ones((5, 5), np.uint8)) > 0
    hf_ring = float(np.abs(cv2.Laplacian(g, cv2.CV_32F, ksize=3))[ring > 0].mean())
    gl = cv2.cvtColor(lama_out, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hf_lama = float(np.abs(cv2.Laplacian(gl, cv2.CV_32F, ksize=3))[inner].mean()) if inner.any() else 0.0
    ratio = hf_lama / max(hf_ring, 1e-3)
    stats = f"cell_std={cell_std:.2f} mean_std={mean_std:.1f} hf={hf_lama:.1f}/{hf_ring:.1f}"
    if cell_std < 0.6 or int(inner.sum()) < 50:
        _log(f"tone: skip ({stats})")  # flat surround, or nothing to judge
        return None
    # Only a *fine, even* screen (halftone/dots: mean_std ~3). Coarse swirl
    # and mixed bubble+art rings look like texture statistically, but
    # shift-map pastes a hatch that is worse than LaMa's blur.
    edges = cv2.Canny(np.clip(g, 0, 255).astype(np.uint8), 40, 120)
    edge_frac = float((edges > 0)[ring > 0].mean())
    fine_tone = mean_std <= 8.0 and edge_frac < 0.12 and ratio < 0.8
    if not fine_tone:
        _log(f"tone: lama stands ({stats} edge={edge_frac:.2f})")
        return None
    # Synthesise from the tone's own neighbourhood only: given the whole crop,
    # shift-map happily drags in panel borders and line art from further out.
    ys, xs = np.where(mask > 0)
    r = 40
    sx0, sy0 = max(0, int(xs.min()) - r), max(0, int(ys.min()) - r)
    sx1, sy1 = min(crop.shape[1], int(xs.max()) + 1 + r), min(crop.shape[0], int(ys.max()) + 1 + r)
    sub = crop[sy0:sy1, sx0:sx1]
    smask = mask[sy0:sy1, sx0:sx1]
    dst = np.zeros_like(sub)
    cv2.xphoto.inpaint(sub, (smask == 0).astype(np.uint8), dst, cv2.xphoto.INPAINT_SHIFTMAP)
    gd = cv2.cvtColor(dst, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sinner = inner[sy0:sy1, sx0:sx1]
    # Shift-map can still pick a wrong patch; require the fill to sit at the
    # surround's brightness or fall back to LaMa.
    drift = abs(float(gd[sinner].mean()) - float(g[ring > 0].mean()))
    if drift > 16.0:
        _log(f"tone: shift-map drifted {drift:.0f} ({stats})")
        return None
    hf_shift = float(np.abs(cv2.Laplacian(gd, cv2.CV_32F, ksize=3))[sinner].mean())
    if hf_shift > 1.25 * hf_ring:
        _log(f"tone: shift-map seams hf={hf_shift:.1f} ({stats})")
        return None
    _log(f"tone: shift-map ({stats})")
    out = crop.copy()
    out[sy0:sy1, sx0:sx1][smask > 0] = dst[smask > 0]
    return out


def _norm_poly(req: dict, W: int, H: int):
    import numpy as np

    raw = req.get("poly") or req.get("points")
    if not isinstance(raw, list) or len(raw) < 3:
        return None
    pts: list[list[int]] = []
    for p in raw[:400]:
        if isinstance(p, dict):
            x, y = float(p.get("x") or 0), float(p.get("y") or 0)
        elif isinstance(p, (list, tuple)) and len(p) >= 2:
            x, y = float(p[0]), float(p[1])
        else:
            continue
        pts.append(
            [
                int(round(max(0.0, min(1.0, x)) * W)),
                int(round(max(0.0, min(1.0, y)) * H)),
            ]
        )
    if len(pts) < 3:
        return None
    return np.array(pts, dtype=np.int32)


def _bubble_fill(img, req: dict) -> str:
    """Flood-fill a speech bubble from a clicked point: grow across the
    near-uniform interior, stop at the outline, fill enclosed text holes,
    then contract so the outline is untouched. Mutates img."""
    import cv2
    import numpy as np

    H, W = img.shape[:2]
    sx = int(round(max(0.0, min(1.0, float(req.get("px") or 0))) * W))
    sy = int(round(max(0.0, min(1.0, float(req.get("py") or 0))) * H))

    for radius in (512, 1024):
        cx0, cy0 = max(0, sx - radius), max(0, sy - radius)
        cx1, cy1 = min(W, sx + radius), min(H, sy + radius)
        crop = img[cy0:cy1, cx0:cx1].copy()
        h, w = crop.shape[:2]
        lx, ly = sx - cx0, sy - cy0

        # Seed on the brightest pixel near the click so landing on a glyph
        # still floods the bubble, not the lettering.
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        nx0, ny0 = max(0, lx - 10), max(0, ly - 10)
        nb = gray[ny0 : min(h, ly + 11), nx0 : min(w, lx + 11)]
        dy, dx = np.unravel_index(int(np.argmax(nb)), nb.shape)
        seed = (nx0 + int(dx), ny0 + int(dy))

        mask = np.zeros((h + 2, w + 2), np.uint8)
        flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
        cv2.floodFill(crop, mask, seed, 0, (16, 16, 16), (16, 16, 16), flags)
        region = mask[1:-1, 1:-1]

        # A bubble must be fully enclosed in the window. Touching any edge
        # means the fill escaped (open bubble, or the click hit background);
        # retry with a larger window, then give up.
        if region[0].any() or region[-1].any() or region[:, 0].any() or region[:, -1].any():
            continue
        area = int(cv2.countNonZero(region))
        if area < 400:
            raise ValueError("no bubble found there — click the empty part of a bubble")
        rys, rxs = np.where(region > 0)
        bw = int(rxs.max()) - int(rxs.min()) + 1
        bh = int(rys.max()) - int(rys.min()) + 1
        # Reject sprawling regions (panel backgrounds, gutters): bubbles are
        # compact and far smaller than the page.
        if max(bw, bh) > 0.75 * W or area < 0.3 * bw * bh:
            raise ValueError("that looks bigger than a bubble — trace it with the lasso instead")

        # Text glyphs are holes in the flooded interior: components of the
        # complement that never reach the window border.
        inv = (region == 0).astype(np.uint8)
        n_labels, labels = cv2.connectedComponents(inv, connectivity=4)
        border = np.unique(
            np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]])
        )
        fill = region.copy()
        fill[(labels > 0) & ~np.isin(labels, border)] = 255
        fill = cv2.erode(fill, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        if not int(cv2.countNonZero(fill)):
            raise ValueError("bubble is too thin to fill")

        colour = np.median(crop[region > 0], axis=0).astype(np.uint8)
        crop[fill > 0] = colour
        img[cy0:cy1, cx0:cx1] = crop
        return "bubble"
    raise ValueError("bubble edge not found — trace it with the lasso instead")


def do_inpaint(req: dict) -> dict:
    """Erase a drawn box or polygon with LaMa-manga. Click-to-fill (mode
    bubble) is the flood-fill wipe; it never reaches this path."""
    import cv2
    import numpy as np

    path = str(req.get("path") or "")
    if not path:
        raise ValueError("missing path")
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    H, W = img.shape[:2]
    mode = str(req.get("mode") or "auto").lower()
    if mode == "bubble":
        method = _bubble_fill(img, req)
        return _write_inpaint(img, req, path, W, H, method)
    poly = _norm_poly(req, W, H)
    if poly is not None:
        x0, y0 = int(poly[:, 0].min()), int(poly[:, 1].min())
        x1, y1 = int(poly[:, 0].max()), int(poly[:, 1].max())
    else:
        x = float(req.get("x") or 0)
        y = float(req.get("y") or 0)
        bw = float(req.get("w") or 0)
        bh = float(req.get("h") or 0)
        if bw <= 0 or bh <= 0:
            raise ValueError("invalid box")
        x0 = int(round(max(0.0, min(1.0, x)) * W))
        y0 = int(round(max(0.0, min(1.0, y)) * H))
        x1 = int(round(max(0.0, min(1.0, x + bw)) * W))
        y1 = int(round(max(0.0, min(1.0, y + bh)) * H))
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0

    x0, x1 = max(0, x0), min(W, x1)
    y0, y1 = max(0, y0), min(H, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        raise ValueError("selection is too small")

    box_w, box_h = x1 - x0, y1 - y0
    # Generous context: LaMa reconstructs from what surrounds the hole.
    pad = int(min(400, max(64, 0.5 * max(box_w, box_h))))
    cx0, cy0 = max(0, x0 - pad), max(0, y0 - pad)
    cx1, cy1 = min(W, x1 + pad), min(H, y1 + pad)
    crop = img[cy0:cy1, cx0:cx1].copy()
    mask = np.zeros(crop.shape[:2], np.uint8)
    if poly is not None:
        local = poly.copy()
        local[:, 0] -= cx0
        local[:, 1] -= cy0
        cv2.fillPoly(mask, [local], 255)
        # Stroke the path too: a trace through glyphs (or a self-crossing
        # loop) can leave fillPoly empty even when the user drew on the text.
        stroke = max(9, min(24, int(round(min(W, H) * 0.006))))
        cv2.polylines(mask, [local], True, 255, stroke, cv2.LINE_8)
    else:
        mask[y0 - cy0 : y1 - cy0, x0 - cx0 : x1 - cx0] = 255
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    if int(cv2.countNonZero(mask)) < 16:
        raise ValueError("selection is too small")

    try:
        crop = _lama_inpaint(crop, mask)
        method = "lama"
        _log(f"inpaint lama: {crop.shape[1]}x{crop.shape[0]} mask={int(cv2.countNonZero(mask))}px")
    except Exception as e:  # model unavailable (offline first run, OOM, …)
        _log(f"lama inpaint failed, using telea: {e}")
        crop = cv2.inpaint(crop, mask, 5, cv2.INPAINT_TELEA)
        method = "inpaint"

    img[cy0:cy1, cx0:cx1] = crop
    return _write_inpaint(img, req, path, W, H, method)


def _write_inpaint(img, req: dict, path: str, W: int, H: int, method: str) -> dict:
    import cv2

    out = str(req.get("out") or path)
    ext = os.path.splitext(out)[1].lower() or ".jpg"
    tmp = f"{out}.tmp{ext}"
    if ext in (".png", ".webp"):
        ok = cv2.imwrite(tmp, img)
    else:
        ok = cv2.imwrite(tmp, img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not ok:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise ValueError("failed to write inpaint")
    os.replace(tmp, out)
    return {"width": W, "height": H, "method": method}


# ---------------------------------------------------------------- loop


def handle(req: dict) -> dict:
    cmd = str(req.get("cmd") or ("ocr" if (req.get("b64") or req.get("path")) else "")).lower()
    if cmd == "ping":
        return {"ready": True}
    if cmd == "detect":
        return do_detect(req)
    if cmd == "ocr":
        return do_ocr(req)
    if cmd == "inpaint":
        return do_inpaint(req)
    if cmd == "warmup":
        what = str(req.get("what") or "ocr").lower()
        if what == "ocr":
            _get_ocr(_paddle_lang(req))
        else:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import detect as D

            with _quiet():
                D._session(D.RTDETR_REPO, D.RTDETR_FILE, D.threads_from_env())
        return {}
    raise ValueError(f"unknown cmd: {cmd or '(none)'}")


def main() -> int:
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except Exception:
        _emit({"ready": False, "error": traceback.format_exc()})
        return 1
    _emit({"ready": True})

    if os.environ.get("SCAN_OCR_EAGER"):
        try:
            _get_ocr(_paddle_lang())
        except Exception:
            _log(traceback.format_exc())

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _emit({"ok": False, "error": f"bad json: {e}"})
            continue
        if str(req.get("cmd", "")).lower() in ("quit", "exit"):
            return 0
        req_id = req.get("id")
        try:
            _emit({"id": req_id, "ok": True, **handle(req)})
        except Exception as e:
            sys.stdout = _REAL_STDOUT
            _emit({"id": req_id, "ok": False, "error": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
