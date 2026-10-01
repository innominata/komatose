"""Region-constrained lettering removal proposals (CTD or Koharu SAM-TS-L)."""
import os

import cv2
import numpy as np

VERSION = 'ctd-regions-v1'
STRONG = 150
WEAK = 65


def resolve_engine(requested='auto'):
    mode = (requested or os.environ.get('SCAN_MASK_ENGINE', 'auto')).strip().lower()
    if mode in ('ctd', 'comic-text-detector'):
        return 'ctd'
    if mode in ('koharu', 'koharu-sam-ts-l', 'sam-ts-l'):
        import koharu_mask
        if not koharu_mask.installed():
            raise RuntimeError('Koharu model missing or checksum mismatch; run scripts/install-koharu.py')
        return 'koharu'
    if mode not in ('auto', '', 'default'):
        raise ValueError(f'Unknown mask engine {requested!r}')
    try:
        import koharu_mask
        return 'koharu' if koharu_mask.installed() else 'ctd'
    except Exception:
        return 'ctd'


def _region_allowed(height, width, poly):
    allowed = np.zeros((height, width), np.uint8)
    vertices = np.array([[round(p['x'] * width), round(p['y'] * height)] for p in poly], np.int32)
    if len(vertices) >= 3:
        cv2.fillPoly(allowed, [vertices], 255)
    return allowed


def _apply_expansion(mask, expansion):
    radius = max(0, min(20, int(expansion)))
    if not radius:
        return mask
    return cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1)))


def _axis_gap(a0, a1, b0, b1):
    if a1 < b0:
        return b0 - a1
    if b1 < a0:
        return a0 - b1
    return 0


def _merge_text_boxes(boxes, gap_frac=0.6, align=0.4):
    """Join glyph boxes into lines. A large sound effect must not set the gap."""
    items = [list(box) for box in boxes]
    for _ in range(8):
        items.sort(key=lambda box: (box[1], box[0]))
        changed = False
        used = [False] * len(items)
        merged = []
        for i, a in enumerate(items):
            if used[i]:
                continue
            used[i] = True
            x0, y0, x1, y1 = a
            for j in range(i + 1, len(items)):
                if used[j]:
                    continue
                b = items[j]
                gx = _axis_gap(x0, x1, b[0], b[2])
                gy = _axis_gap(y0, y1, b[1], b[3])
                wa, wb = max(1, x1 - x0), max(1, b[2] - b[0])
                ha, hb = max(1, y1 - y0), max(1, b[3] - b[1])
                ref = min(min(wa, ha), min(wb, hb))
                ox = max(0, min(x1, b[2]) - max(x0, b[0])) / min(wa, wb)
                oy = max(0, min(y1, b[3]) - max(y0, b[1])) / min(ha, hb)
                near = (gy <= gap_frac * ref and ox >= align and gx <= 1.2 * ref) or (
                    gx <= gap_frac * ref and oy >= align and gy <= 1.2 * ref)
                if gx == 0 and gy == 0:
                    near = True
                if near:
                    x0, y0 = min(x0, b[0]), min(y0, b[1])
                    x1, y1 = max(x1, b[2]), max(y1, b[3])
                    used[j] = True
                    changed = True
            merged.append([x0, y0, x1, y1])
        items = merged
        if not changed:
            break
    return items


def regions_from_mask(mask):
    """Text blocks from a full-page Koharu mask, before any region clip."""
    binary = (mask > 127).astype(np.uint8)
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    parts = []
    for i in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[i])
        if area < 8 or min(w, h) < 2:
            continue
        parts.append([x, y, x + w, y + h])
    height, width = binary.shape[:2]
    page = max(1, height * width)
    regions = []
    for x0, y0, x1, y1 in _merge_text_boxes(parts):
        bw, bh = x1 - x0, y1 - y0
        if bw < 6 or bh < 6 or bw * bh > page * 0.45:
            continue
        if int(np.count_nonzero(binary[y0:y1, x0:x1])) < 16:
            continue
        regions.append({
            'cls': 'text',
            'backend': 'koharu',
            'score': 0.8,
            'box': [float(x0), float(y0), float(x1), float(y1)],
        })
    return regions


def detect_text(image, device='cpu', expansion=3):
    """Full-page Koharu text blocks plus the expanded mask used for OCR crops."""
    import koharu_mask
    if not koharu_mask.installed():
        raise RuntimeError('Koharu model missing or checksum mismatch; run scripts/install-koharu.py')
    raw = koharu_mask.predict(image, device)
    meta = {
        'engine': 'koharu',
        'model': 'Koharu SAM-TS-L',
        'version': koharu_mask.VERSION,
        'backend': koharu_mask.runtime_backend(device),
        'repo': koharu_mask.REPO,
        'revision': koharu_mask.REVISION,
    }
    return regions_from_mask(raw), _apply_expansion(raw, expansion), meta


def _region_diagnostics(index, allowed, clipped, uncertain=False):
    pixels = int(np.count_nonzero(clipped))
    edge = cv2.subtract(
        allowed,
        cv2.erode(allowed, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0),
    )
    reasons = []
    if pixels == 0:
        reasons.append('empty coverage')
    if np.any((edge > 0) & (clipped > 0)):
        reasons.append('boundary clipping')
    if uncertain:
        reasons.append('uncertain components')
    return {'region': index, 'reasons': reasons, 'pixels': pixels}


def propose_koharu(image, regions, expansion=5, device='cpu'):
    import koharu_mask
    raw = koharu_mask.predict(image, device)
    expanded = _apply_expansion(raw, expansion)
    height, width = image.shape[:2]
    result = np.zeros((height, width), np.uint8)
    diagnostics = []
    for index, poly in enumerate(regions):
        allowed = _region_allowed(height, width, poly)
        if not np.any(allowed):
            diagnostics.append({'region': index, 'reasons': ['empty coverage'], 'pixels': 0})
            continue
        clipped = cv2.bitwise_and(expanded, allowed)
        result |= clipped
        diagnostics.append(_region_diagnostics(index, allowed, clipped))
    meta = {
        'engine': 'koharu',
        'version': koharu_mask.VERSION,
        'backend': koharu_mask.runtime_backend(device),
        'repo': koharu_mask.REPO,
        'revision': koharu_mask.REVISION,
    }
    return result, diagnostics, meta


def refine(probability, image, boxes):
    """Hysteresis with text-block support, then bounded outline recovery."""
    support = np.zeros(probability.shape, np.uint8)
    for row in boxes:
        x0, y0, x1, y1 = row['box']
        x0, y0 = max(0, int(x0)-2), max(0, int(y0)-2)
        x1, y1 = min(support.shape[1], int(np.ceil(x1))+2), min(support.shape[0], int(np.ceil(y1))+2)
        if x1 > x0 and y1 > y0:
            support[y0:y1, x0:x1] = 255
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    smooth = cv2.GaussianBlur(gray, (3, 3), .7)
    contrast = cv2.morphologyEx(smooth, cv2.MORPH_BLACKHAT, np.ones((7, 7), np.uint8))
    light = cv2.morphologyEx(smooth, cv2.MORPH_TOPHAT, np.ones((7, 7), np.uint8))
    ink = ((contrast > 18) & (smooth < 125)) | ((light > 18) & (smooth > 240))
    ink |= (np.maximum(contrast, light) > 18) & (probability > 200) & (support > 0)
    weak = ((probability >= WEAK) & ink).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(weak, 8)
    mask = np.zeros_like(support)
    rejected = False
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        component = labels[y:y+h, x:x+w] == i
        p = probability[y:y+h, x:x+w][component]
        supported = support[y:y+h, x:x+w][component] > 0
        # Permit model-confident lettering without a block, but not detached
        # low-confidence screentone fragments or long thin texture bands.
        strong = np.count_nonzero(p >= STRONG)
        thin = max(w, h) > 12*max(1, min(w, h))
        keep = area >= 2 and strong >= max(1, area*.04) and (
            np.mean(supported) >= .5 or (np.mean(p) > 130 and not thin))
        if keep:
            mask[y:y+h, x:x+w][component] = 255
        elif strong:
            rejected = True
    # Restore thick ink interiors lost by the small contrast kernel. Require
    # substantial segmentation support so a letter touching panel art cannot
    # flood through a connected hair strand or border.
    dark = (gray < 125).astype(np.uint8)
    gray_pad = cv2.copyMakeBorder(gray, 2, 2, 2, 2, cv2.BORDER_REPLICATE)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dark, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 3 or w*h > image.shape[0]*image.shape[1]*.15:
            continue
        component = labels[y:y+h, x:x+w] == i
        evidence = probability[y:y+h, x:x+w][component]
        supported_ink = np.mean(evidence >= WEAK) >= .3 and np.any(mask[y:y+h, x:x+w][component])
        # Bold outlined SFX may have segmentation on only one stroke. A bright
        # surrounding halo provides independent evidence for that ink component.
        pad = 2
        local = np.pad(component.astype(np.uint8), pad)
        ring = cv2.dilate(local, np.ones((5,5), np.uint8)) > local
        neighborhood = gray_pad[y:y+h+2*pad, x:x+w+2*pad]
        outlined = (np.mean(evidence >= WEAK) >= .03 and max(w,h) < 12*max(1,min(w,h))
                    and np.mean(neighborhood[ring] > 225) >= .6)
        if supported_ink or outlined:
            mask[y:y+h, x:x+w][component] = 255
    # Recover connected bright outlines only near segmentation evidence.
    # A local halo can join a glyph that segmentation saw only in fragments.
    bright = ((gray > 225) & (cv2.GaussianBlur(gray, (15, 15), 3) < 220)).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bright, 8)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        component = labels[y:y+h, x:x+w] == i
        evidence = probability[y:y+h, x:x+w][component]
        if area >= 12 and max(w,h) < 12*max(1,min(w,h)) and np.max(evidence) >= WEAK and np.mean(smooth[y:y+h, x:x+w][component]) > 225 and w*h < image.shape[0]*image.shape[1]*.15:
            # Bound reconstruction to the contour, including enclosed dark ink.
            local = component.astype(np.uint8)*255
            contours, _ = cv2.findContours(local, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros_like(local)
            cv2.drawContours(filled, contours, -1, 255, -1)
            # Do not fill large holes (balloon interiors or gaps in artwork).
            bounded = cv2.dilate(local, np.ones((7, 7), np.uint8))
            filled[bounded == 0] = 0
            mask[y:y+h, x:x+w] |= filled
    # Tiny detached punctuation is retained only near accepted lettering and
    # with both block and segmentation evidence.
    near = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    mask[(near > 0) & (support > 0) & ink & (probability >= STRONG)] = 255
    return mask, rejected


def propose(image, regions, expansion=5, engine='auto', device='cpu'):
    resolved = resolve_engine(engine)
    if resolved == 'koharu':
        return propose_koharu(image, regions, expansion, device)
    import detect
    height, width = image.shape[:2]
    full_boxes, full_probability = detect.detect_ctd(image, want_mask=True)
    result = np.zeros((height, width), np.uint8)
    diagnostics = []
    for index, poly in enumerate(regions):
        allowed = np.zeros((height, width), np.uint8)
        vertices = np.array([[round(p['x']*width), round(p['y']*height)] for p in poly], np.int32)
        if len(vertices) < 3:
            continue
        cv2.fillPoly(allowed, [vertices], 255)
        ys, xs = np.where(allowed)
        if not len(xs):
            diagnostics.append({'region': index, 'reasons': ['empty coverage'], 'pixels': 0})
            continue
        # Context is essential: resizing a tight word to 1024 destroys the
        # detector's learned scale. At least 128 source pixels surround it.
        cx, cy = (xs.min()+xs.max())/2, (ys.min()+ys.max())/2
        cw, ch = max(128, (xs.max()-xs.min()+1)*1.5), max(128, (ys.max()-ys.min()+1)*1.5)
        left, top = max(0, int(cx-cw/2)), max(0, int(cy-ch/2))
        right, bottom = min(width, int(cx+cw/2)+1), min(height, int(cy+ch/2)+1)
        crop = image[top:bottom, left:right]
        boxes, probability = detect.detect_ctd(crop, want_mask=True)
        probability = np.maximum(probability, full_probability[top:bottom, left:right])
        boxes += [{**b, 'box': [b['box'][0]-left, b['box'][1]-top, b['box'][2]-left, b['box'][3]-top]} for b in full_boxes]
        # Keep only text blocks intersecting the requested region. The crop
        # provides context, never authority to select neighboring artwork.
        clip = allowed[top:bottom, left:right]
        mask, uncertain = refine(probability, crop, boxes)
        radius = max(0, min(20, int(expansion)))
        if radius:
            mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2*radius+1,)*2))
        clipped = cv2.bitwise_and(mask, clip)
        pixels = int(np.count_nonzero(clipped))
        edge = cv2.subtract(clip, cv2.erode(clip, np.ones((3,3), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0))
        reasons = []
        if pixels == 0:
            reasons.append('empty coverage')
        if np.any((edge > 0) & (mask > 0)):
            reasons.append('boundary clipping')
        if uncertain:
            reasons.append('uncertain components')
        diagnostics.append({'region': index, 'reasons': reasons, 'pixels': pixels})
        result[top:bottom, left:right] |= clipped
    meta = {
        'engine': 'ctd',
        'version': VERSION,
        'backend': 'CPU',
        'repo': detect.CTD_REPO,
        'revision': detect.CTD_FILE,
    }
    return result, diagnostics, meta
