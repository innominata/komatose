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

    def test_free_text_rectangle_is_not_split_by_overlapping_regions(self):
        points = [{'x': .1, 'y': .1}, {'x': .9, 'y': .1}, {'x': .9, 'y': .9}, {'x': .1, 'y': .9}]
        result = workflow.geometry(np.full((100, 100, 3), 255, np.uint8), {
            'kind': 'free', 'method': 'split', 'polygon': points,
            'box': [.1, .1, .8, .8], 'neighbors': [[.5, .5, .2, .2]]})
        self.assertEqual(result['polygon'], points)
        self.assertFalse(result['split'])

if __name__ == '__main__':
    unittest.main()
