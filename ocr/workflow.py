"""Local geometry/mask/clean worker. One request per process; Node queues per device.

All writes target a new artifact. The caller commits it with a revision check.
The optional SAM CUDA extension is disabled both during installation and inference.
"""
import contextlib
import heapq
import importlib.util
import json
import math
import os
import sys
import time
import resource

os.environ['SAM2_BUILD_CUDA'] = '0'
import cv2
import numpy as np

_MODELS = {}


def _cached(key, factory):
    if key not in _MODELS:
        _MODELS[key] = factory()
    return _MODELS[key]


def _friendly_gpu_name(index):
    import torch
    name = torch.cuda.get_device_name(index)
    override = os.environ.get('SCAN_GPU_NAME')
    if override:
        return override
    try:
        mem_gb = torch.cuda.get_device_properties(index).total_memory / (1024 ** 3)
    except Exception:
        mem_gb = 0
    # ROCm 7 often reports discrete RDNA3 as "AMD Radeon Graphics".
    if 'Radeon Graphics' in name and mem_gb >= 20:
        return 'AMD Radeon RX 7900 XTX'
    return name


def probe():
    devices = []
    errors = []
    if importlib.util.find_spec('torch'):
        try:
            import torch
            if torch.cuda.is_available():
                for i in range(torch.cuda.device_count()):
                    # Execute a kernel, not just enumeration, before advertising readiness.
                    with torch.cuda.device(i):
                        assert float((torch.ones(1, device=f'cuda:{i}') + 1).cpu()[0]) == 2
                        free, total = torch.cuda.mem_get_info(i)
                        devices.append({'id': f'cuda:{i}', 'name': _friendly_gpu_name(i), 'backend': 'ROCm' if torch.version.hip else 'CUDA', 'free': free, 'total': total})
            else:
                errors.append('PyTorch cannot execute on a GPU')
        except Exception as e:
            errors.append(str(e))
    else:
        errors.append('Dedicated PyTorch environment is not installed; CPU ONNX is available')
    koharu = False
    try:
        import koharu_mask
        koharu = koharu_mask.installed()
    except Exception:
        koharu = False
    resident = next((key[1] for key in _MODELS if key and key[0] == 'big-lama'), None)
    return {'devices': devices, 'errors': errors, 'sam': bool(importlib.util.find_spec('sam2')),
            'bigLama': bool(importlib.util.find_spec('spandrel')), 'bigLamaDevice': resident,
            'koharu': koharu, 'cpu': True}


def _keep_box_component(mask, box, width, height):
    """Drop leaked background blobs; keep the fill that contains the text box."""
    cx = min(width - 1, max(0, int((box[0] + box[2] / 2) * width)))
    cy = min(height - 1, max(0, int((box[1] + box[3] / 2) * height)))
    n, labels = cv2.connectedComponents((mask > 0).astype(np.uint8))
    if not (0 <= cy < height and 0 <= cx < width):
        return mask
    lab = labels[cy, cx]
    if lab == 0:
        return mask
    return np.uint8(labels == lab) * 255


def polygon(mask, width, height, inset=2, box=None):
    if box is not None:
        mask = _keep_box_component(mask, box, width, height)
        radius = max(3, min(9, int(min(box[2] * width, box[3] * height) * .08)))
    else:
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return []
        _x, _y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))
        radius = max(3, int(min(w, h) * .08))
    # Opening severs thin leaks into the panel before an inset protects the ink.
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)))
    mask = cv2.erode(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (inset * 2 + 1, inset * 2 + 1)))
    if box is not None:
        mask = _keep_box_component(mask, box, width, height)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    contour = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(contour, max(.7, cv2.arcLength(contour, True) * .002), True)
    return [{'x': float(p[0][0]) / width, 'y': float(p[0][1]) / height} for p in approx]


def _ridge_path(binary, dist, start, goal):
    """Maximum-clearance path between two interior pixels, cropped to the mask."""
    ys, xs = np.nonzero(binary)
    if len(xs) == 0:
        return None
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    sub, dsub = binary[y0:y1, x0:x1], dist[y0:y1, x0:x1]
    h, w = sub.shape
    sx, sy = start[0] - x0, start[1] - y0
    gx, gy = goal[0] - x0, goal[1] - y0
    if not (0 <= sx < w and 0 <= sy < h and 0 <= gx < w and 0 <= gy < h):
        return None
    cost = 1.0 / (dsub + .25)
    inf = 1e18
    best = np.full((h, w), inf, np.float64)
    best[sy, sx] = 0
    prev = np.full((h, w, 2), -1, np.int32)
    heap = [(0.0, sx, sy)]
    steps = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    while heap:
        c, x, y = heapq.heappop(heap)
        if c != best[y, x]:
            continue
        if x == gx and y == gy:
            break
        for dx, dy in steps:
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h and sub[ny, nx]):
                continue
            nc = c + cost[ny, nx] * (1.41421356 if dx and dy else 1.0)
            if nc < best[ny, nx]:
                best[ny, nx] = nc
                prev[ny, nx] = (x, y)
                heapq.heappush(heap, (nc, nx, ny))
    if best[gy, gx] >= inf:
        return None
    path = []
    x, y = gx, gy
    while x >= 0:
        path.append((x + x0, y + y0))
        x, y = int(prev[y, x, 0]), int(prev[y, x, 1])
    path.reverse()
    return path


def _connecting_path(binary, dist, start, goal):
    length = max(8, int(math.hypot(goal[0] - start[0], goal[1] - start[1])))
    xs = np.linspace(start[0], goal[0], length)
    ys = np.linspace(start[1], goal[1], length)
    H, W = binary.shape
    pts = []
    for x, y in zip(xs, ys):
        ix, iy = int(round(x)), int(round(y))
        if not (0 <= ix < W and 0 <= iy < H and binary[iy, ix]):
            return _ridge_path(binary, dist, start, goal)
        if not pts or pts[-1] != (ix, iy):
            pts.append((ix, iy))
    return pts


def _neck_index(profile):
    """Deepest pinch along a path, or None when the interior has no constriction."""
    n = len(profile)
    if n < 8:
        return None
    skip0 = min(n // 4, max(2, int(profile[0] * .5)))
    skip1 = min(n // 4, max(2, int(profile[-1] * .5)))
    a, b = skip0, n - skip1
    if b - a < 3:
        return None
    valley = a + int(np.argmin(profile[a:b]))
    left_peak = max(profile[:valley])
    right_peak = max(profile[valley + 1:])
    if profile[valley] < .85 * min(left_peak, right_peak) - .5:
        return valley
    return None


def _turn(p0, p1, p2):
    v1x, v1y = p1[0] - p0[0], p1[1] - p0[1]
    v2x, v2y = p2[0] - p1[0], p2[1] - p1[1]
    n1 = math.hypot(v1x, v1y) or 1.0
    n2 = math.hypot(v2x, v2y) or 1.0
    v1x, v1y, v2x, v2y = v1x / n1, v1y / n1, v2x / n2, v2y / n2
    return math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)


def _segments_cross(a, b, c, d):
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


def _point_seg_dist(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    if length <= 1e-9:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def _path_hits_chord(path, start, goal, p0, p1):
    if _segments_cross(start, goal, p0, p1):
        return True
    if not path or len(path) < 2:
        return False
    for u, v in zip(path, path[1:]):
        if u == v:
            continue
        if _segments_cross(u, v, p0, p1):
            return True
    return False


def _join_chord(mask, start, goal, path=None, neck=None):
    """Outline intersection of two joined bubbles: a chord between concave cusps.

    Pixel-jagged contours are sampled over an edge window so the turn reflects
    the meeting angle of the two outlines, not a 1px stairstep. The pair that
    crosses the centre path is the join; a morphological neck, when present,
    picks among several dents.
    """
    contours, _ = cv2.findContours((mask > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    pts = contour.reshape(-1, 2).astype(np.float64)
    n = len(pts)
    if n < 16:
        return None
    nxt = np.roll(pts, -1, axis=0)
    area = float((pts[:, 0] * nxt[:, 1] - nxt[:, 0] * pts[:, 1]).sum())
    sign = 1.0 if area > 0 else -1.0
    step = max(8, int(cv2.arcLength(contour, True) * .015))
    turns = np.empty(n)
    for i in range(n):
        turns[i] = _turn(pts[(i - step) % n], pts[i], pts[(i + step) % n]) * sign
    thresh = -math.radians(20)
    local = []
    for i in range(n):
        if turns[i] >= thresh:
            continue
        lo = min(turns[(i + k) % n] for k in range(-step, step + 1))
        if turns[i] <= lo + 1e-9:
            local.append(i)
    if len(local) < 2:
        return None
    best = None
    for a in range(len(local)):
        for b in range(a + 1, len(local)):
            i, j = local[a], local[b]
            sep = min((i - j) % n, (j - i) % n)
            if sep < 2 * step:
                continue
            p0, p1 = pts[i], pts[j]
            chord = float(math.hypot(p1[0] - p0[0], p1[1] - p0[1]))
            if chord < 4:
                continue
            if not _path_hits_chord(path, start, goal, p0, p1):
                continue
            if neck is not None:
                score = -_point_seg_dist(neck, p0, p1) + .01 * (-turns[i] - turns[j])
            else:
                score = (-turns[i] - turns[j]) / (chord + 1)
            if best is None or score > best[0]:
                best = (score, (int(round(p0[0])), int(round(p0[1]))),
                        (int(round(p1[0])), int(round(p1[1]))))
    if best is None:
        return None
    return best[1], best[2]


def _cut_chord(mask, p0, p1):
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    length = math.hypot(dx, dy) or 1.0
    ux, uy = dx / length, dy / length
    pad = 3
    a = (int(round(p0[0] - ux * pad)), int(round(p0[1] - uy * pad)))
    b = (int(round(p1[0] + ux * pad)), int(round(p1[1] + uy * pad)))
    cv2.line(mask, a, b, 0, 3)


def _cut_across(mask, origin, tangent):
    """Zero a stroke through origin that reaches just past both local boundaries."""
    px, py = origin
    tx, ty = tangent
    length = math.hypot(tx, ty) or 1.0
    sx, sy = -ty / length, tx / length
    H, W = mask.shape

    def walk(dx, dy):
        x, y = float(px), float(py)
        for _ in range(max(H, W)):
            x += dx
            y += dy
            ix, iy = int(round(x)), int(round(y))
            if not (0 <= ix < W and 0 <= iy < H) or mask[iy, ix] == 0:
                x += dx * 2
                y += dy * 2
                return int(round(x)), int(round(y))
        return int(round(x)), int(round(y))

    cv2.line(mask, walk(sx, sy), walk(-sx, -sy), 0, 3)


def split_interior(mask, box, neighbors):
    """Partition a merged interior where connected bubbles join.

    Centers inside this mask participate; separate enclosed bubbles do not
    affect each other. The cut is the chord between the two concave outline
    cusps (the intersection of the balloons). A morphological neck only
    chooses among several dents. Convex interiors with no cusp fall back to
    the centre bisector. Equal-distance pixels form a gap shared by both.
    """
    H, W = mask.shape
    cx, cy = (box[0] + box[2]/2)*W, (box[1] + box[3]/2)*H
    yy, xx = np.ogrid[:H, :W]
    own = (xx-cx)**2 + (yy-cy)**2
    keep = mask > 0
    split = False
    binary = keep.astype(np.uint8)
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5) if binary.any() else None
    cut = binary * 255
    severed = False
    ox, oy = int(cx), int(cy)
    for other in neighbors:
        nx, ny = (other[0] + other[2]/2)*W, (other[1] + other[3]/2)*H
        if (nx-cx)**2 + (ny-cy)**2 < 1:
            continue
        ix, iy = int(nx), int(ny)
        if not (0 <= ix < W and 0 <= iy < H and mask[iy, ix]):
            continue
        split = True
        path = _connecting_path(binary, dist, (ox, oy), (ix, iy)) if dist is not None else None
        valley = _neck_index([float(dist[y, x]) for x, y in path]) if path and dist is not None else None
        neck = path[valley] if valley is not None else None
        chord = _join_chord(binary, (ox, oy), (ix, iy), path, neck)
        if chord:
            _cut_chord(cut, chord[0], chord[1])
            severed = True
            continue
        if valley is None:
            keep &= own < (xx-nx)**2 + (yy-ny)**2
            continue
        i0, i1 = max(0, valley - 3), min(len(path) - 1, valley + 3)
        tx, ty = path[i1][0] - path[i0][0], path[i1][1] - path[i0][1]
        if tx == 0 and ty == 0:
            tx, ty = nx - cx, ny - cy
        _cut_across(cut, path[valley], (tx, ty))
        severed = True
    if severed:
        _, labels = cv2.connectedComponents((cut > 0).astype(np.uint8))
        own_lab = labels[oy, ox] if 0 <= ox < W and 0 <= oy < H else 0
        if own_lab:
            keep &= labels == own_lab
        for other in neighbors:
            nx, ny = (other[0] + other[2]/2)*W, (other[1] + other[3]/2)*H
            ix, iy = int(nx), int(ny)
            if not (0 <= ix < W and 0 <= iy < H and mask[iy, ix]):
                continue
            if not own_lab or labels[iy, ix] == own_lab:
                keep &= own < (xx-nx)**2 + (yy-ny)**2
    return np.where(keep, mask, 0).astype(np.uint8), split


def _box_probes(box, width, height, inset=.7):
    x, y, w, h = box[0] * width, box[1] * height, box[2] * width, box[3] * height
    cx, cy = x + w / 2, y + h / 2
    pts = [(cx, cy)]
    for px, py in ((x, y), (x + w, y), (x + w, y + h), (x, y + h)):
        pts.append((cx + (px - cx) * inset, cy + (py - cy) * inset))
    return pts


def _contains_probes(contour, probes):
    return all(cv2.pointPolygonTest(contour, (float(x), float(y)), False) >= 0 for x, y in probes)


def _mask_touches_border(mask):
    return bool(mask[0].any() or mask[-1].any() or mask[:, 0].any() or mask[:, -1].any())


def _open_boundary():
    return {'polygon': [], 'confidence': 0, 'uncertain': True,
            'message': 'Open boundary: trace a polygon or use SAM prompts'}


def _roi_from_box(box, width, height, pad, neighbors=None):
    xs = [box[0] * width, (box[0] + box[2]) * width]
    ys = [box[1] * height, (box[1] + box[3]) * height]
    for other in neighbors or []:
        xs += [other[0] * width, (other[0] + other[2]) * width]
        ys += [other[1] * height, (other[1] + other[3]) * height]
    x0 = max(0, int(math.floor(min(xs) - pad)))
    y0 = max(0, int(math.floor(min(ys) - pad)))
    x1 = min(width, int(math.ceil(max(xs) + pad)))
    y1 = min(height, int(math.ceil(max(ys) + pad)))
    cw, ch = x1 - x0, y1 - y0
    if cw < 4 or ch < 4:
        return None
    local = [(box[0] * width - x0) / cw, (box[1] * height - y0) / ch,
             box[2] * width / cw, box[3] * height / ch]
    return (y0, y1, x0, x1), local


def _smallest_enclosing_hole(ink, probes, min_area, max_area):
    contours, hier = cv2.findContours(ink, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hier is None:
        return None
    hier = hier[0]
    best, best_area = None, 1e18
    for i in range(len(contours)):
        if hier[i][3] != -1 or hier[i][2] == -1:
            continue
        j = hier[i][2]
        while j != -1:
            hole = contours[j]
            area = abs(cv2.contourArea(hole))
            if min_area <= area <= max_area and area < best_area and _contains_probes(hole, probes):
                best, best_area = hole, area
            j = hier[j][0]
    if best is None:
        return None
    mask = np.zeros(ink.shape[:2], np.uint8)
    cv2.drawContours(mask, [best], -1, 255, cv2.FILLED)
    return mask


def _ink_thresholds(gray, box):
    """Absolute ink cutoffs, plus one relative to the balloon fill.

    Printed outlines are often mid-grey after scan/AA (≈200) even when they
    look closed. 64–128 miss those strokes; a cutoff a bit darker than the
    interior still treats them as the ring without waiting for a flood leak.
    """
    levels = [64, 96, 128, 160, 192]
    H, W = gray.shape
    x0 = min(W - 1, max(0, int(box[0] * W)))
    y0 = min(H - 1, max(0, int(box[1] * H)))
    x1 = min(W, max(x0 + 1, int((box[0] + box[2]) * W)))
    y1 = min(H, max(y0 + 1, int((box[1] + box[3]) * H)))
    patch = gray[y0:y1, x0:x1]
    if patch.size:
        rel = int(np.percentile(patch, 80)) - 36
        if rel >= 130:
            levels.append(min(220, rel))
    return tuple(sorted(set(levels)))


def _covers_box(mask, box, frac=.45):
    H, W = mask.shape
    x0, y0 = max(0, int(box[0] * W)), max(0, int(box[1] * H))
    x1, y1 = min(W, int((box[0] + box[2]) * W)), min(H, int((box[1] + box[3]) * H))
    patch = mask[y0:y1, x0:x1]
    return bool(patch.size) and np.count_nonzero(patch) >= patch.size * frac


def _best_enclosing_hole(gray, box, probes, min_area, max_area):
    """Smallest closed hole that still covers the text box.

    A dark panel border closes at a low threshold and is found first, while the
    lighter balloon outline only closes later. That first hole follows the panel
    and speed lines. Keep scanning and prefer the tight hole.
    """
    close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    seal = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    best, best_area = None, 1e18
    for t in _ink_thresholds(gray, box):
        ink = cv2.morphologyEx(np.uint8(gray < t) * 255, cv2.MORPH_CLOSE, close)
        for sealed in (ink, cv2.dilate(ink, seal)):
            mask = _smallest_enclosing_hole(sealed, probes, min_area, max_area)
            if mask is None or _mask_touches_border(mask) or not _covers_box(mask, box):
                continue
            area = int(np.count_nonzero(mask))
            if area < best_area:
                best, best_area = mask, area
    return best


def ring_interior(gray, box):
    """Fill the hole of a continuous ink ring that encloses the text box.

    Screen-tone dots and lettering are separate components, so they are not
    treated as the bubble border. Returns None when no closed ring is found.
    A second pass dilates dark strokes so anti-aliased gaps in thick outlines
    cannot open the ring into the panel. The hole may fill most of a tight
    search window; the page-level 40% cap lives in geometry().
    """
    H, W = gray.shape
    probes = _box_probes(box, W, H)
    min_area = max(400, box[2] * box[3] * W * H * .8)
    max_area = H * W * .85
    found = _best_enclosing_hole(gray, box, probes, min_area, max_area)
    if found is not None:
        return found
    # Existing/editable text boxes can extend beyond an oval. A centre-only
    # probe is safe here because the final filled shape must still cover a
    # substantial part of the text region and pass the enclosure checks.
    return _best_enclosing_hole(gray, box, probes[:1],
                                max(64, box[2] * box[3] * W * H * .45), max_area)


def _fill_component(mask):
    """Fill holes in one component so white lettering does not split a black balloon."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    if contours:
        cv2.drawContours(filled, [max(contours, key=cv2.contourArea)], -1, 255, cv2.FILLED)
    return filled


def _dark_balloon(gray, box):
    """A solid black balloon is the ink, not a hole inside it.

    White lettering punches holes through that ink, so the outer silhouette is
    the balloon. Light interiors never reach this path.
    """
    H, W = gray.shape
    x0, y0 = max(0, int(box[0] * W)), max(0, int(box[1] * H))
    x1, y1 = min(W, max(x0 + 1, int((box[0] + box[2]) * W))), min(H, max(y0 + 1, int((box[1] + box[3]) * H)))
    patch = gray[y0:y1, x0:x1]
    if not patch.size or np.median(patch) > 140 or np.count_nonzero(patch < 80) < patch.size * .3:
        return None
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    best, best_area = None, 1e18
    box_area = patch.size
    for t in (60, 80, 100):
        dark = np.uint8(gray < t)
        count, labels, _, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
        chosen = None
        overlap = 0
        for i in range(1, count):
            hit = int(np.count_nonzero(labels[y0:y1, x0:x1] == i))
            if hit > overlap:
                chosen, overlap = i, hit
        if chosen is None or overlap < box_area * .25:
            continue
        comp = np.uint8(labels == chosen) * 255
        raw = int(np.count_nonzero(comp))
        comp = cv2.morphologyEx(comp, cv2.MORPH_CLOSE, kernel)
        filled = _fill_component(comp)
        # Screentone is a lace of specks. Closing it paints a blob, but the ink
        # itself still covers only about half of that silhouette.
        if raw < max(1, int(np.count_nonzero(filled))) * .72:
            continue
        if _mask_touches_border(filled) or not _plausible_interior(filled, box, gray):
            continue
        area = int(np.count_nonzero(filled))
        if area < best_area:
            best, best_area = filled, area
    return best


def _seed_xy(gray, box, points=None):
    H, W = gray.shape
    if points:
        x = min(W - 1, max(0, int(points[0]['x'] * W)))
        y = min(H - 1, max(0, int(points[0]['y'] * H)))
    else:
        x = min(W - 1, max(0, int((box[0] + box[2] / 2) * W)))
        y = min(H - 1, max(0, int((box[1] + box[3] / 2) * H)))
    x0, y0 = max(0, x - 12), max(0, y - 12)
    patch = gray[y0:min(H, y + 13), x0:min(W, x + 13)]
    dy, dx = np.unravel_index(int(np.argmax(patch)), patch.shape)
    return x0 + int(dx), y0 + int(dy)


def _outline_barriers(gray, seed):
    """Dilated dark strokes, ignoring screentone specks that would merge into a wall."""
    H, W = gray.shape
    sx, sy = seed
    ink = np.uint8(gray < max(0, int(gray[sy, sx]) - 18))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    walls = np.zeros((H, W), np.uint8)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 60:
            walls[labels == i] = 1
    walls = cv2.dilate(walls, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    walls[sy, sx] = 0
    return walls


def _flood_enclosed(gray, box, points=None):
    """Flood the bright interior, stopping at sealed thick outlines instead of walking through them."""
    H, W = gray.shape
    sx, sy = _seed_xy(gray, box, points)
    ff = np.zeros((H + 2, W + 2), np.uint8)
    ff[1:-1, 1:-1] = _outline_barriers(gray, (sx, sy))
    bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    cv2.floodFill(bgr, ff, (sx, sy), 0, (14,) * 3, (14,) * 3,
                  4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8))
    interior = np.uint8(ff[1:-1, 1:-1] == 255) * 255
    if (not interior.any() or _mask_touches_border(interior)
            or np.count_nonzero(interior) > H * W * .4
            or np.count_nonzero(interior) < 400):
        return None
    contours, _ = cv2.findContours(interior, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(interior, contours, -1, 255, cv2.FILLED)
    return interior


def _plausible_interior(mask, box, gray=None):
    """Reject lettering holes and floods following artwork instead of a balloon.

    Test the filled outline, so actual text and screentone inside a balloon
    do not penalize it. Text selections may include margins outside the ring.
    """
    H, W = mask.shape
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return False
    contour = max(contours, key=cv2.contourArea)
    area = cv2.contourArea(contour)
    hull_area = cv2.contourArea(cv2.convexHull(contour))
    if area < 64 or area < hull_area * .92:
        return False
    x0, y0 = max(0, int(box[0]*W)), max(0, int(box[1]*H))
    x1, y1 = min(W, int((box[0]+box[2])*W)), min(H, int((box[1]+box[3])*H))
    patch = mask[y0:y1, x0:x1]
    if not patch.size or np.count_nonzero(patch) < patch.size * .45:
        return False
    if gray is not None and area > patch.size * 3:
        inner = cv2.erode(mask, np.ones((7, 7), np.uint8))
        inner[y0:y1, x0:x1] = 0
        ink = np.uint8((gray < 160) & (inner > 0))
        n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=4)
        _, _, mw, mh = cv2.boundingRect(contour)
        large_ink = sum(stats[i, cv2.CC_STAT_AREA] for i in range(1, n)
                        if stats[i, cv2.CC_STAT_AREA] > 60 and
                        (stats[i, cv2.CC_STAT_WIDTH] > mw * .6 or
                         stats[i, cv2.CC_STAT_HEIGHT] > mh * .6))
        if large_ink > max(1, np.count_nonzero(inner)) * .12:
            return False
    return True


def geometry_result(mask, req, confidence):
    H, W = mask.shape
    box = req.get('box', [0, 0, 1, 1])
    mask, split = split_interior(mask, box, req.get('neighbors', []))
    poly = polygon(mask, W, H, box=box)
    return {'polygon': poly, 'confidence': min(confidence, .85) if split else confidence,
            'uncertain': split or confidence < .9, 'split': split}


def geometry(img, req):
    H, W = img.shape[:2]
    box = req.get('box', [0, 0, 1, 1])
    if req.get('kind') == 'free' and req.get('method') != 'split':
        return _open_boundary()
    if req.get('method') == 'split':
        points = req.get('polygon', [])
        mask = np.zeros((H, W), np.uint8)
        if len(points) < 3 or req.get('kind') == 'free':
            return {'polygon': points, 'split': False}
        vertices = np.array([[round(p['x']*W), round(p['y']*H)] for p in points], np.int32)
        cv2.fillPoly(mask, [vertices], 255)
        divided, split = split_interior(mask, box, req.get('neighbors', []))
        return {'polygon': polygon(divided, W, H, box=box) if split else points,
                'split': split, 'confidence': .85, 'uncertain': split}
    if req.get('method') == 'sam':
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        from huggingface_hub import hf_hub_download
        device = req.get('device', 'cpu')
        checkpoint = os.environ.get('SCAN_SAM_CHECKPOINT') or hf_hub_download('facebook/sam2.1-hiera-small', 'sam2.1_hiera_small.pt')
        model = _cached(('sam', device), lambda: build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', checkpoint, device=device, apply_postprocessing=False))
        predictor = SAM2ImagePredictor(model, max_hole_area=0, max_sprinkle_area=0)
        pts = list(req.get('points') or [])
        if not pts:
            bx, by, bw, bh = box
            pts = [{'x': bx + bw / 2, 'y': by + bh / 2, 'label': 1}]
        with torch.inference_mode():
            predictor.set_image(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
            masks, scores, _ = predictor.predict(box=np.array([box[0]*W, box[1]*H, (box[0]+box[2])*W, (box[1]+box[3])*H]), point_coords=np.array([[p['x']*W, p['y']*H] for p in pts]) if pts else None, point_labels=np.array([p.get('label', 1) for p in pts]) if pts else None, multimask_output=True)
        best = int(np.argmax(scores))
        return geometry_result(masks[best].astype(np.uint8)*255, req, float(scores[best]))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    neighbors = req.get('neighbors') or []
    pad0 = max(box[2] * W, box[3] * H, 48)
    interior = None
    from_ring = False
    for scale in (1.15, 1.8, 2.6):
        roi = _roi_from_box(box, W, H, pad0 * scale, neighbors)
        if roi is None:
            continue
        (y0, y1, x0, x1), local = roi
        crop = gray[y0:y1, x0:x1]
        points = None
        if req.get('points'):
            cw, ch = x1 - x0, y1 - y0
            points = [{'x': (p['x'] * W - x0) / cw, 'y': (p['y'] * H - y0) / ch}
                      for p in req['points']]
        found = ring_interior(crop, local)
        sealed = found is not None
        if found is None:
            found = _flood_enclosed(crop, local, points)
        if found is None:
            found = _dark_balloon(crop, local)
        if found is None or _mask_touches_border(found):
            continue
        interior = np.zeros((H, W), np.uint8)
        interior[y0:y1, x0:x1] = found
        divided, _ = split_interior(interior, box, neighbors)
        if not _plausible_interior(divided, box, gray):
            interior = None
            continue
        from_ring = sealed
        break
    if interior is None or _mask_touches_border(interior):
        return _open_boundary()
    # Floods that cover the page escaped the balloon. A closed ring may fill
    # most of a tight crop of that balloon; keep it.
    if not from_ring and np.count_nonzero(interior) > H * W * .4:
        return _open_boundary()
    return geometry_result(interior, req, .85)


def _fill_seeds(gray, x, y, reach=10):
    """Click, the solid colour around it, then the light and dark extremes.

    A glyph is a speck in that window. The surrounding solid — white, black, or
    any other flat fill — is the balloon.
    """
    H, W = gray.shape
    y0, x0 = max(0, y - reach), max(0, x - reach)
    y1, x1 = min(H, y + reach + 1), min(W, x + reach + 1)
    nb = gray[y0:y1, x0:x1]
    nearest = np.abs(nb.astype(np.float32) - float(np.median(nb)))
    med_y, med_x = np.unravel_index(int(np.argmin(nearest)), nb.shape)
    bright_y, bright_x = np.unravel_index(int(np.argmax(nb)), nb.shape)
    dark_y, dark_x = np.unravel_index(int(np.argmin(nb)), nb.shape)
    seeds = [(x, y), (x0 + int(med_x), y0 + int(med_y)),
             (x0 + int(bright_x), y0 + int(bright_y)),
             (x0 + int(dark_x), y0 + int(dark_y))]
    unique = []
    for seed in seeds:
        if seed not in unique:
            unique.append(seed)
    return unique


def _border_contrast(img, region):
    """How different the outer border is from the solid fill, as a fraction of 255.

    The first pixel outside the fill is the anti-aliased fringe. The border is
    the band just past that fringe.
    """
    fringe = cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    outer = cv2.dilate(region, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    band = (outer > 0) & (fringe == 0)
    if not band.any():
        band = (fringe > 0) & (region == 0)
    if not band.any() or not region.any():
        return 0.0
    interior = np.median(img[region > 0], axis=0)
    border = np.median(img[band], axis=0)
    return float(np.max(np.abs(border.astype(np.float32) - interior.astype(np.float32)))) / 255.0


def _bridge_split_fill(img, region, reach=10):
    """Pull back solid fill that lettering has split off, then close across that stroke.

    A glyph drawn in the outline colour can separate a cap of the same fill and
    still touch the border, so it is not a hole. The gap matches the outline.
    A piece that runs out of the local window is the rest of the page.
    """
    if not np.any(region):
        return region
    H, W = region.shape
    ys, xs = np.where(region > 0)
    span = reach * 5
    y0, y1 = max(0, int(ys.min()) - span), min(H, int(ys.max()) + 1 + span)
    x0, x1 = max(0, int(xs.min()) - span), min(W, int(xs.max()) + 1 + span)
    crop = img[y0:y1, x0:x1]
    local = region[y0:y1, x0:x1]
    interior = np.median(img[region > 0], axis=0)
    fringe = cv2.dilate(local, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    outer = cv2.dilate(local, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    band = (outer > 0) & (fringe == 0)
    if not np.any(band):
        return region
    border = np.median(crop[band], axis=0)
    same = (np.max(np.abs(crop.astype(np.int16) - interior.astype(np.int16)), axis=2) <= 16).astype(np.uint8)
    dist = cv2.distanceTransform((local == 0).astype(np.uint8), cv2.DIST_L2, 3)
    count, labels = cv2.connectedComponents(same, connectivity=4)
    edge = np.zeros(local.shape, np.uint8)
    edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = 255
    parts = local.copy()
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (reach * 2 + 1, reach * 2 + 1))
    for label in range(1, count):
        comp = labels == label
        if np.any(comp & (local > 0)):
            continue
        area = int(comp.sum())
        if area < 8 or area > int(cv2.countNonZero(local)) * 8:
            continue
        if np.any(comp & (edge > 0)) or float(dist[comp].min()) > reach:
            continue
        piece = comp.astype(np.uint8)
        gap = (cv2.dilate(local, kernel) > 0) & (cv2.dilate(piece, kernel) > 0) & (local == 0) & ~comp
        if int(gap.sum()) < 3:
            continue
        med = np.median(crop[gap], axis=0)
        to_border = float(np.max(np.abs(med - border)))
        to_fill = float(np.max(np.abs(med - interior)))
        if to_border < to_fill and to_fill / 255.0 >= 0.4:
            parts[comp] = 255
    if cv2.countNonZero(parts) == cv2.countNonZero(local):
        return region
    closed = cv2.morphologyEx(parts, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return region
    contour = max(contours, key=cv2.contourArea)
    hull = cv2.contourArea(cv2.convexHull(contour))
    if hull <= 0 or cv2.contourArea(contour) / hull < 0.75:
        return region
    merged = region.copy()
    merged[y0:y1, x0:x1] = np.maximum(merged[y0:y1, x0:x1], closed)
    return merged


def bubble_fill(img, req):
    """Flood-fill a speech bubble from a clicked point.

    The interior may be any solid colour. Grow across that colour, stop at a
    border at least 75% different, fill enclosed text holes, then contract so
    the outline is untouched. Mutates img.
    """
    H, W = img.shape[:2]
    sx = int(round(max(0.0, min(1.0, float(req.get("px", 0)))) * W))
    sy = int(round(max(0.0, min(1.0, float(req.get("py", 0)))) * H))
    saw_enclosed = False
    saw_sprawl = False

    for radius in (512, 1024):
        cx0, cy0 = max(0, sx - radius), max(0, sy - radius)
        cx1, cy1 = min(W, sx + radius), min(H, sy + radius)
        crop = img[cy0:cy1, cx0:cx1]
        h, w = crop.shape[:2]
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
        for seed in _fill_seeds(gray, sx - cx0, sy - cy0):
            work = crop.copy()
            mask = np.zeros((h + 2, w + 2), np.uint8)
            cv2.floodFill(work, mask, seed, 0, (16, 16, 16), (16, 16, 16), flags)
            region = mask[1:-1, 1:-1]
            # Touching the window means the fill escaped. A larger window may
            # still enclose it.
            if region[0].any() or region[-1].any() or region[:, 0].any() or region[:, -1].any():
                continue
            area = int(cv2.countNonZero(region))
            if area < 400:
                continue
            rys, rxs = np.where(region > 0)
            bw = int(rxs.max()) - int(rxs.min()) + 1
            bh = int(rys.max()) - int(rys.min()) + 1
            if max(bw, bh) > 0.75 * W or area < 0.3 * bw * bh:
                saw_sprawl = True
                continue
            saw_enclosed = True
            if _border_contrast(work, region) < 0.75:
                continue
            # Lettering in the outline colour can split the fill and still touch
            # the border. Join those pieces before filling the holes.
            region = _bridge_split_fill(work, region)

            # Text glyphs are holes in the flooded interior: components of the
            # complement that never reach the window border.
            inv = (region == 0).astype(np.uint8)
            _, labels = cv2.connectedComponents(inv, connectivity=4)
            border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
            fill = region.copy()
            fill[(labels > 0) & ~np.isin(labels, border)] = 255
            fill = cv2.erode(fill, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
            if not int(cv2.countNonZero(fill)):
                raise ValueError("bubble is too thin to fill")

            colour = np.median(work[region > 0], axis=0).astype(np.uint8)
            work[fill > 0] = colour
            img[cy0:cy1, cx0:cx1] = work
            return "bubble"
    if saw_sprawl and not saw_enclosed:
        raise ValueError("that looks bigger than a bubble — trace it with the lasso instead")
    if saw_enclosed:
        raise ValueError("no bubble found there — the border needs to differ from the fill by at least 75%")
    raise ValueError("bubble edge not found — click inside a closed bubble")


def grow_radius(req):
    """Grow amount in px. `grow: true` is the legacy 1px behaviour."""
    grow = req.get('grow')
    if isinstance(grow, bool) or not isinstance(grow, (int, float)):
        return 1
    return max(1, min(50, int(round(float(grow)))))


def grow_mask_at(mask, px, py, radius=1):
    """Dilate only the connected mask component under a click, by `radius` px."""
    if px is None or py is None:
        raise ValueError("Click a painted mask region to grow it")
    radius = max(1, int(radius))
    H, W = mask.shape
    x = min(W - 1, max(0, int(round(float(px) * W))))
    y = min(H - 1, max(0, int(round(float(py) * H))))
    binary = (mask > 127).astype(np.uint8)
    if binary[y, x] == 0:
        # A thin leftover border is only a few pixels wide, so keep enough
        # neighbourhood for clicks that land beside it at reduced zoom.
        search = max(8, radius)
        y0, x0 = max(0, y - search), max(0, x - search)
        patch = binary[y0:min(H, y + search + 1), x0:min(W, x + search + 1)]
        ys, xs = np.where(patch > 0)
        if not len(xs):
            raise ValueError("Click a painted mask region to grow it")
        nearest = int(np.argmin((ys + y0 - y) ** 2 + (xs + x0 - x) ** 2))
        y, x = int(ys[nearest] + y0), int(xs[nearest] + x0)
    _, labels = cv2.connectedComponents(binary, connectivity=8)
    label = int(labels[y, x])
    if label == 0:
        raise ValueError("Click a painted mask region to grow it")
    component = np.where(labels == label, 255, 0).astype(np.uint8)
    grown = cv2.dilate(component, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius * 2 + 1,) * 2))
    return np.maximum(mask, grown)


def removal_mask(img, req):
    H, W = img.shape[:2]
    if req.get('detect'):
        allowed = np.zeros((H, W), np.uint8)
        for region in req.get('regions', []):
            if len(region) >= 3:
                vertices = np.array([[round(p['x']*W), round(p['y']*H)] for p in region], np.int32)
                # Fill separately so overlapping regions form a union, not holes.
                cv2.fillPoly(allowed, [vertices], 255)
        if not np.any(allowed):
            raise ValueError('Define a region before detecting a removal mask')
        from lettering import propose, resolve_engine
        engine = req.get('maskEngine', 'auto')
        mask, diagnostics, meta = propose(
            img, req['regions'], req.get('expansion', 5), engine=engine, device=req.get('device', 'cpu'))
        req['_maskDiagnostics'] = diagnostics
        req['_maskMeta'] = meta
        req['_requestedMaskEngine'] = engine
    elif req.get('mask'):
        mask = cv2.imread(req['mask'], cv2.IMREAD_GRAYSCALE)
        if mask is None or mask.shape != (H,W):
            raise ValueError('Removal mask dimensions do not match prepared source')
    else:
        mask = np.zeros((H,W), np.uint8)
    # Automatic proposals already include padding; saved masks never expand.
    for stroke in req.get('strokes', []):
        points = np.array([[min(W-1,max(0,int(p['x']*W))),min(H-1,max(0,int(p['y']*H)))] for p in stroke['points']],np.int32)
        radius = max(1, min(200, int(stroke['radius'])))
        color = 0 if stroke.get('erase') else 255
        if len(points) > 1:
            cv2.polylines(mask, [points], False, color, radius*2, cv2.LINE_8)
        for p in points:
            cv2.circle(mask, tuple(p), radius, color, -1)
    if req.get('detect'):
        # Clip the complete proposal, including padding and any supplied strokes.
        mask = cv2.bitwise_and(mask, allowed)
    return (mask>127).astype(np.uint8)*255


def model_inpaint(img, mask, method, device):
    from huggingface_hub import hf_hub_download
    h, w = img.shape[:2]
    scale = min(1, 1024/max(h,w))
    small = cv2.resize(img, (max(8,int(w*scale)),max(8,int(h*scale)))) if scale < 1 else img
    sm = cv2.resize(mask, (small.shape[1],small.shape[0]), interpolation=cv2.INTER_NEAREST)
    sh, sw = small.shape[:2]
    small = cv2.copyMakeBorder(small,0,(-sh)%8,0,(-sw)%8,cv2.BORDER_REFLECT)
    sm = cv2.copyMakeBorder(sm,0,(-sh)%8,0,(-sw)%8,cv2.BORDER_CONSTANT)
    if method == 'lama':
        import worker
        result = worker._lama_run(small, sm)
    else:
        x = np.ascontiguousarray(small[:,:,::-1].transpose(2,0,1))[None].astype(np.float32)/255
        m = (sm>0).astype(np.float32)[None,None]
        if method == 'aot' and device == 'cpu':
            import onnxruntime as ort
            session = _cached(('aot-onnx', 'cpu'), lambda: ort.InferenceSession(hf_hub_download('ogkalu/aot-inpainting','aot.onnx'), providers=['CPUExecutionProvider']))
            inputs = session.get_inputs()
            # AOT's traced interface consumes RGB in [-1,1] and a 1=remove mask.
            result = session.run(None,{inputs[0].name:(x*2-1)*(1-m),inputs[1].name:m})[0]
            result = (result+1)/2
        else:
            import torch
            if method == 'aot':
                model = _cached(('aot', device), lambda: torch.jit.load(hf_hub_download('ogkalu/aot-inpainting','aot_traced.pt'), map_location=device).eval())
                with torch.inference_mode():
                    result = (model(torch.from_numpy((x*2-1)*(1-m)).to(device),torch.from_numpy(m).to(device)).cpu().numpy()+1)/2
            elif method == 'big-lama':
                from spandrel import ModelLoader
                def load_big_lama():
                    path = os.environ.get('SCAN_BIG_LAMA_CHECKPOINT') or hf_hub_download('dreMaz/AnimeMangaInpainting','lama_large_512px.ckpt')
                    state = torch.load(path, map_location='cpu', weights_only=True)
                    state = state.get('gen_state_dict', state.get('state_dict', state))
                    # The manga checkpoint contains the generator only; Spandrel expects its wrapper prefix.
                    state = {('generator.'+k if k.startswith('model.') else k): v for k, v in state.items()}
                    return ModelLoader().load_from_state_dict(state).to(device).eval()
                model = _cached(('big-lama', device), load_big_lama)
                with torch.inference_mode():
                    result = model(torch.from_numpy(x).to(device),torch.from_numpy(m).to(device)).cpu().numpy()
            else:
                raise ValueError('Unknown inpainting model')
        result = np.clip(result[0].transpose(1,2,0)*255,0,255).astype(np.uint8)[:,:,::-1]
    return cv2.resize(result[:sh,:sw], (w,h), interpolation=cv2.INTER_CUBIC)


def balloon_fills(img, mask):
    """Find enclosed light interiors, retaining text holes but excluding borders.

    Test original connected mask areas in full before any proximity grouping:
    a stroke crossing a balloon outline must remain an inpainting selection.
    """
    light = (np.min(img, axis=2) >= 220).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(light, connectivity=4)
    interiors = np.zeros(mask.shape, np.int32)
    colors = {}
    H, W = mask.shape
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if x == 0 or y == 0 or x+w == W or y+h == H or area < 64:
            continue
        local = (labels[y:y+h, x:x+w] == i).astype(np.uint8)
        contours, _ = cv2.findContours(local, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        inside = np.zeros_like(local)
        cv2.drawContours(inside, contours, -1, 1, cv2.FILLED)
        # Reject texture islands and gradients, while tolerating antialiasing.
        samples = img[y:y+h, x:x+w][local > 0]
        color = np.median(samples, axis=0)
        if area < np.count_nonzero(inside) * .6 or np.max(np.percentile(np.abs(samples.astype(float)-color), 90, axis=0)) > 8:
            continue
        interiors[y:y+h, x:x+w][inside > 0] = i
        colors[i] = color.astype(np.uint8)
    count, selections, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    for i in range(1, count):
        x, y, w, h, _ = stats[i]
        selected = selections[y:y+h, x:x+w] == i
        ids = np.unique(interiors[y:y+h, x:x+w][selected])
        if len(ids) == 1 and ids[0] in colors:
            yield (slice(y, y+h), slice(x, x+w)), selected, colors[ids[0]]


def clean(img, mask, req):
    if not mask.any():
        raise ValueError('The approved removal mask is empty')
    result = img.copy()
    method = req.get('method','auto')
    if method == 'clone':
        dx, dy = req.get('offset', [0,0])
        ys, xs = np.where(mask>0)
        sx, sy = xs+int(dx), ys+int(dy)
        if sx.min()<0 or sy.min()<0 or sx.max()>=img.shape[1] or sy.max()>=img.shape[0]:
            raise ValueError('Clone source extends outside the page')
        if mask[sy,sx].any():
            raise ValueError('Clone source overlaps the removal mask')
        result[ys,xs]=img[sy,sx]
        return result, 'clone'
    methods = set()
    if method == 'auto':
        remaining = mask.copy()
        for bounds, selected, color in balloon_fills(img, mask):
            result[bounds][selected] = color
            remaining[bounds][selected] = 0
            methods.add('flat')
        mask = remaining
        if not mask.any():
            return result, 'flat'
    # Work locally around nearby lettering, keeping large strips bounded in memory.
    grouped = cv2.dilate(mask, np.ones((31,31),np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(grouped)
    for i in range(1,n):
        x,y,w,h,_ = stats[i]
        x0,y0,x1,y1=max(0,x-64),max(0,y-64),min(img.shape[1],x+w+64),min(img.shape[0],y+h+64)
        crop = img[y0:y1,x0:x1]
        m = np.where(labels[y0:y1,x0:x1]==i,mask[y0:y1,x0:x1],0).astype(np.uint8)
        ring = (cv2.dilate(m,np.ones((9,9),np.uint8))>0)&(mask[y0:y1,x0:x1]==0)
        samples = crop[ring]
        selected = 'lama' if method == 'auto' else method
        if method == 'auto' and str(req.get('device', 'cpu')).startswith('cuda'):
            selected = 'big-lama'
        if selected == 'flat':
            if len(samples)<5: raise ValueError('No background samples; refine the removal mask')
            fill = np.broadcast_to(np.median(samples,axis=0).astype(np.uint8),crop.shape)
        elif selected == 'telea':
            fill = cv2.inpaint(crop,m,3,cv2.INPAINT_TELEA)
        else:
            fill = model_inpaint(crop,m,selected,req.get('device','cpu'))
        result[y0:y1,x0:x1][m>0] = fill[m>0]
        methods.add(selected)
    # Exact invariant, even if model output changes pixels outside the selection.
    return result, '+'.join(sorted(methods))


def warmup(device):
    """Load SAM, AOT, Big-LaMa, and LaMa once so later page jobs stay warm."""
    import torch
    from huggingface_hub import hf_hub_download

    def load_big_lama():
        from spandrel import ModelLoader
        path = os.environ.get('SCAN_BIG_LAMA_CHECKPOINT') or hf_hub_download('dreMaz/AnimeMangaInpainting','lama_large_512px.ckpt')
        state = torch.load(path, map_location='cpu', weights_only=True)
        state = state.get('gen_state_dict', state.get('state_dict', state))
        state = {('generator.'+k if k.startswith('model.') else k): v for k, v in state.items()}
        return ModelLoader().load_from_state_dict(state).to(device).eval()

    def load_sam():
        from sam2.build_sam import build_sam2
        checkpoint = os.environ.get('SCAN_SAM_CHECKPOINT') or hf_hub_download('facebook/sam2.1-hiera-small', 'sam2.1_hiera_small.pt')
        return build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', checkpoint, device=device, apply_postprocessing=False)

    def load_aot():
        return torch.jit.load(hf_hub_download('ogkalu/aot-inpainting','aot_traced.pt'), map_location=device).eval()

    def load_lama():
        import worker
        return worker._get_lama()

    # Big-LaMa first, and isolate each failure: one optional model must not
    # stop the cleaner the user selected from becoming GPU-resident.
    loaders = (
        ('big-lama', lambda: _cached(('big-lama', device), load_big_lama)),
        ('aot', lambda: _cached(('aot', device), load_aot)),
        ('sam', lambda: _cached(('sam', device), load_sam)),
        ('lama', load_lama),
    )
    warm, failed = [], {}
    for name, load in loaders:
        try:
            load()
            warm.append(name)
        except Exception as e:
            failed[name] = f'{type(e).__name__}: {e}'
    if str(device).startswith('cuda'):
        torch.cuda.synchronize(device)
    return {'warm': warm, 'failed': failed, 'device': device,
            'bigLamaDevice': device if 'big-lama' in warm else None}


def _brush_pixels(points, width, height):
    out = []
    prev = None
    for point in points:
        x = min(width - 1, max(0, int(round(float(point['x']) * width))))
        y = min(height - 1, max(0, int(round(float(point['y']) * height))))
        if prev is None:
            out.append((x, y))
        else:
            steps = max(1, int(round(math.hypot(x - prev[0], y - prev[1]))))
            for i in range(1, steps + 1):
                t = i / steps
                out.append((int(round(prev[0] + (x - prev[0]) * t)),
                            int(round(prev[1] + (y - prev[1]) * t))))
        prev = (x, y)
    return out


def _copy_circle(src, dst, sx, sy, dx, dy, radius):
    H, W = src.shape[:2]
    x0, y0 = max(0, dx - radius), max(0, dy - radius)
    x1, y1 = min(W, dx + radius + 1), min(H, dy + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return
    yy, xx = np.indices((y1 - y0, x1 - x0))
    yy += y0
    xx += x0
    src_x = xx + (sx - dx)
    src_y = yy + (sy - dy)
    keep = ((xx - dx) ** 2 + (yy - dy) ** 2 <= radius ** 2) & (src_x >= 0) & (src_x < W) & (src_y >= 0) & (src_y < H)
    dst[yy[keep], xx[keep]] = src[src_y[keep], src_x[keep]]


def _feather_kernel(radius):
    r = max(1, int(radius))
    yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
    dist = np.sqrt((xx * xx + yy * yy).astype(np.float32))
    t = np.clip(dist / float(r), 0.0, 1.0)
    return (1.0 - t * t * (3.0 - 2.0 * t)).astype(np.float32)


def _stamp_feather(mask, x, y, kernel):
    r = kernel.shape[0] // 2
    H, W = mask.shape
    x0, y0 = x - r, y - r
    x1, y1 = x + r + 1, y + r + 1
    kx0 = ky0 = 0
    kx1, ky1 = kernel.shape[1], kernel.shape[0]
    if x0 < 0:
        kx0 = -x0
        x0 = 0
    if y0 < 0:
        ky0 = -y0
        y0 = 0
    if x1 > W:
        kx1 -= x1 - W
        x1 = W
    if y1 > H:
        ky1 -= y1 - H
        y1 = H
    if x0 >= x1 or y0 >= y1:
        return
    roi = mask[y0:y1, x0:x1]
    np.maximum(roi, kernel[ky0:ky1, kx0:kx1], out=roi)


def _blur_sigma(radius):
    return max(0.8, float(radius) * 0.5)


def blur_brush(img, req):
    """Soft blur stamp: blend a Gaussian of the page through a feathered brush.

    Samples a snapshot so a stroke does not blur its own output. Coverage falls
    from full at the centre to none at the brush edge, so inpainted patches
    melt into a surrounding gradient instead of leaving a hard disc.
    """
    H, W = img.shape[:2]
    strokes = req.get('strokes') or []
    if not strokes:
        raise ValueError('Paint with the blur brush')
    src = img.copy()
    out = img.astype(np.float32)
    painted = 0
    for stroke in strokes:
        radius = max(1, min(200, int(stroke.get('radius', 8))))
        kernel = _feather_kernel(radius)
        mask = np.zeros((H, W), np.float32)
        for x, y in _brush_pixels(stroke.get('points') or [], W, H):
            _stamp_feather(mask, x, y, kernel)
            painted += 1
        if mask.max() <= 0:
            continue
        ys, xs = np.where(mask > 1e-4)
        sigma = _blur_sigma(radius)
        pad = max(1, int(round(sigma * 3)))
        x0, x1 = max(0, int(xs.min()) - pad), min(W, int(xs.max()) + pad + 1)
        y0, y1 = max(0, int(ys.min()) - pad), min(H, int(ys.max()) + pad + 1)
        blurred = cv2.GaussianBlur(src[y0:y1, x0:x1], (0, 0), sigmaX=sigma)
        alpha = mask[y0:y1, x0:x1, None]
        region = out[y0:y1, x0:x1]
        out[y0:y1, x0:x1] = region * (1.0 - alpha) + blurred.astype(np.float32) * alpha
    if not painted:
        raise ValueError('Paint with the blur brush')
    img[:] = np.clip(np.round(out), 0, 255).astype(np.uint8)
    return 'blur-brush'


def _blend_from_file(img, req, path_key, missing_msg, size_msg, paint_msg, method):
    source_path = req.get(path_key)
    if not source_path:
        raise ValueError(missing_msg)
    src = cv2.imread(source_path)
    if src is None:
        raise ValueError(missing_msg)
    if src.shape[:2] != img.shape[:2]:
        raise ValueError(size_msg)
    H, W = img.shape[:2]
    strokes = req.get('strokes') or []
    if not strokes:
        raise ValueError(paint_msg)
    out = img.astype(np.float32)
    source = src.astype(np.float32)
    painted = 0
    for stroke in strokes:
        radius = max(1, min(200, int(stroke.get('radius', 8))))
        kernel = _feather_kernel(radius)
        mask = np.zeros((H, W), np.float32)
        for x, y in _brush_pixels(stroke.get('points') or [], W, H):
            _stamp_feather(mask, x, y, kernel)
            painted += 1
        if mask.max() <= 0:
            continue
        ys, xs = np.where(mask > 1e-4)
        x0, x1 = max(0, int(xs.min())), min(W, int(xs.max()) + 1)
        y0, y1 = max(0, int(ys.min())), min(H, int(ys.max()) + 1)
        alpha = mask[y0:y1, x0:x1, None]
        region = out[y0:y1, x0:x1]
        out[y0:y1, x0:x1] = region * (1.0 - alpha) + source[y0:y1, x0:x1] * alpha
    if not painted:
        raise ValueError(paint_msg)
    img[:] = np.clip(np.round(out), 0, 255).astype(np.uint8)
    return method


def restore_brush(img, req):
    """Feathered stamp: blend previous-save pixels through a soft brush.

    Codex and other reconstructors often change pixels outside the intended
    patch. Painting here brings those pixels back from the previous saved
    artwork without discarding the rest of the current pass.
    """
    return _blend_from_file(
        img, req, 'previous',
        'Nothing to restore; previous save is missing',
        'Previous save does not match this page size',
        'Paint with the restore brush',
        'restore-brush',
    )


def raw_brush(img, req):
    """Feathered stamp: blend uncleaned prepared pixels onto the working page."""
    return _blend_from_file(
        img, req, 'raw',
        'raw source is missing',
        'raw source does not match this page size',
        'Paint with the raw brush',
        'raw-brush',
    )


def clone_brush(img, req):
    """Aligned clone stamp: copy brush-sized circles from dest - offset.

    Samples a snapshot of the page so a stroke does not clone its own output.
    """
    H, W = img.shape[:2]
    offset = req.get('offset') or [0, 0]
    if len(offset) < 2:
        raise ValueError('Clone stamp needs a source-to-destination offset')
    ox = int(round(float(offset[0]) * W))
    oy = int(round(float(offset[1]) * H))
    strokes = req.get('strokes') or []
    if not strokes:
        raise ValueError('Paint with the clone stamp after setting a source')
    src = img.copy()
    out = img.copy()
    painted = 0
    for stroke in strokes:
        radius = max(1, min(200, int(stroke.get('radius', 8))))
        for x, y in _brush_pixels(stroke.get('points') or [], W, H):
            _copy_circle(src, out, x - ox, y - oy, x, y, radius)
            painted += 1
    if not painted:
        raise ValueError('Paint with the clone stamp after setting a source')
    img[:] = out
    return 'clone-brush'


def run(req):
    if req['cmd']=='ping': return {'ready': True}
    if req['cmd']=='probe': return probe()
    if req['cmd']=='warmup': return warmup(req.get('device','cpu'))
    img = cv2.imread(req['path'])
    if img is None: raise ValueError('Prepared source is missing')
    if req['cmd']=='mask-geometry':
        mask = cv2.imread(req['mask'], cv2.IMREAD_GRAYSCALE)
        if mask is None or mask.shape != img.shape[:2]:
            raise ValueError('Segmentation mask must match the prepared page')
        mask = (mask > 127).astype(np.uint8) * 255
        result = geometry_result(mask, req, float(req.get('confidence', .5)))
        if len(result['polygon']) < 3:
            raise ValueError('Segmentation mask has no usable bubble boundary')
        return result
    if req['cmd']=='detect-sfx':
        import coo
        confidence = float(req.get('confidence', .6))
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError('Invalid COO confidence')
        return {'regions': coo.detect(img, confidence, req.get('device', 'cpu')),
                'width': img.shape[1], 'height': img.shape[0], 'model': coo.VERSION}
    if req['cmd']=='detect-text':
        from lettering import detect_text
        regions, mask, meta = detect_text(img, req.get('device', 'cpu'), req.get('maskExpansion', 3))
        if req.get('out') and not cv2.imwrite(req['out'], mask):
            raise ValueError('Mask write failed')
        return {'regions': regions, 'width': img.shape[1], 'height': img.shape[0], **meta}
    if req['cmd']=='geometry': return geometry(img,req)
    if req['cmd']=='geometry-batch':
        regions = req.get('regions', [])
        return {'regions': [geometry(img, {**req, **r, 'cmd': 'geometry',
                            'neighbors': [other['box'] for j, other in enumerate(regions) if j != i]})
                            for i, r in enumerate(regions)]}
    if req['cmd']=='bubble-fill':
        method = bubble_fill(img, req)
        if not cv2.imwrite(req['out'], img): raise ValueError('Clean write failed')
        return {'method': method, 'backend': 'CPU'}
    if req['cmd']=='clone-brush':
        method = clone_brush(img, req)
        if not cv2.imwrite(req['out'], img): raise ValueError('Clean write failed')
        return {'method': method, 'backend': 'CPU'}
    if req['cmd']=='blur-brush':
        method = blur_brush(img, req)
        if not cv2.imwrite(req['out'], img): raise ValueError('Clean write failed')
        return {'method': method, 'backend': 'CPU'}
    if req['cmd']=='restore-brush':
        method = restore_brush(img, req)
        if not cv2.imwrite(req['out'], img): raise ValueError('Clean write failed')
        return {'method': method, 'backend': 'CPU'}
    if req['cmd']=='raw-brush':
        method = raw_brush(img, req)
        if not cv2.imwrite(req['out'], img): raise ValueError('Clean write failed')
        return {'method': method, 'backend': 'CPU'}
    mask = removal_mask(img,req)
    if req['cmd']=='mask':
        if req.get('grow'):
            mask = grow_mask_at(mask, req.get('px'), req.get('py'), grow_radius(req))
        if not cv2.imwrite(req['out'],mask): raise ValueError('Mask write failed')
        meta = req.get('_maskMeta') or {'engine': 'ctd', 'version': 'ctd-regions-v1', 'backend': 'CPU'}
        return {'pixels': int(np.count_nonzero(mask)), 'backend': meta.get('backend', 'CPU'),
                'maskEngine': meta.get('engine', 'ctd'), 'maskVersion': meta.get('version', 'ctd-regions-v1'),
                'maskDiagnostics': req.get('_maskDiagnostics', []),
                'maskModel': {'repo': meta.get('repo'), 'revision': meta.get('revision')}}
    if req['cmd']=='clean-flat':
        result = img.copy()
        remaining = mask.copy()
        for bounds, selected, color in balloon_fills(img, mask):
            result[bounds][selected] = color
            remaining[bounds][selected] = 0
        if not cv2.imwrite(req['out'], result): raise ValueError('Clean write failed')
        if not cv2.imwrite(req['remainingMask'], remaining): raise ValueError('Mask write failed')
        return {'remaining': int(np.count_nonzero(remaining)), 'method': 'flat', 'backend': 'CPU'}
    if req['cmd']=='clean':
        result,method=clean(img,mask,req)
        if not cv2.imwrite(req['out'],result): raise ValueError('Clean write failed')
        parts = method.split('+')
        device = str(req.get('device', 'cpu'))
        if any(m in parts for m in ('big-lama', 'aot')) and device.startswith('cuda'):
            backend = f'{device} · GPU'
        elif 'lama' in parts:
            backend = 'CPU ONNX · LaMa'
        else:
            backend = 'CPU'
        return {'method':method,'backend':backend}
    raise ValueError('Unknown operation')


def _configure_torch(device='cpu'):
    if not importlib.util.find_spec('torch'):
        return
    import torch
    torch.set_num_threads(max(1,int(os.environ.get('SCAN_MODEL_THREADS','4'))))
    if str(device).startswith('cuda') and torch.cuda.is_available():
        try:
            torch.cuda.set_per_process_memory_fraction(float(os.environ.get('SCAN_GPU_MEMORY_FRACTION','.4')), device)
        except RuntimeError:
            pass


def _handle(req):
    start=time.perf_counter()
    device=str(req.get('device','cpu'))
    _configure_torch(device)
    with contextlib.redirect_stdout(sys.stderr): result=run(req)
    if device.startswith('cuda'):
        import torch
        torch.cuda.synchronize(device)
        result['peakGPUBytes']=torch.cuda.max_memory_allocated(device)
    return {'ok':True,**result,'seconds':time.perf_counter()-start,'peakRSSKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}


if __name__=='__main__':
    try:
        if os.environ.get('SCAN_WORKFLOW_PERSISTENT') == '1':
            _configure_torch('cuda:0' if os.environ.get('HIP_VISIBLE_DEVICES') else 'cpu')
            for line in sys.stdin:
                line=line.strip()
                if not line:
                    continue
                try:
                    print(json.dumps(_handle(json.loads(line))))
                except Exception as e:
                    print(json.dumps({'ok':False,'error':f'{type(e).__name__}: {e}'}))
                sys.stdout.flush()
        else:
            print(json.dumps(_handle(json.loads(sys.stdin.readline()))))
    except Exception as e:
        print(json.dumps({'ok':False,'error':f'{type(e).__name__}: {e}'}))
        sys.exit(1)
