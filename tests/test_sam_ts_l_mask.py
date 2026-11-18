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
import sam_ts_l_mask


class SamTsLMask(unittest.TestCase):
    def test_tile_spans_overlap_and_end_flush(self):
        self.assertEqual(sam_ts_l_mask.tile_spans(800, 1024), [(0, 800)])
        spans = sam_ts_l_mask.tile_spans(6490, 1024)
        self.assertEqual(spans[0], (0, 1024))
        self.assertEqual(spans[-1], (6490 - 1024, 6490))
        for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
            self.assertGreaterEqual(a1 - b0, 256)  # neighbours overlap by at least a quarter tile

    def test_long_strip_is_read_in_tiles_at_full_resolution(self):
        calls = []
        def fake(image, device):
            calls.append(image.shape[:2])
            return np.full(image.shape[:2], 255, np.uint8)
        with patch.object(sam_ts_l_mask, '_predict', side_effect=fake):
            mask = sam_ts_l_mask._predict_tiled(np.zeros((6490, 690, 3), np.uint8), 'cpu')
            self.assertEqual(mask.shape, (6490, 690))
            self.assertTrue(np.all(mask == 255))
            # Each tile is 690 wide and 1024 tall: the model reads it unshrunk.
            self.assertTrue(all(shape == (1024, 690) for shape in calls))
            self.assertGreater(len(calls), 6)
            calls.clear()
            sam_ts_l_mask._predict_tiled(np.zeros((1400, 1000, 3), np.uint8), 'cpu')
            self.assertEqual(calls, [(1400, 1000)])  # an ordinary page stays one pass
            calls.clear()
            sam_ts_l_mask._predict_tiled(np.zeros((600, 3000, 3), np.uint8), 'cpu')
            self.assertTrue(all(shape == (600, 1024) for shape in calls))

    def test_resolve_engine_respects_explicit_ctd(self):
        with patch.object(sam_ts_l_mask, 'installed', return_value=True):
            self.assertEqual(lettering.resolve_engine('ctd'), 'ctd')
            self.assertEqual(lettering.resolve_engine('auto'), 'sam-ts-l')

    def test_missing_sam_ts_l_errors_when_requested(self):
        with patch.object(sam_ts_l_mask, 'installed', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'install-sam-ts-l'):
                lettering.resolve_engine('sam-ts-l')

    def test_sam_ts_l_clips_expansion_to_regions(self):
        image = np.zeros((120, 160, 3), np.uint8)
        regions = [[{'x': .1, 'y': .1}, {'x': .4, 'y': .1}, {'x': .4, 'y': .4}, {'x': .1, 'y': .4}]]
        raw = np.zeros(image.shape[:2], np.uint8)
        raw[10:100, 10:150] = 255
        with patch.object(sam_ts_l_mask, 'predict', return_value=raw):
            mask, diagnostics, meta = lettering.propose_sam_ts_l(image, regions, expansion=3, device='cpu')
        self.assertEqual(meta['engine'], 'sam-ts-l')
        self.assertEqual(mask[20, 20], 255)
        self.assertEqual(mask[0, 0], 0)
        self.assertEqual(mask[50, 100], 0)
        self.assertNotIn('empty coverage', diagnostics[0]['reasons'])

    def test_coordinate_resize_roundtrip(self):
        fixture = pathlib.Path(__file__).parents[1] / 'tests/fixtures/lettering/1-required.png'
        if not sam_ts_l_mask.installed() or not fixture.is_file():
            self.skipTest('SAM-TS-L weights or lettering fixture not present')
        required = cv2.imread(str(fixture), cv2.IMREAD_GRAYSCALE)
        image = np.full((required.shape[0], required.shape[1], 3), 220, np.uint8)
        image[required > 0] = (0, 0, 0)
        mask = sam_ts_l_mask.predict(image, 'cpu')
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
        self.assertTrue(all(row['backend'] == 'sam-ts-l' and row['cls'] == 'text' for row in rows))
        top = min(rows, key=lambda row: row['box'][1])
        self.assertLess(top['box'][0], 25)
        self.assertGreater(top['box'][2], 75)
        self.assertLess(top['box'][3], 60)

    def test_saved_masks_cover_annotated_lettering(self):
        root = pathlib.Path(__file__).parents[1]
        ann_path = root / 'tests/fixtures/lettering/annotations.json'
        masks = root / 'data/bench-lettering/model-comparison/sam-ts-l'
        if not ann_path.is_file() or not (masks / '1-mask.png').is_file():
            self.skipTest('saved SAM-TS-L masks are not present')
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
        with patch.object(sam_ts_l_mask, 'predict', return_value=raw), \
                patch.object(sam_ts_l_mask, 'installed', return_value=True), \
                patch.object(sam_ts_l_mask, 'runtime_backend', return_value='CPU'):
            regions, mask, meta = lettering.detect_text(image, 'cpu', 2)
        self.assertEqual(meta['engine'], 'sam-ts-l')
        self.assertEqual(meta['model'], 'SAM-TS-L')
        self.assertEqual(len(regions), 1)
        self.assertGreater(int(mask.sum()), int(raw.sum()))

    def test_weights_checksum(self):
        path = sam_ts_l_mask.weights_path()
        if not path.is_file():
            self.skipTest('SAM-TS-L weights not present')
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(digest, sam_ts_l_mask.WEIGHT_SHA256)


if __name__ == '__main__':
    unittest.main()
