import hashlib
import json
import os
import pathlib
import sys
import unittest
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'ocr'))
import lettering
import koharu_mask


class KoharuMask(unittest.TestCase):
    def test_resolve_engine_respects_explicit_ctd(self):
        with patch.object(koharu_mask, 'installed', return_value=True):
            self.assertEqual(lettering.resolve_engine('ctd'), 'ctd')
            self.assertEqual(lettering.resolve_engine('auto'), 'koharu')

    def test_missing_koharu_errors_when_requested(self):
        with patch.object(koharu_mask, 'installed', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'install-koharu'):
                lettering.resolve_engine('koharu')

    def test_koharu_clips_expansion_to_regions(self):
        image = np.zeros((120, 160, 3), np.uint8)
        regions = [[{'x': .1, 'y': .1}, {'x': .4, 'y': .1}, {'x': .4, 'y': .4}, {'x': .1, 'y': .4}]]
        raw = np.zeros(image.shape[:2], np.uint8)
        raw[10:100, 10:150] = 255
        with patch.object(koharu_mask, 'predict', return_value=raw):
            mask, diagnostics, meta = lettering.propose_koharu(image, regions, expansion=3, device='cpu')
        self.assertEqual(meta['engine'], 'koharu')
        self.assertEqual(mask[20, 20], 255)
        self.assertEqual(mask[0, 0], 0)
        self.assertEqual(mask[50, 100], 0)
        self.assertNotIn('empty coverage', diagnostics[0]['reasons'])

    def test_coordinate_resize_roundtrip(self):
        fixture = pathlib.Path(__file__).parents[1] / 'tests/fixtures/lettering/1-required.png'
        if not koharu_mask.installed() or not fixture.is_file():
            self.skipTest('Koharu weights or lettering fixture not present')
        required = cv2.imread(str(fixture), cv2.IMREAD_GRAYSCALE)
        image = np.full((required.shape[0], required.shape[1], 3), 220, np.uint8)
        image[required > 0] = (0, 0, 0)
        mask = koharu_mask.predict(image, 'cpu')
        self.assertEqual(mask.shape, image.shape[:2])
        overlap = np.count_nonzero((mask > 0) & (required > 0))
        self.assertGreater(overlap / max(1, int(required.sum() / 255)), .5)

    def test_regions_from_mask_join_a_line_and_keep_the_next_one(self):
        mask = np.zeros((200, 220), np.uint8)
        mask[20:40, 20:35] = 255
        mask[20:40, 42:57] = 255
        mask[20:40, 64:80] = 255
        mask[120:145, 30:90] = 255
        mask[180:182, 180:183] = 255
        rows = lettering.regions_from_mask(mask)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(row['backend'] == 'koharu' and row['cls'] == 'text' for row in rows))
        top = min(rows, key=lambda row: row['box'][1])
        self.assertLess(top['box'][0], 25)
        self.assertGreater(top['box'][2], 75)
        self.assertLess(top['box'][3], 60)

    def test_saved_masks_cover_annotated_lettering(self):
        root = pathlib.Path(__file__).parents[1]
        ann_path = root / 'tests/fixtures/lettering/annotations.json'
        masks = root / 'data/bench-lettering/model-comparison/koharu'
        if not ann_path.is_file() or not (masks / '1-mask.png').is_file():
            self.skipTest('saved Koharu masks are not present')
        annotations = json.loads(ann_path.read_text())
        for page, spec in annotations.items():
            mask = cv2.imread(str(masks / f'{page}-mask.png'), cv2.IMREAD_GRAYSCALE)
            self.assertIsNotNone(mask)
            rows = lettering.regions_from_mask(mask)
            self.assertLess(len(rows), 80, page)
            covered = np.zeros(mask.shape, np.uint8)
            for row in rows:
                x0, y0, x1, y1 = (int(v) for v in row['box'])
                covered[y0:y1, x0:x1] = 1
            for box in spec['boxes']:
                x0, y0, x1, y1 = box
                pixels = mask[y0:y1, x0:x1] > 127
                if not pixels.any():
                    continue
                recall = np.count_nonzero(pixels & (covered[y0:y1, x0:x1] > 0)) / np.count_nonzero(pixels)
                self.assertGreaterEqual(recall, 0.9, f'page {page} {box}')

    def test_detect_text_expands_mask_without_loading_weights(self):
        image = np.zeros((80, 90, 3), np.uint8)
        raw = np.zeros((80, 90), np.uint8)
        raw[10:30, 12:40] = 255
        with patch.object(koharu_mask, 'predict', return_value=raw), \
                patch.object(koharu_mask, 'installed', return_value=True), \
                patch.object(koharu_mask, 'runtime_backend', return_value='CPU'):
            regions, mask, meta = lettering.detect_text(image, 'cpu', 2)
        self.assertEqual(meta['engine'], 'koharu')
        self.assertEqual(meta['model'], 'Koharu SAM-TS-L')
        self.assertEqual(len(regions), 1)
        self.assertGreater(int(mask.sum()), int(raw.sum()))

    def test_weights_checksum(self):
        path = koharu_mask.weights_path()
        if not path.is_file():
            self.skipTest('Koharu weights not present')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(digest, koharu_mask.WEIGHT_SHA256)


if __name__ == '__main__':
    unittest.main()
