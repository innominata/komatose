"""Per-region lettering masks that depend on where the text sits.

The lettering model marks the letters. What a clean has to remove around them
depends on the text's place, so each region's mask is fitted from that seed:

- Inside a balloon the paper is flat. The mask grows past the anti-aliasing
  fringe until it would cross a strong edge (the balloon's outline) or the
  paper stops being one tone, and nearby pieces the model missed (dakuten,
  furigana, thin stroke tips) are added back while the paper stays flat.
- Outside a balloon, sound effects and captions are often drawn with an
  outline the model leaves out. The mask grows by half the lettering's own
  stroke width, so the outline goes too and an inpainter does not paint the
  letters back in the outline's colour.
- An unknown place keeps the plain dilation, but like the others it keeps a
  glyph whole when it pokes a little out of the region box.

Approach adapted from Manga Cleaner (github.com/k-omiq/Bear), used with the
author's permission.
"""
import cv2
import numpy as np

VERSION = 'placement-fit-v1'
# Share of the paper beside the lettering that must sit at one tone to be flat.
FLAT_SHARE = .9
# Growth limits in pixels on a page scaled to 1024 on its geometric mean side.
INSIDE_MAX = 4
OUTLINE_MAX = 8
STRAY_REACH = 3


def page_scale(height, width):
    return max(1.0, float(height * width) ** .5 / 1024)


def noise_sigma(gray):
    """Noise floor from the flattest tenth of 16 px tiles, never below one level."""
    h, w = gray.shape
    th, tw = h // 16, w // 16
    if th < 1 or tw < 1:
        return 1.0
    tiles = gray[:th * 16, :tw * 16].astype(np.float32).reshape(th, 16, tw, 16)
    spread = tiles.std(axis=(1, 3)).ravel()
    return max(1.0, float(np.percentile(spread, 10)))


def paper_tolerance(sigma):
    """How far from the paper's tone a pixel may sit and still be paper.

    Relative to the noise floor so JPEG grain is not read as texture, but capped:
    on a page that is all texture the floor is high and would call anything flat.
    """
    return min(20.0, max(6.0, 2.5 * sigma))


def strong_edges(gray):
    """Edges at least half as strong as the page's strongest, like a balloon outline."""
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    peak = float(np.percentile(magnitude, 99.5)) if magnitude.size else 0.0
    return magnitude >= max(40.0, .5 * peak)


def reach(expansion, scale):
    """How far a fitted mask may extend past its region: the outline growth, plus a glyph edge."""
    return max(int(expansion), round(OUTLINE_MAX * scale)) + 2


def disc(radius):
    radius = max(0, int(radius))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))


def _grow(mask, radius):
    return cv2.dilate(mask, disc(radius)) if radius > 0 else mask.copy()


def flat_tone(values, tolerance):
    """The paper's tone when at least FLAT_SHARE of `values` sit at it, else None."""
    if values.size < 8:
        return None
    median = float(np.median(values))
    return median if np.mean(np.abs(values.astype(np.float32) - median) <= tolerance) >= FLAT_SHARE else None


def seed_for(raw, allowed, reach):
    """Lettering under a region, keeping each glyph whole when it pokes slightly out.

    A hard clip to the region cuts glyphs and outlines the region box missed by
    a few pixels. A component is kept whole when it stays within `reach` of the
    region; anything further is clipped to the region grown by `reach`.
    """
    near = _grow(allowed, reach)
    binary = ((raw > 127) & (near > 0)).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    seed = np.zeros(raw.shape, np.uint8)
    for i in range(1, count):
        x, y, w, h, _area = stats[i]
        component = labels[y:y + h, x:x + w] == i
        if not np.any(allowed[y:y + h, x:x + w][component]):
            continue
        seed[y:y + h, x:x + w][component] = 255
    return seed


def half_stroke(seed):
    """Half the lettering's stroke width: the median distance-transform ridge."""
    dt = cv2.distanceTransform((seed > 0).astype(np.uint8), cv2.DIST_L2, 3)
    ridge = (dt > 0) & (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8)))
    return float(np.median(dt[ridge])) if np.any(ridge) else 1.0


def fit_inside(gray, seed, strong, sigma, scale, expansion):
    """Grow each glyph cluster on its own, so one beside the outline does not hold back the rest."""
    limit = max(1, int(expansion), round(INSIDE_MAX * scale))
    pad = limit + 4
    h, w = seed.shape
    # Clusters a little apart are fitted separately; touching glyphs are fitted together.
    clusters = cv2.dilate(seed, disc(2))
    count, labels, stats, _ = cv2.connectedComponentsWithStats((clusters > 0).astype(np.uint8), 8)
    out = np.zeros(seed.shape, np.uint8)
    for i in range(1, count):
        x, y, cw, ch, _area = stats[i]
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(w, x + cw + pad), min(h, y + ch + pad)
        window = (slice(y0, y1), slice(x0, x1))
        part = np.where(labels[window] == i, seed[window], 0).astype(np.uint8)
        out[window] |= _grow_on_paper(gray[window], part, strong[window], sigma, limit)
    return with_stray_lettering(gray, seed, out, sigma, scale)


def _grow_on_paper(gray, seed, strong, sigma, limit):
    tolerance = paper_tolerance(sigma)
    # Glyph edges are strong too, and Sobel spreads them a pixel past the glyph.
    # Only an edge beyond that, such as the balloon outline, stops growth.
    glyphs = _grow(seed, 2)
    best = _grow(seed, 1)
    for radius in range(1, limit + 1):
        candidate = _grow(seed, radius)
        border = (candidate > 0) & (cv2.erode(candidate, np.ones((3, 3), np.uint8)) == 0)
        if np.any(border & strong & (glyphs == 0)):
            break
        ring = (_grow(candidate, 2) > 0) & (candidate == 0)
        if radius > 1 and flat_tone(gray[ring], tolerance) is None:
            break
        best = candidate
    return best


def with_stray_lettering(gray, seed, mask, sigma, scale):
    """Add nearby ink the lettering model missed, only on flat paper."""
    ys, xs = np.nonzero(seed)
    if not len(xs):
        return mask
    reach = max(3, round(STRAY_REACH * scale))
    h, w = gray.shape
    x0, y0 = max(0, xs.min() - 3 * reach), max(0, ys.min() - 3 * reach)
    x1, y1 = min(w, xs.max() + 3 * reach + 1), min(h, ys.max() + 3 * reach + 1)
    local_gray = gray[y0:y1, x0:x1]
    local_mask = mask[y0:y1, x0:x1]
    ring = (_grow(local_mask, 2) > 0) & (local_mask == 0)
    tone = flat_tone(local_gray[ring], paper_tolerance(sigma))
    if tone is None:
        return mask
    ink = ((np.abs(local_gray.astype(np.float32) - tone) > max(40.0, 4 * sigma)) & (local_mask == 0)).astype(np.uint8)
    near = _grow(local_mask, reach) > 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    sx0, sy0, sx1, sy1 = xs.min() - x0, ys.min() - y0, xs.max() - x0, ys.max() - y0
    out = mask.copy()
    added = np.zeros(local_mask.shape, np.uint8)
    for i in range(1, count):
        x, y, cw, ch, _area = stats[i]
        component = labels[y:y + ch, x:x + cw] == i
        if not np.any(near[y:y + ch, x:x + cw][component]):
            continue
        # A balloon outline or panel border runs to the edge of the search box.
        if x == 0 or y == 0 or x + cw >= local_mask.shape[1] or y + ch >= local_mask.shape[0]:
            continue
        # A small balloon's whole outline spans the lettering both ways.
        if x <= sx0 and x + cw > sx1 and y <= sy0 and y + ch > sy1:
            continue
        added[y:y + ch, x:x + cw][component] = 255
    if np.any(added):
        out[y0:y1, x0:x1] |= _grow(added, 1)
    return out


def fit_outside(seed, allowed, scale, expansion):
    cap = max(1, round(OUTLINE_MAX * scale))
    radius = max(int(expansion), min(cap, int(np.ceil(half_stroke(seed))) + 1))
    return cv2.bitwise_and(_grow(seed, radius), _grow(allowed, radius))


def fit_region(image_gray, raw, allowed, placement, expansion, page):
    """Fitted mask for one region on the whole page. `page` holds shared statistics."""
    expansion = max(0, min(20, int(expansion)))
    scale = page['scale']
    limit = reach(expansion, scale)
    ys, xs = np.nonzero(allowed)
    if not len(xs):
        return np.zeros(raw.shape, np.uint8)
    # Work in a window around the region; growth never reaches past it.
    margin = limit + 4 * max(3, round(STRAY_REACH * scale)) + 8
    h, w = raw.shape
    x0, y0 = max(0, xs.min() - margin), max(0, ys.min() - margin)
    x1, y1 = min(w, xs.max() + margin + 1), min(h, ys.max() + margin + 1)
    window = (slice(y0, y1), slice(x0, x1))
    seed = seed_for(raw[window], allowed[window], limit)
    result = np.zeros(raw.shape, np.uint8)
    if not np.any(seed):
        return result
    if placement not in ('inside', 'outside'):
        fitted = _grow(seed, expansion)
    elif placement == 'inside':
        fitted = fit_inside(image_gray[window], seed, page['strong'][window], page['sigma'], scale, expansion)
    else:
        fitted = fit_outside(seed, allowed[window], scale, expansion)
    result[window] = fitted
    return result


def page_statistics(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    return gray, {'scale': page_scale(*gray.shape[:2]), 'sigma': noise_sigma(gray), 'strong': strong_edges(gray)}
