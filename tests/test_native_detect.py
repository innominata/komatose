"""Routing regressions; optional real ROCm/CPU parity on licensed test content."""
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ocr'))
import detect
import lettering
import native_detect


class DetectorRouting(unittest.TestCase):
    def setUp(self):
        detect._sessions.clear()

    def tearDown(self):
        detect._sessions.clear()

    def test_cpu_never_initializes_a_native_gpu_model(self):
        # A GPU-capable ONNX installation must still receive only the CPU EP.
        ort = types.SimpleNamespace(SessionOptions=lambda: types.SimpleNamespace(),
                                    InferenceSession=unittest.mock.Mock(return_value=object()))
        hub = types.SimpleNamespace(hf_hub_download=lambda *a, **k: '/fixture/model.onnx')
        with patch.dict(sys.modules, {'onnxruntime': ort, 'huggingface_hub': hub}), \
                patch.object(native_detect, 'CtdSession') as native:
            session = detect._session(detect.CTD_REPO, detect.CTD_FILE, device='cpu')
            self.assertIs(session, detect._session(detect.CTD_REPO, detect.CTD_FILE, device='cpu'))
        native.assert_not_called()
        self.assertEqual(ort.InferenceSession.call_args.kwargs['providers'], ['CPUExecutionProvider'])

    def test_gpu_bypasses_onnx_and_retains_weights_per_device(self):
        with patch.object(native_detect, 'gpu_device', side_effect=lambda choice: choice), \
                patch.object(native_detect, 'CtdSession') as native, \
                patch.dict(sys.modules, {'onnxruntime': None}):
            first = detect._session(detect.CTD_REPO, detect.CTD_FILE, device='cuda:0')
            self.assertIs(first, detect._session(detect.CTD_REPO, detect.CTD_FILE, device='cuda:0'))
            detect._session(detect.CTD_REPO, detect.CTD_FILE, device='cuda:1')
        self.assertEqual(native.call_count, 2)
        self.assertEqual([c.args for c in native.call_args_list], [('cuda:0',), ('cuda:1',)])

    def test_cpu_selection_does_not_probe_torch_gpu(self):
        with patch.dict(sys.modules, {'torch': None}):
            self.assertIsNone(native_detect.gpu_device('cpu'))
            self.assertIsNone(native_detect.gpu_device('auto'))
            with self.assertRaisesRegex(RuntimeError, 'PyTorch is not installed'):
                native_detect.gpu_device('cuda:0')

    def test_ctd_mask_propagates_device_to_full_page_and_crop(self):
        def predict(img, **kwargs):
            return [], np.zeros(img.shape[:2], np.uint8)
        image = np.full((80, 100, 3), 255, np.uint8)
        region = [[{'x':.1,'y':.1}, {'x':.9,'y':.1}, {'x':.9,'y':.9}, {'x':.1,'y':.9}]]
        with patch.object(detect, 'detect_ctd', side_effect=predict) as calls:
            _, _, meta = lettering.propose(image, region, engine='ctd', device='cuda:0')
        self.assertGreaterEqual(calls.call_count, 2)
        self.assertTrue(all(call.kwargs['device'] == 'cuda:0' for call in calls.call_args_list))
        self.assertIn('PyTorch', meta['backend'])


@unittest.skipUnless(os.environ.get('SCAN_TEST_NATIVE_GPU') == '1', 'opt-in real GPU parity')
class DetectorParity(unittest.TestCase):
    def test_licensed_page_matches_cpu_onnx(self):
        import torch
        torch.set_num_threads(2)
        image = cv2.imread(str(ROOT / 'fixtures/test-pages/001.jpg'))
        self.assertIsNotNone(image)
        for backend in ('ctd', 'rtdetr'):
            with self.subTest(backend=backend):
                cpu = detect.detect(image, backend, device='cpu', supplement=False)
                gpu = detect.detect(image, backend, device='cuda:0', supplement=False)
                self.assertGreater(len(cpu), 0)
                if backend == 'ctd':
                    self.assertEqual(len(cpu), len(gpu))
                # RT-DETR's exported graph and HF implementation have small
                # score differences. Compare confident detections in both
                # directions instead of requiring identical threshold ties.
                for region, candidates in [(r, gpu) for r in cpu] + [(r, cpu) for r in gpu]:
                    if backend == 'rtdetr' and region['score'] < .3:
                        continue
                    matches = [r for r in candidates if r['cls'] == region['cls'] and
                               detect._iou_min(r['box'], region['box']) > .9]
                    self.assertTrue(matches, region)
        _, cpu = detect.detect_ctd(image, want_mask=True, device='cpu')
        _, gpu = detect.detect_ctd(image, want_mask=True, device='cuda:0')
        self.assertLess(float(np.abs(cpu.astype(float) - gpu).mean()), .1)


if __name__ == '__main__':
    unittest.main()
