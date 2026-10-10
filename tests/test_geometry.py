"""Regression crops from the four uncleaned geometry evaluation pages."""
import importlib.util
import json
import pathlib
import unittest
import cv2
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('workflow', ROOT / 'ocr/workflow.py')
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


class Geometry(unittest.TestCase):
    def test_page16_joined_bubbles_have_separate_polygons(self):
        cases = json.loads((ROOT / 'tests/fixtures/geometry/page16.json').read_text())
        for case in cases:
            with self.subTest(case=case['name']):
                img = cv2.imread(str(ROOT / case['image']))
                self.assertIsNotNone(img, 'licensed page 16 fixture must be present')
                H, W = img.shape[:2]
                boxes = [[r['box'][0] / W, r['box'][1] / H,
                          (r['box'][2] - r['box'][0]) / W,
                          (r['box'][3] - r['box'][1]) / H]
                         for r in case['outputs']['rtdetr'] if r['cls'] == 'text_bubble']
                self.assertEqual(len(boxes), 2)
                results = workflow.run({'cmd': 'geometry-batch', 'path': str(ROOT / case['image']),
                                        'method': 'opencv', 'regions': [
                                            {'box': box, 'kind': 'bubble'} for box in boxes]})['regions']
                masks = []
                centers = [(int((b[0] + b[2] / 2) * W), int((b[1] + b[3] / 2) * H)) for b in boxes]
                for i, result in enumerate(results):
                    self.assertTrue(result['split'])
                    self.assertGreaterEqual(len(result['polygon']), 6)
                    mask = np.zeros((H, W), np.uint8)
                    points = np.array([[round(p['x'] * W), round(p['y'] * H)]
                                       for p in result['polygon']], np.int32)
                    cv2.fillPoly(mask, [points], 255)
                    own, other = centers[i], centers[1 - i]
                    self.assertGreater(mask[own[1], own[0]], 0)
                    self.assertEqual(mask[other[1], other[0]], 0)
                    self.assertGreater(np.count_nonzero(mask), boxes[i][2] * W * boxes[i][3] * H)
                    masks.append(mask)
                self.assertEqual(np.count_nonzero(masks[0] & masks[1]), 0)

    def test_real_enclosures_and_artwork(self):
        fixtures = ROOT / 'tests/fixtures/geometry'
        cases = json.loads((fixtures / 'cases.json').read_text())
        missing = [case['name'] for case in cases if not (fixtures / (case['name'] + '.png')).is_file()]
        if missing:
            self.skipTest('private geometry crops are not present: ' + ', '.join(missing))
        for case in cases:
            img = cv2.imread(str(fixtures / (case['name'] + '.png')))
            for i, box in enumerate(case['boxes']):
                with self.subTest(case=case['name'], region=i):
                    result = workflow.geometry(img, {'box': box, 'neighbors':
                        [b for j, b in enumerate(case['boxes']) if i != j]})
                    self.assertEqual(bool(result['polygon']), case['found'])
                    if result['polygon']:
                        self.assertGreater(result['confidence'], 0)
                        self.assertTrue(all(0 <= p['x'] <= 1 and 0 <= p['y'] <= 1 for p in result['polygon']))

    def test_free_text_does_not_take_an_enclosing_phone_or_panel(self):
        img = np.full((300, 400, 3), 255, np.uint8)
        cv2.rectangle(img, (40, 40), (360, 260), (0, 0, 0), 4)
        result = workflow.geometry(img, {'box': [.3, .3, .4, .4], 'kind': 'free'})
        self.assertEqual(result['polygon'], [])
        self.assertEqual(result['confidence'], 0)

    def test_caption_box_inside_or_around_the_region(self):
        img = np.full((400, 500, 3), 255, np.uint8)
        cv2.rectangle(img, (40, 30), (260, 190), (0, 0, 0), 3)
        # Text sitting inside the frame: the stroke is in the expanded margin.
        tight = workflow.geometry(img, {'box': [80 / 500, 60 / 400, 140 / 500, 90 / 400], 'kind': 'free'})
        self.assertTrue(tight.get('boxed'))
        self.assertEqual(len(tight['polygon']), 4)
        self.assertGreater(tight['confidence'], 0)
        # Detector box already contains the frame.
        loose = workflow.geometry(img, {'box': [20 / 500, 10 / 400, 270 / 500, 210 / 400], 'kind': 'free'})
        self.assertTrue(loose.get('boxed'))
        self.assertEqual(len(loose['polygon']), 4)

    def test_oval_and_filled_black_are_not_caption_boxes(self):
        oval = np.full((300, 300, 3), 255, np.uint8)
        cv2.ellipse(oval, (150, 150), (90, 55), 0, 0, 360, (0, 0, 0), 3)
        result = workflow.geometry(oval, {'box': [80 / 300, 110 / 300, 140 / 300, 80 / 300], 'kind': 'free'})
        self.assertEqual(result['polygon'], [])
        filled = np.full((200, 200, 3), 255, np.uint8)
        cv2.rectangle(filled, (30, 30), (160, 140), (0, 0, 0), -1)
        result = workflow.geometry(filled, {'box': [50 / 200, 50 / 200, 80 / 200, 50 / 200], 'kind': 'bubble'})
        self.assertFalse(result.get('boxed', False))

    def test_manhwa_caption_boxes(self):
        pages = json.loads((ROOT / 'fixtures/manhwa-pages/gold.json').read_text())
        expect = {
            '003-mood': True, '003-worry': True, '007-stairs': True,
            '003-rumour': False, '004-listen': False, '007-message': False, '008-silence': False,
        }
        by_id = {}
        for page in pages:
            img = cv2.imread(str(ROOT / page['file']))
            self.assertIsNotNone(img, page['file'])
            height, width = img.shape[:2]
            for line in page['lines']:
                if line['id'] not in expect:
                    continue
                x0, y0, x1, y1 = line['boxes'][0]
                result = workflow.geometry(img, {'box': [
                    x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height,
                ], 'kind': 'free'})
                by_id[line['id']] = bool(result.get('boxed'))
                if expect[line['id']]:
                    self.assertGreaterEqual(len(result['polygon']), 4, line['id'])
        self.assertEqual(by_id, expect)

    def test_free_text_rectangle_is_not_split_by_overlapping_regions(self):
        points = [{'x': .1, 'y': .1}, {'x': .9, 'y': .1}, {'x': .9, 'y': .9}, {'x': .1, 'y': .9}]
        result = workflow.geometry(np.full((100, 100, 3), 255, np.uint8), {
            'kind': 'free', 'method': 'split', 'polygon': points,
            'box': [.1, .1, .8, .8], 'neighbors': [[.5, .5, .2, .2]]})
        self.assertEqual(result['polygon'], points)
        self.assertFalse(result['split'])

if __name__ == '__main__':
    unittest.main()
