"""Make a private, gently wavy TrueType variant of a supplied font.

Example: python3 scripts/make-cc-meanwhile-wavy.py input.ttf data/fonts/CCMeanwhile-Wavy.ttf
The output font inherits the source font's license. Check it before sharing.
"""

from __future__ import annotations

import argparse
import hashlib
import math
from pathlib import Path

from fontTools.pens.basePen import BasePen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont


class OutlinePen(BasePen):
    """Flatten curves finely enough for a smooth non-linear contour warp."""

    def __init__(self, glyph_set, step: float):
        super().__init__(glyph_set)
        self.step = step
        self.contours: list[list[tuple[float, float]]] = []
        self.contour: list[tuple[float, float]] = []

    def _moveTo(self, point):
        self.contour = [point]

    def _lineTo(self, point):
        start = self.contour[-1]
        count = max(1, math.ceil(math.dist(start, point) / self.step))
        self.contour.extend(
            (start[0] + (point[0] - start[0]) * i / count,
             start[1] + (point[1] - start[1]) * i / count)
            for i in range(1, count + 1)
        )

    def _qCurveToOne(self, control, point):
        start = self.contour[-1]
        count = max(2, math.ceil((math.dist(start, control) + math.dist(control, point)) / self.step))
        for i in range(1, count + 1):
            t = i / count
            u = 1 - t
            self.contour.append((
                u * u * start[0] + 2 * u * t * control[0] + t * t * point[0],
                u * u * start[1] + 2 * u * t * control[1] + t * t * point[1],
            ))

    def _curveToOne(self, c1, c2, point):
        start = self.contour[-1]
        length = math.dist(start, c1) + math.dist(c1, c2) + math.dist(c2, point)
        count = max(3, math.ceil(length / self.step))
        for i in range(1, count + 1):
            t = i / count
            u = 1 - t
            self.contour.append((
                u**3 * start[0] + 3 * u*u*t * c1[0] + 3 * u*t*t * c2[0] + t**3 * point[0],
                u**3 * start[1] + 3 * u*u*t * c1[1] + 3 * u*t*t * c2[1] + t**3 * point[1],
            ))

    def _closePath(self):
        if self.contour:
            self.contours.append(self.contour)
        self.contour = []

    def _endPath(self):
        self._closePath()


def make_wavy(source: Path, output: Path, amplitude: float, family: str = "CC Meanwhile Wavy") -> None:
    font = TTFont(source)
    if "glyf" not in font:
        raise ValueError("This script needs a TrueType font with glyf outlines")
    upm = font["head"].unitsPerEm
    original = font.getGlyphSet()
    outlines = {}
    for name in font.getGlyphOrder():
        pen = OutlinePen(original, upm / 120)
        original[name].draw(pen)
        if not pen.contours:
            continue
        phase = int.from_bytes(hashlib.sha256(name.encode()).digest()[:4], "big") / 2**32 * math.tau
        advance = font["hmtx"][name][0]
        out = TTGlyphPen(None)
        for contour in pen.contours:
            points = []
            for x, y in contour:
                # One broad side-to-side wave, plus a small offset along the baseline.
                w = math.tau * y / (upm * 0.85) + phase
                dx = amplitude * upm * math.sin(w)
                dy = 0.008 * upm * math.sin(math.tau * (x - advance / 2) / (upm * 0.8) + phase)
                points.append((round(x + dx), round(y + dy)))
            # The final point of a closed contour often repeats the first point.
            if len(points) > 1 and points[-1] == points[0]:
                points.pop()
            if len(points) < 3:
                continue
            out.moveTo(points[0])
            for point in points[1:]:
                out.lineTo(point)
            out.closePath()
        outlines[name] = out.glyph()

    for name, glyph in outlines.items():
        font["glyf"][name] = glyph
    for table in ("fpgm", "prep", "cvt "):
        if table in font:
            del font[table]
    postscript = family.replace(" ", "") + "-Regular"
    for record in list(font["name"].names):
        value = {
            1: family,
            3: f"{family} Regular; derived from CC Meanwhile Regular",
            4: f"{family} Regular",
            6: postscript,
            16: family,
            17: "Regular",
        }.get(record.nameID)
        if value:
            font["name"].setName(value, record.nameID, record.platformID, record.platEncID, record.langID)
    output.parent.mkdir(parents=True, exist_ok=True)
    font.save(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--amplitude", type=float, default=0.065, help="side-to-side wave, fraction of em")
    parser.add_argument("--family", default="CC Meanwhile Wavy", help="new font family name")
    args = parser.parse_args()
    make_wavy(args.source, args.output, args.amplitude, args.family)
