import pathlib
import sys
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'ocr'))
import koharu_mask


class KoharuCache(unittest.TestCase):
    def setUp(self):
        koharu_mask._PREDICTIONS.clear()

    def test_same_page_is_predicted_once_and_callers_get_independent_copies(self):
        page = np.full((40, 30, 3), 200, np.uint8)
        with patch.object(koharu_mask, '_predict', side_effect=lambda image, device: np.full(image.shape[:2], 255, np.uint8)) as run:
            first = koharu_mask.predict(page, 'cpu')
            first[:] = 0
            second = koharu_mask.predict(page.copy(), 'cpu')
            self.assertEqual(run.call_count, 1)
            self.assertTrue((second == 255).all(), 'a caller editing its mask must not change the cache')
            edited = page.copy()
            edited[0, 0] = 0
            koharu_mask.predict(edited, 'cpu')
            koharu_mask.predict(page, 'cuda:0')
            self.assertEqual(run.call_count, 3, 'different pixels or device are predicted again')

    def test_cache_keeps_only_recent_pages(self):
        with patch.object(koharu_mask, '_predict', side_effect=lambda image, device: np.zeros(image.shape[:2], np.uint8)):
            for value in range(koharu_mask._PREDICTION_LIMIT + 2):
                koharu_mask.predict(np.full((4, 4, 3), value, np.uint8))
        self.assertEqual(len(koharu_mask._PREDICTIONS), koharu_mask._PREDICTION_LIMIT)


if __name__ == '__main__':
    unittest.main()
