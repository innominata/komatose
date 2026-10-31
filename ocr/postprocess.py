"""Matching an image editor's answer to the page before it is written.

Ported, with the author's permission, from Bear's cleaner-core
(`crates/cleaner-core/src/engines/postprocess.rs`, "Tone only"): steps 1 to 3
of its finishing. An edit model redraws the whole crop; inside the lettering
it is right about the drawing and often a little off in tone. These steps run
on the answer at the page's resolution, per tone channel (a neutral page as
one grey channel), and the caller still writes only through the mask.

1. Contours: Canny edges where the gradient structure tensor is coherent, so
   drawn lines count and screen dots do not. Inside the mask from the answer
   (under a descreen blur), outside from the page. Every correction fades to
   nothing within PROTECT_PX of one.
2. Tone: a gain and offset fitted on the low-passed page near the mask, then
   the residual carried in by normalised Gaussians, coarse to fine. Page the
   model redrew (a low-pass difference past DRIFT_MAX) is no evidence.
3. Lighting: the low-frequency difference left at the mask's edge, spread
   across the mask as a membrane and added inside it only.
4. Screen (grey pages): the page's own dots copied or redrawn in phase across
   the mask ([halftone]).

METHODS picks the version, as Bear's Finishing does.
"""
import cv2
import numpy as np

GAIN = (0.85, 1.15)
MAX_OFFSET = 32.0
LOCAL_SIGMAS = (48.0, 16.0, 6.0)
LOCAL_CAP = 32.0
DRIFT_MAX = 24.0
PROTECT_PX = 3.0
DESCREEN_SIGMA = 1.5
TONE_SIGMA = 2.5
LIGHTING_SIGMA = 2.0
LIGHTING_CAP = 48.0
EVIDENCE_REACH = 64.0
LINE_CLEARANCE = 5.0
MIN_EVIDENCE = 64
MIN_GAIN_RANGE = 48.0
FULL_SUPPORT = 0.25
CANNY_LOW, CANNY_HIGH = 30.0, 90.0
TENSOR_SIGMA = 2.0
MIN_COHERENCE = 0.35
MEMBRANE_ITERS = 200
# id -> (label, halftone reach, halftone over); reach None is no screen step.
METHODS = {
    'copy': ('Copy page dots', 'copy', 'all'),
    'redraw': ('Redraw dots', 'table', 'all'),
    'fill-dots': ('Tone only, fill lost dots', 'table', 'screen'),
    'tone': ('Tone only', None, None),
    'none': ('None', None, None),
}
DEFAULT_METHOD = 'copy'
# Work on each mask piece with this much page around it.
MARGIN = 96
# A page whose channels differ by no more than this is grey.
GREY_SPREAD = 6


def gaussian(g, sigma):
    return cv2.GaussianBlur(g, (0, 0), sigma, borderType=cv2.BORDER_REFLECT_101)


def distance_to(mask):
    """Euclidean distance to the nearest True pixel."""
    if not mask.any():
        return np.full(mask.shape, 1e10)
    return cv2.distanceTransform((~mask).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE).astype(np.float64)


def contours(g):
    """Canny edges (3x3 Sobel, L2) kept where the structure tensor is coherent."""
    gx = cv2.Sobel(g, cv2.CV_64F, 1, 0, ksize=3, borderType=cv2.BORDER_REPLICATE)
    gy = cv2.Sobel(g, cv2.CV_64F, 0, 1, ksize=3, borderType=cv2.BORDER_REPLICATE)
    jxx, jyy, jxy = (gaussian(a * b, TENSOR_SIGMA) for a, b in ((gx, gx), (gy, gy), (gx, gy)))
    half = np.sqrt(((jxx - jyy) / 2) ** 2 + jxy ** 2)
    l1, l2 = (jxx + jyy) / 2 + half, (jxx + jyy) / 2 - half
    coherent = ((l1 - l2) / (l1 + l2 + 1e-9)) ** 2 > MIN_COHERENCE
    edges = cv2.Canny(gx.astype(np.int16), gy.astype(np.int16), CANNY_LOW, CANNY_HIGH, L2gradient=True) > 0
    return edges & coherent


def membrane(values, known):
    """Laplace fill of the pixels outside `known`, coarse to fine."""
    if known.all():
        return values.copy()
    h, w = values.shape
    if min(w, h) > 32:
        nw, nh = w // 2, h // 2
        kf = cv2.resize(known.astype(np.float64), (nw, nh), interpolation=cv2.INTER_AREA)
        sk = kf > 1e-6
        s = cv2.resize(np.where(known, values, 0.0), (nw, nh), interpolation=cv2.INTER_AREA)
        small = np.where(sk, s / np.maximum(kf, 1e-6), 0.0)
        start = cv2.resize(membrane(small, sk), (w, h), interpolation=cv2.INTER_LINEAR)
    else:
        start = np.full(values.shape, values[known].mean() if known.any() else 0.0)
    u = np.where(known, values, start)
    for _ in range(MEMBRANE_ITERS):
        p = np.pad(u, 1, mode='edge')
        avg = (p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 4
        u = np.where(known, values, avg)
    return u


def tone(shown, answer, near, fade):
    lo_s, lo_a = gaussian(shown, TONE_SIGMA), gaussian(answer, TONE_SIGMA)
    valid = near & (np.abs(lo_s - lo_a) <= 2 * DRIFT_MAX)
    count = int(valid.sum())
    if count < MIN_EVIDENCE:
        return answer, None
    x, y = lo_a[valid], lo_s[valid]
    gain = 1.0
    if np.percentile(x, 95) - np.percentile(x, 5) >= MIN_GAIN_RANGE:
        mx, my = x.mean(), y.mean()
        gain = float(np.clip(((x - mx) * (y - my)).sum() / max(((x - mx) ** 2).sum(), 1e-9), *GAIN))
    offset = float(np.clip(np.median(y - gain * x), -MAX_OFFSET, MAX_OFFSET))
    out = answer * gain + offset
    residual = lo_s - gaussian(out, TONE_SIGMA)
    valid &= np.abs(residual) <= DRIFT_MAX
    known = valid.astype(np.float64)
    correction = np.zeros_like(out)
    for sigma in LOCAL_SIGMAS:
        support = gaussian(known, sigma)
        estimate = gaussian(residual * known, sigma) / np.maximum(support, 1e-6)
        weight = np.clip(support / FULL_SUPPORT, 0, 1)
        correction = correction * (1 - weight) + estimate * weight
    return out + np.clip(correction, -LOCAL_CAP, LOCAL_CAP) * fade, (gain, offset)


def lighting(shown, toned, mask, edge, fade):
    if not edge.any() or not mask.any():
        return toned
    d = gaussian(shown, LIGHTING_SIGMA) - gaussian(toned, LIGHTING_SIGMA)
    d = np.where(edge & (np.abs(d) <= DRIFT_MAX), d, 0.0)
    field = membrane(d, edge)
    return np.where(mask, toned + np.clip(field, -LIGHTING_CAP, LIGHTING_CAP) * fade, toned)


def settle(shown, answer, mask, method=DEFAULT_METHOD):
    """One crop: shown and answer as float channel lists, mask boolean. Returns
    the finished channels and the fitted (gain, offset) of each."""
    luma = lambda chans: sum(chans) / len(chans)
    drawn = gaussian(luma(answer), DESCREEN_SIGMA)
    protected = (contours(drawn) & mask) | (contours(luma(shown)) & ~mask)
    protected = cv2.dilate(protected.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    clear = distance_to(protected)
    fade = np.clip(clear / PROTECT_PX, 0, 1)
    outside = ~mask
    near = outside & (clear > LINE_CLEARANCE) & (distance_to(mask) <= EVIDENCE_REACH)
    k = 2 * int(2 * LIGHTING_SIGMA) + 1
    edge = outside & ~(cv2.dilate(protected.astype(np.uint8), np.ones((k, k), np.uint8)) > 0)
    out, fits = [], []
    for s, a in zip(shown, answer):
        toned, fit = tone(s, a, near, fade)
        fits.append(fit)
        out.append(lighting(s, toned, mask, edge, fade))
    _, reach, over = METHODS[method]
    screened = 0
    if reach and len(out) == 1:
        import halftone
        screen = halftone.redraw(shown[0], out[0], mask, protected, np.ones_like(mask), fade, reach, over)
        if screen is not None:
            value, weight = screen
            out[0] = out[0] * (1 - weight) + value * weight
            screened = int((weight > 0).sum())
    return [np.clip(o, 0, 255) for o in out], fits, screened


def is_grey(img):
    if img.ndim == 2:
        return True
    spread = img.max(axis=2).astype(np.int16) - img.min(axis=2)
    return float(np.percentile(spread, 99)) <= GREY_SPREAD


def finish(page, answer, mask, method=DEFAULT_METHOD):
    """Page and answer as BGR uint8 of one size, mask uint8. Returns the answer
    matched to the page inside the mask (pixels outside it are the page's)."""
    if method not in METHODS:
        raise ValueError(f'Unknown post-processing method: {method}')
    m = mask > 0
    result = page.copy()
    if method == 'none':
        result[m] = answer[m]
        return result, {'method': method, 'pieces': 0, 'fitted': 0, 'screen': 0}
    grey = is_grey(page)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(cv2.dilate(m.astype(np.uint8), np.ones((31, 31), np.uint8)))
    fitted = screen = 0
    for i in range(1, n):
        x, y, w, h, _ = stats[i]
        x0, y0 = max(0, x - MARGIN), max(0, y - MARGIN)
        x1, y1 = min(page.shape[1], x + w + MARGIN), min(page.shape[0], y + h + MARGIN)
        piece = m[y0:y1, x0:x1] & (labels[y0:y1, x0:x1] == i)
        if not piece.any():
            continue
        p = page[y0:y1, x0:x1].astype(np.float64)
        a = answer[y0:y1, x0:x1].astype(np.float64)
        if grey:
            shown, ans = [p.mean(axis=2)], [a.mean(axis=2)]
        else:
            shown, ans = [p[..., c] for c in range(3)], [a[..., c] for c in range(3)]
        out, fits, screened = settle(shown, ans, piece, method)
        fitted += sum(f is not None for f in fits)
        screen += screened
        done = np.stack(out * 3 if grey else out, axis=2).round().astype(np.uint8)
        result[y0:y1, x0:x1][piece] = done[piece]
    return result, {'method': method, 'grey': grey, 'pieces': n - 1, 'fitted': fitted, 'screen': screen}
