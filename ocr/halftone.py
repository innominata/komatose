"""The screen step of post-processing: a regular dot screen redrawn in phase
across the pixels an edit model repainted.

Ported, with the author's permission, from Bear's cleaner-core
(`crates/cleaner-core/src/engines/halftone.rs`, with `sources` from
`screentone.rs`). An edit model keeps the tone of a screentone under lettering
and loses its dots, or draws dots of its own out of step with the page's. Per
background region that touches the mask (the drawing's contours are its
walls), from the page within RING px of the mask:

1. Frequencies: the strongest peaks of the power spectrum of the page's fine
   detail, each refined by the mean turn of the detail demodulated at it.
2. Phase: for each frequency the page's local phase, carried into the mask
   from the coarse scale to the fine one.
3. Screen model: for each pair of frequencies at an angle, a table of the
   page's value by place in the dot cell and by tone, built on half the page
   and scored on the other half. Hatching and flat paper fail it.
4. Shifts: whole-pixel displacements that keep both phases, kept where the
   page's detail correlates with itself one shift away.
5. Copy: each mask pixel takes the page's own pixel one shift away, closest in
   tone, with the tone difference added. The dots are the page's, crisp.
6. Redraw: a pixel no shift reaches takes the table's value at its place in
   the cell and the answer's tone.

`reach` is 'table' (no copy) or 'copy'; `over` is 'all' or 'screen' (only
where the answer is a screen of its own or plain grey, its drawing kept).
"""
import math

import cv2
import numpy as np

MIN_FIT = 0.5
TONE_MARGIN = 12.0
MAX_SHIFT = 64
PHASE_TOL = 0.05
MIN_COPY = 0.8
MAX_TONE_GAP = 16.0
FLAT_TONE = (10.0, 245.0)
SCREEN_SIGMA = 3.0
SCREEN_SHARE = 0.2
MIN_DRAWING = 3
CALIBRATE = 2.0
MAX_SWING_GAIN = 3.0
SPREAD_BINS = 16
MIN_SPREAD_PIXELS = 64.0
SHIFTS_TRIED = 64
SHIFT_BANDS = 4
PATCH = 2
MAX_PATCH_GAP = 30.0
LENGTH_COST = 0.05
KEEP_BONUS = 2.0
RING = 64.0
MIN_KNOWN = 600
CANDIDATES = 6
MIN_PEAK = 0.02
LONGEST_PERIOD = 24.0
MIN_ANGLE = 35.0
BINS_PER_PX = 4.0
TONE_BINS = 12
MIN_DETAIL = 2.0
EVIDENCE_SIGMA = 5.0
EVIDENCE_SHARE = 0.35
EVIDENCE_EACH = 0.06
MIN_EVIDENCE = 256
BLOCK = 16
PHASE_SIGMAS = (6.0, 12.0, 24.0, 48.0, 96.0)
DECIMATE = 4
FULL_SUPPORT = 0.25


def gaussian(g, sigma):
    return cv2.GaussianBlur(g, (0, 0), sigma, borderType=cv2.BORDER_REFLECT_101)


def masked_blur(img, known, sigma):
    k = known.astype(np.float64)
    wts = gaussian(k, sigma)
    return gaussian(np.where(known, img, 0.0), sigma) / np.maximum(wts, 1e-6), wts


def dilate(mask, r):
    if r <= 0:
        return mask
    return cv2.dilate(mask.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0


def erode(mask, r):
    return ~dilate(~mask, r)


def distance_to(mask):
    if not mask.any():
        return np.full(mask.shape, 1e10)
    return cv2.distanceTransform((~mask).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE).astype(np.float64)


def correlation(a, b):
    if len(a) == 0:
        return 0.0
    a, b = a - a.mean(), b - b.mean()
    d = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 0 else 0.0


def shifted(g, dy, dx):
    """g at (y + dy, x + dx), zero and not inside past the edge."""
    h, w = g.shape
    out = np.zeros_like(g)
    inside = np.zeros(g.shape, bool)
    ys, ye = max(0, -dy), min(h, h - dy)
    xs, xe = max(0, -dx), min(w, w - dx)
    if ys < ye and xs < xe:
        out[ys:ye, xs:xe] = g[ys + dy:ye + dy, xs + dx:xe + dx]
        inside[ys:ye, xs:xe] = True
    return out, inside


def coords(shape):
    h, w = shape
    return np.mgrid[0:h, 0:w].astype(np.float64)


def quadrature(detail, known, f, sigma):
    y, x = coords(detail.shape)
    arg = 2 * math.pi * (f[0] * y + f[1] * x)
    d = np.where(known, detail, 0.0)
    return gaussian(d * np.cos(arg), sigma), gaussian(-d * np.sin(arg), sigma)


def demodulate(detail, known, f, sigma):
    re, im = quadrature(detail, known, f, sigma)
    return re, im, gaussian(known.astype(np.float64), sigma)


def refine(detail, known, f):
    f = list(f)
    for _ in range(3):
        re, im, den = demodulate(detail, known, f, PHASE_SIGMAS[0])
        ok = den > 0.5
        zr, zi = re / np.maximum(den, 1e-12), im / np.maximum(den, 1e-12)

        def turn(a, b, pair):
            ra, ia, rb, ib = zr[a], zi[a], zr[b], zi[b]
            return float((ra * rb + ia * ib)[pair].sum()), float((ia * rb - ra * ib)[pair].sum())

        down = turn((slice(1, None), slice(None)), (slice(None, -1), slice(None)), ok[1:, :] & ok[:-1, :])
        across = turn((slice(None), slice(1, None)), (slice(None), slice(None, -1)), ok[:, 1:] & ok[:, :-1])
        f[0] += math.atan2(down[1], down[0]) / (2 * math.pi)
        f[1] += math.atan2(across[1], across[0]) / (2 * math.pi)
    return f


def local_phase(detail, known, f):
    h, w = detail.shape
    re, im, den = demodulate(detail, known, f, PHASE_SIGMAS[0])
    sw, sh = -(-w // DECIMATE), -(-h // DECIMATE)
    small = [cv2.resize(g, (sw, sh), interpolation=cv2.INTER_AREA) for g in (re, im, den)]
    zr, zi = np.zeros((h, w)), np.zeros((h, w))
    for sigma in reversed(PHASE_SIGMAS):
        if sigma == PHASE_SIGMAS[0]:
            sr, si, sd = re, im, den
        else:
            rest = math.sqrt(sigma * sigma - PHASE_SIGMAS[0] ** 2) / DECIMATE
            sr, si, sd = (cv2.resize(gaussian(g, rest), (w, h), interpolation=cv2.INTER_LINEAR) for g in small)
        s = np.clip(sd / FULL_SUPPORT, 0, 1)
        d = np.maximum(sd, 1e-9)
        zr, zi = zr * (1 - s) + sr / d * s, zi * (1 - s) + si / d * s
    y, x = coords((h, w))
    u = f[0] * y + f[1] * x + np.arctan2(zi, zr) / (2 * math.pi)
    return u - np.floor(u)


def frequency(k, size):
    return k / size if k < size // 2 else k / size - 1


def peaks(detail, known):
    h, w = detail.shape
    window = gaussian(known.astype(np.float64), 4.0)
    tapered = np.where(known, detail * window, 0.0)
    size = max(512, 1 << (max(w, h) - 1).bit_length())
    pad = np.zeros((size, size))
    pad[:h, :w] = tapered
    power = np.abs(np.fft.fft2(pad)) ** 2
    fr = np.fft.fftfreq(size)
    fy, fx = np.meshgrid(fr, fr, indexing='ij')
    in_band = np.hypot(fy, fx) > 1 / LONGEST_PERIOD
    banded = np.where(in_band, power, 0.0)
    local_max = np.ones_like(power, bool)
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            local_max &= np.roll(banded, (-dy, -dx), axis=(0, 1)) <= power
    upper = (fy > 0) | ((fy == 0) & (fx > 0))
    cand = local_max & in_band & upper & (power > 0)
    ky, kx = np.nonzero(cand)
    if not len(ky):
        return []
    order = np.argsort(-power[ky, kx], kind='stable')
    top = power[ky[order[0]], kx[order[0]]]

    def parabola(m, c, p):
        m, c, p = math.log(m + 1e-12), math.log(c + 1e-12), math.log(p + 1e-12)
        d = m - 2 * c + p
        return 0.0 if abs(d) < 1e-12 else 0.5 * (m - p) / d

    raw = lambda y, x: power[y % size, x % size]
    out = []
    for o in order[:CANDIDATES]:
        y, x = int(ky[o]), int(kx[o])
        if power[y, x] < MIN_PEAK * top:
            break
        dy = parabola(raw(y - 1, x), raw(y, x), raw(y + 1, x))
        dx = parabola(raw(y, x - 1), raw(y, x), raw(y, x + 1))
        out.append([frequency(y, size) + dy / size, frequency(x, size) + dx / size])
    return out


def bins_for(period):
    return int(min(24, max(4, round(period * BINS_PER_PX))))


class Table:
    """A screen's value by place in the cell (u, v, cyclic) and tone, trilinear."""

    def __init__(self, u, v, tone, page, bins):
        self.bins = bins
        self.t0, self.t1 = float(tone.min()), float(tone.max())
        nb = bins
        weight = np.zeros(nb * nb * TONE_BINS)
        total = np.zeros(nb * nb * TONE_BINS)
        for cell, wgt in self.corners(u, v, tone):
            np.add.at(weight, cell, wgt)
            np.add.at(total, cell, wgt * page)
        seen = weight > 0.5
        cells = np.where(seen, total / np.maximum(weight, 1e-12), 0.0).reshape(nb * nb, TONE_BINS)
        seen = seen.reshape(nb * nb, TONE_BINS)
        idx = np.arange(TONE_BINS)
        # Tone bins a cell place never saw take the nearest seen ones, linearly between.
        for c in range(nb * nb):
            s = idx[seen[c]]
            if len(s) and len(s) < TONE_BINS:
                cells[c] = np.interp(idx, s, cells[c, s])
        placed = seen.any(axis=1)
        # A cell place never seen at all takes the mean of its seen neighbours, ring by ring.
        grid = cells.reshape(nb, nb, TONE_BINS)
        have = placed.reshape(nb, nb)
        while not have.all() and have.any():
            acc = np.zeros_like(grid)
            cnt = np.zeros((nb, nb))
            for da, db in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                rh = np.roll(have, (-da, -db), axis=(0, 1))
                acc += np.roll(grid, (-da, -db), axis=(0, 1)) * rh[..., None]
                cnt += rh
            fill = ~have & (cnt > 0)
            grid[fill] = acc[fill] / cnt[fill][:, None]
            have = have | fill
        self.cells = grid.reshape(-1)

    def corners(self, u, v, t):
        nb = self.bins
        pu, pv = u * nb - 0.5, v * nb - 0.5
        iu, iv = np.floor(pu).astype(np.int64), np.floor(pv).astype(np.int64)
        fu, fv = pu - iu, pv - iv
        pt = np.clip((t - self.t0) / max(self.t1 - self.t0, 1e-6), 0, 1) * (TONE_BINS - 1)
        it = np.minimum(np.floor(pt).astype(np.int64), TONE_BINS - 2)
        ft = pt - it
        for du, wu in ((0, 1 - fu), (1, fu)):
            for dv, wv in ((0, 1 - fv), (1, fv)):
                for dt, wt in ((0, 1 - ft), (1, ft)):
                    a, b = (iu + du) % nb, (iv + dv) % nb
                    yield (a * nb + b) * TONE_BINS + np.minimum(it + dt, TONE_BINS - 1), wu * wv * wt

    def at(self, u, v, t):
        out = np.zeros(np.shape(u))
        for cell, wgt in self.corners(u, v, t):
            out += wgt * self.cells[cell]
        return out


def evidence_window(detail, known):
    return gaussian(known.astype(np.float64), EVIDENCE_SIGMA), gaussian(detail * detail, EVIDENCE_SIGMA)


def evidence(detail, known, window, f, g):
    den, power = window

    def energy(fr):
        re, im = quadrature(detail, known, fr, EVIDENCE_SIGMA)
        return 2 * (re ** 2 + im ** 2) / np.maximum(den, 1e-6) ** 2

    a, b = energy(f), energy(g)
    p = power / np.maximum(den, 1e-6)
    ok = known & (p > MIN_DETAIL ** 2) & (a + b > EVIDENCE_SHARE * p) & (np.minimum(a, b) > EVIDENCE_EACH * p)
    return int(ok.sum())


class Screen:
    @staticmethod
    def fit(page, known):
        base = masked_blur(page, known, 1.5)[0]
        detail = np.where(known, page - base, 0.0)
        count = int(known.sum())
        if math.sqrt(float((detail[known] ** 2).sum()) / max(count, 1)) < MIN_DETAIL:
            return None
        freqs = [refine(detail, known, f) for f in peaks(detail, known)]
        if len(freqs) < 2:
            return None
        phases = [local_phase(detail, known, f) for f in freqs]
        y, x = coords(page.shape)
        train_sel = known & (((y // BLOCK + x // BLOCK) % 2) == 0)
        test_sel = known & ~train_sel
        pairs = []
        for a in range(len(freqs)):
            for b in range(a + 1, len(freqs)):
                f, g = freqs[a], freqs[b]
                det = abs(f[0] * g[1] - f[1] * g[0])
                if det / (math.hypot(*f) * math.hypot(*g)) < math.sin(math.radians(MIN_ANGLE)):
                    continue
                area = 1 / max(det, 1e-12)
                if not 2 <= area <= 600:
                    continue
                period = math.sqrt(area)
                tone = masked_blur(page, known, max(period, 2.0))[0]
                if not train_sel.any() or not test_sel.any():
                    continue
                table = Table(phases[a][train_sel], phases[b][train_sel], tone[train_sel], page[train_sel], bins_for(period))
                predicted = table.at(phases[a][test_sel], phases[b][test_sel], tone[test_sel]) - tone[test_sel]
                fit = correlation(predicted, page[test_sel] - tone[test_sel])
                if fit >= MIN_FIT:
                    pairs.append((fit, a, b, period))
        pairs.sort(key=lambda p: -p[0])
        window = evidence_window(detail, known)
        chosen = next((p for p in pairs if evidence(detail, known, window, freqs[p[1]], freqs[p[2]]) >= MIN_EVIDENCE), None)
        if chosen is None:
            return None
        _, a, b, period = chosen
        s = Screen()
        s.f, s.g, s.u, s.v = freqs[a], freqs[b], phases[a], phases[b]
        s.tone_sigma = max(period, 2.0)
        tone = masked_blur(page, known, s.tone_sigma)[0]
        s.table = Table(phases[a][known], phases[b][known], tone[known], page[known], bins_for(period))
        s.detail = detail
        return s

    def spread(self, page, known, sigma):
        """The page's RMS swing about its local mean, as a function of that mean."""
        mean = masked_blur(page, known, sigma)[0]
        b = np.minimum((mean[known] / 256 * SPREAD_BINS).astype(int), SPREAD_BINS - 1)
        sq = (page[known] - mean[known]) ** 2
        total = np.bincount(b, sq, SPREAD_BINS)
        count = np.bincount(b, None, SPREAD_BINS)
        rms = [math.sqrt(total[i] / count[i]) if count[i] >= MIN_SPREAD_PIXELS else None for i in range(SPREAD_BINS)]

        def at(t):
            x = min(max(t / 256 * SPREAD_BINS - 0.5, 0), SPREAD_BINS - 1)
            i, fr = int(math.floor(x)), x - math.floor(x)
            a, c = rms[i], rms[min(i + 1, SPREAD_BINS - 1)]
            if a is not None and c is not None:
                return a * (1 - fr) + c * fr
            if a is not None and fr < 0.5:
                return a
            if c is not None and fr >= 0.5:
                return c
            return 0.0
        return np.vectorize(at, otypes=[float])

    def redrawable(self, answer, hole, tone):
        base = masked_blur(answer, hole, 1.5)[0]
        detail = np.where(hole, answer - base, 0.0)
        den = gaussian(hole.astype(np.float64), SCREEN_SIGMA)
        power = gaussian(detail * detail, SCREEN_SIGMA)

        def energy(f):
            re, im = quadrature(detail, hole, f, SCREEN_SIGMA)
            return 2 * (re ** 2 + im ** 2) / np.maximum(den, 1e-6) ** 2

        ef, eg = energy(self.f), energy(self.g)
        p = power / np.maximum(den, 1e-6)
        flat = (tone >= FLAT_TONE[0]) & (tone < FLAT_TONE[1])
        drawing = hole & np.where(p <= MIN_DETAIL ** 2, ~flat, ef + eg < SCREEN_SHARE * p)
        drawing = dilate(erode(drawing, MIN_DRAWING), MIN_DRAWING)
        return gaussian((~drawing).astype(np.float64), 1.5)

    def shifts(self, known):
        wrap = lambda c: np.abs(c - np.round(c))
        r = np.arange(-MAX_SHIFT, MAX_SHIFT + 1)
        dy, dx = np.meshgrid(r, r, indexing='ij')
        d2 = dy * dy + dx * dx
        err = np.maximum(wrap(self.f[0] * dy + self.f[1] * dx), wrap(self.g[0] * dy + self.g[1] * dx))
        ok = (d2 >= 4) & (d2 <= MAX_SHIFT * MAX_SHIFT) & (err <= PHASE_TOL)
        close = sorted(zip(err[ok], dy[ok], dx[ok]), key=lambda c: c[0])
        band = lambda c: max(1, math.ceil(math.sqrt(c[1] ** 2 + c[2] ** 2) * SHIFT_BANDS / MAX_SHIFT))
        tried = []
        for b in range(1, SHIFT_BANDS + 1):
            tried += [c for c in close if band(c) == b][:SHIFTS_TRIED // SHIFT_BANDS]
        kept = []
        for _, sy, sx in tried:
            sy, sx = int(sy), int(sx)
            other, inside = shifted(self.detail, sy, sx)
            kother, _ = shifted(known.astype(np.uint8), sy, sx)
            both = known & inside & (kother > 0)
            c = correlation(self.detail[both], other[both]) if both.sum() >= MIN_KNOWN // 2 else 0.0
            if c >= MIN_COPY:
                kept.append((sy, sx, c))
        kept.sort(key=lambda k: -k[2])
        return kept

    def copy(self, page, known, hole, target):
        shifts = self.shifts(known)
        if not shifts:
            return None
        h, w = page.shape
        rep = sources(page, hole, ~known, shifts)
        # A source's patches and theirs one shift away differ by little for most shifts.
        k = np.ones((2 * PATCH + 1, 2 * PATCH + 1))
        good = np.zeros((h, w))
        valid = np.zeros((h, w))
        kf = known.astype(np.float64)
        for sy, sx, _ in shifts:
            other, inside = shifted(page, sy, sx)
            kother, _ = shifted(kf, sy, sx)
            both = kf * kother * inside
            diff = np.abs(page - other) * both
            ssum = cv2.filter2D(diff, -1, k, borderType=cv2.BORDER_CONSTANT)
            cnt = cv2.filter2D(both, -1, k, borderType=cv2.BORDER_CONSTANT)
            has = cnt * 2 > (2 * PATCH + 1) ** 2
            valid += has
            good += has & (ssum / np.maximum(cnt, 1) <= MAX_PATCH_GAP)
        src = rep & (valid >= 2) & (2 * good >= valid)
        if not src.any():
            return None
        tone = masked_blur(page, src, self.tone_sigma)[0]
        ys, xs = np.nonzero(hole)
        nk = len(shifts)
        cost = np.full((len(ys), nk), np.inf)
        source = np.zeros((len(ys), nk), np.int64)
        for j, (sy, sx, _) in enumerate(shifts):
            ty, tx = ys + sy, xs + sx
            ok = (ty >= 0) & (ty < h) & (tx >= 0) & (tx < w)
            tyc, txc = np.clip(ty, 0, h - 1), np.clip(tx, 0, w - 1)
            gap = np.abs(tone[tyc, txc] - target[ys, xs])
            ok &= src[tyc, txc] & (gap <= MAX_TONE_GAP)
            cost[:, j] = np.where(ok, gap + LENGTH_COST * math.hypot(sy, sx), np.inf)
            source[:, j] = tyc * w + txc
        out = np.zeros((h, w))
        done = np.zeros((h, w), bool)
        used = np.full((h, w), -1, np.int64)
        best = np.argmin(cost, axis=1)
        flat_page, flat_tone = page.reshape(-1), tone.reshape(-1)
        # In raster order, the shift a left or upper neighbour took costs KEEP_BONUS less.
        for p in range(len(ys)):
            y, x = ys[p], xs[p]
            row = cost[p]
            k_best = best[p]
            c_best = row[k_best]
            for nb in ((used[y, x - 1] if x > 0 else -1), (used[y - 1, x] if y > 0 else -1)):
                if nb >= 0 and row[nb] - KEEP_BONUS < c_best:
                    k_best, c_best = nb, row[nb] - KEEP_BONUS
            if not np.isfinite(c_best):
                continue
            s = source[p, k_best]
            out[y, x] = flat_page[s] + target[y, x] - flat_tone[s]
            done[y, x] = True
            used[y, x] = k_best
        return (out, done) if done.any() else None


def sources(raw, hole, avoid, offs):
    """Known pixels whose fine detail repeats one offset away."""
    known = ~dilate(hole, 2) & ~avoid
    base = masked_blur(raw, known, 1.5)[0]
    hp = np.where(known, raw - base, 0.0)
    sigma = 3.0
    e0 = gaussian(hp * hp, sigma)
    acc = np.zeros_like(hp)
    used = offs[:4]
    kf = known.astype(np.float64)
    for dy, dx, _ in used:
        sh, inside = shifted(hp, dy, dx)
        km, _ = shifted(kf, dy, dx)
        both = (known & inside & (km > 0.5)).astype(np.float64)
        num = gaussian(hp * sh * both, sigma)
        e1 = gaussian(sh * sh * both, sigma)
        acc += num / np.sqrt(e0 * e1 + 1e-6)
    level = float(np.median(e0[known])) if known.any() else 0.0
    conf = np.where(e0 < 0.15 * level, 0.0, acc / max(len(used), 1))
    ring = known & dilate(hole, 60)
    reference = float(np.median(conf[ring])) if ring.any() else 0.0
    cut = max(0.6 * reference, 0.25)
    return known & (conf >= cut)


def redraw(page, answer, mask, protected, inside, fade, reach='copy', over='all'):
    """The redrawn screen over the crop and its blend weight, or None."""
    h, w = page.shape
    grown = dilate(mask, 2)
    from_mask = distance_to(mask)
    _, label = cv2.connectedComponents((~protected).astype(np.uint8), connectivity=8)
    value = answer.copy()
    weight = np.zeros((h, w))
    for r in np.unique(label[mask & (label > 0)]):
        near = (label == r) & (from_mask <= RING)
        ys, xs = np.nonzero(near)
        if not len(ys):
            continue
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        win = (slice(y0, y1), slice(x0, x1))
        region = label[win] == r
        known = region & inside[win] & ~grown[win] & (from_mask[win] <= RING)
        if known.sum() < MIN_KNOWN:
            continue
        shown = page[win]
        screen = Screen.fit(shown, known)
        if screen is None:
            continue
        ans = answer[win]
        tone = masked_blur(ans, region, screen.tone_sigma)[0]
        hole = region & mask[win]
        kept = screen.redrawable(ans, hole, tone) if over == 'screen' else np.ones(hole.shape)
        copied = None if reach == 'table' else screen.copy(shown, known, hole, tone)
        drawn = np.zeros(hole.shape)
        drawn[hole] = screen.table.at(screen.u[hole], screen.v[hole], tone[hole])
        if over == 'screen':
            sigma = CALIBRATE * screen.tone_sigma
            mean = masked_blur(drawn, hole, sigma)[0]
            want = masked_blur(tone, hole, sigma)[0]
            spread = screen.spread(shown, known, sigma)
            swing = np.sqrt(np.maximum(masked_blur((drawn - mean) ** 2, hole, sigma)[0], 0))
            gain = np.clip(spread(want[hole]) / np.maximum(swing[hole], 1e-6), 1.0, MAX_SWING_GAIN)
            drawn[hole] = want[hole] + (drawn[hole] - mean[hole]) * gain
        f = fade[win]
        target = hole & (f * kept > 0)
        v, wt = value[win], weight[win]
        took = np.zeros(hole.shape, bool)
        if copied is not None:
            out, done = copied
            took = target & done
            v[took] = out[took]
            wt[took] = (f * kept)[took]
        off = np.maximum(np.maximum(screen.table.t0 - tone, tone - screen.table.t1), 0)
        s = np.clip(1 - off / TONE_MARGIN, 0, 1) * kept * f
        rest = hole & ~took & (s > 0)
        v[rest] = drawn[rest]
        wt[rest] = s[rest]
    return (value, weight) if (weight > 0).any() else None
