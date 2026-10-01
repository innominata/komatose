#!/usr/bin/env python3
"""Benchmark detector backends on real pages.

Usage: bench-detect.py [--backends rtdetr,ctd,paddle] [--overlay DIR] page.jpg ...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "ocr"))

import cv2
import detect as D

COLOR = {
    "bubble": (255, 160, 0),
    "text_bubble": (0, 0, 255),
    "text_free": (0, 220, 0),
    "text": (0, 0, 255),
}


def overlay(page: str, regions: list[dict], out: str) -> None:
    img = cv2.imread(page)
    H, W = img.shape[:2]
    for r in sorted(regions, key=lambda r: r["cls"] != "bubble"):
        x0, y0, x1, y1 = (int(v) for v in r["box"])
        cv2.rectangle(img, (x0, y0), (x1, y1), COLOR.get(r["cls"], (255, 255, 255)),
                      3 if r["cls"] == "bubble" else 6)
    STRIP = 2000
    cols = []
    y = 0
    while y < H:
        t = img[y : min(H, y + STRIP)]
        if t.shape[0] < STRIP:
            t = cv2.copyMakeBorder(t, 0, STRIP - t.shape[0], 0, 0,
                                   cv2.BORDER_CONSTANT, value=(34, 34, 34))
        cols.append(cv2.resize(t, (300, int(STRIP * 300 / W))))
        y += STRIP
    cv2.imwrite(out, cv2.hconcat(cols))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pages", nargs="+")
    ap.add_argument("--backends", default="rtdetr,ctd")
    ap.add_argument("--conf", type=float, default=None)
    ap.add_argument("--overlay", default=None)
    args = ap.parse_args()

    backends = [b.strip() for b in args.backends.split(",") if b.strip()]
    ocr = None
    if "paddle" in backends:
        from paddleocr import PaddleOCR

        real, sys.stdout = sys.stdout, sys.stderr
        ocr = PaddleOCR(lang="korean", ocr_version="PP-OCRv5", device="cpu",
                        use_doc_orientation_classify=False, use_doc_unwarping=False,
                        use_textline_orientation=False)
        sys.stdout = real

    print(f"{'page':26} {'backend':8} {'text':>5} {'bub':>4} {'sec':>6}")
    for page in args.pages:
        img = cv2.imread(page)
        if img is None:
            print(f"  !! cannot read {page}", file=sys.stderr)
            continue
        for b in backends:
            t0 = time.time()
            try:
                regions = D.detect(img, b, conf=args.conf, ocr=ocr)
            except Exception as e:
                print(f"{os.path.basename(page):26} {b:8} ERR {type(e).__name__}: {e}")
                continue
            dt = time.time() - t0
            text = sum(1 for r in regions if r["cls"] in D.TEXT_CLASSES)
            bub = sum(1 for r in regions if r["cls"] == "bubble")
            print(f"{os.path.basename(page):26} {b:8} {text:5} {bub:4} {dt:6.1f}")
            if args.overlay:
                os.makedirs(args.overlay, exist_ok=True)
                stem = os.path.splitext(os.path.basename(page))[0]
                overlay(page, regions, os.path.join(args.overlay, f"{stem}.{b}.png"))
                json.dump(regions, open(os.path.join(args.overlay, f"{stem}.{b}.json"), "w"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
