"""Inpainting contracts and atomic installer behavior without model downloads."""
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ocr'))
import inpaint_models as models
import workflow


class InpaintModels(unittest.TestCase):
    def test_migan_inputs_preserve_rgb_and_remove_mask(self):
        image = np.full((37, 91, 3), [10, 50, 200], np.uint8)
        mask = np.zeros((37, 91), np.uint8)
        mask[5:11, 10:20] = 255
        def fake(x):
            self.assertEqual(tuple(x.shape), (1, 4, 512, 512))
            self.assertEqual(float(x[0, 0, 5, 10]), -0.5)
            self.assertEqual(float(x[0, 0, 0, 0]), 0.5)
            self.assertTrue(torch.all(x[0, 1:, 5, 10] == 0))
            np.testing.assert_allclose(x[0, 1:, 0, 0], np.array([200, 50, 10]) / 127.5 - 1, atol=1e-6)
            return torch.zeros((1, 3, 512, 512))
        result = models.run_inpaint(image, mask, 'migan', 'cpu', (fake,))
        self.assertEqual(result.shape, image.shape)
        self.assertTrue(np.all(result == 128))

    def test_migan_large_crop_resizes_without_stretching(self):
        image = np.zeros((600, 1200, 3), np.uint8)
        mask = np.zeros((600, 1200), np.uint8)
        mask[:, 600:] = 255
        def fake(x):
            self.assertEqual(float(x[0, 0, 255, 400]), -0.5)
            self.assertEqual(float(x[0, 0, 256, 400]), 0.5, 'remaining square is padding')
            return torch.zeros((1, 3, 512, 512))
        self.assertEqual(models.run_inpaint(image, mask, 'migan', 'cpu', (fake,)).shape, image.shape)

    def test_manga_padding_normalization_and_deterministic_noise(self):
        image = np.full((33, 49, 3), 255, np.uint8)
        mask = np.zeros((33, 49), np.uint8)
        mask[10:20, 10:20] = 255
        noises = []
        def lines(gray):
            self.assertEqual(tuple(gray.shape), (1, 1, 48, 64))
            self.assertTrue(torch.all(gray == 255))
            return torch.full_like(gray, 500)
        def inpainter(gray, extracted, selected, noise, ones):
            self.assertTrue(torch.all(gray == 1))
            self.assertTrue(torch.all(extracted == 1), 'lines are clipped then normalized')
            self.assertEqual(float(selected[0, 0, 10, 10]), 1)
            self.assertEqual(float(selected[0, 0, 34, 50]), 0)
            self.assertTrue(torch.all(ones == 1))
            noises.append(noise.clone())
            return torch.zeros_like(gray)
        before = torch.random.get_rng_state()
        for _ in range(2):
            result = models.run_inpaint(image, mask, 'manga-inpainting', 'cpu', (inpainter, lines))
            self.assertEqual(result.shape, image.shape)
            self.assertTrue(np.all(result == 127))
        self.assertTrue(torch.equal(noises[0], noises[1]))
        self.assertTrue(torch.equal(before, torch.random.get_rng_state()), 'other models RNG stays unchanged')

    def test_grayscale_check_covers_full_page_before_loading(self):
        image = np.full((100, 200, 3), 255, np.uint8)
        image[90:, 190:] = [0, 0, 255]  # Outside the selected crop.
        mask = np.zeros(image.shape[:2], np.uint8)
        mask[20:30, 20:30] = 255
        with patch.object(workflow, 'model_inpaint') as inference:
            with self.assertRaisesRegex(ValueError, 'only supports grayscale pages'):
                workflow.clean(image, mask, {'method': 'manga-inpainting'})
            inference.assert_not_called()
        models.require_grayscale(np.full((10, 10, 3), [250, 252, 253], np.uint8))
        models.require_grayscale(np.zeros((10, 10, 3), np.uint8))

    def test_compositing_preserves_unmasked_pixels_for_both_models(self):
        image = np.full((50, 70, 3), 200, np.uint8)
        mask = np.zeros((50, 70), np.uint8)
        mask[15:22, 20:30] = 255
        for name in models.EXPORTS:
            with patch.object(workflow, 'model_inpaint', side_effect=lambda img, *_: np.zeros_like(img)):
                result, method = workflow.clean(image, mask, {'method': name, 'device': 'cpu'})
            self.assertEqual(method, name)
            np.testing.assert_array_equal(result[mask == 0], image[mask == 0])
            self.assertTrue(np.all(result[mask > 0] == 0))

    def test_worker_reports_actual_cpu_and_gpu_backends(self):
        image = np.full((30, 40, 3), 200, np.uint8)
        mask = np.full((30, 40), 255, np.uint8)
        with tempfile.TemporaryDirectory() as directory:
            source, mask_path, output = [str(Path(directory) / filename) for filename in ('input.png', 'mask.png', 'output.png')]
            cv2.imwrite(source, image)
            cv2.imwrite(mask_path, mask)
            for name in models.EXPORTS:
                for device in ('cpu', 'cuda:0'):
                    with patch.object(workflow, 'clean', return_value=(image, name)):
                        result = workflow.run({'cmd': 'clean', 'path': source, 'mask': mask_path, 'out': output, 'device': device})
                    self.assertEqual(result['method'], name)
                    self.assertIn('GPU' if device.startswith('cuda') else 'CPU', result['backend'])
                    self.assertIn('PyTorch', result['backend'])

    def test_download_is_atomic_and_invalid_data_keeps_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.pt'
            path.write_bytes(b'old')
            checksum = hashlib.md5(b'valid').hexdigest()
            with patch.object(models.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')):
                with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                    models.download_verified('https://example.com/model', path, checksum)
            self.assertEqual(path.read_bytes(), b'old')
            self.assertEqual(list(Path(directory).glob('*.part')), [])
            with patch.object(models.urllib.request, 'urlopen', return_value=io.BytesIO(b'valid')):
                models.download_verified('https://example.com/model', path, checksum)
            self.assertEqual(path.read_bytes(), b'valid')
            with patch.object(models.urllib.request, 'urlopen') as request:
                models.download_verified('https://example.com/model', path, checksum)
                request.assert_not_called()

    def test_interrupted_download_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'model.pt'
            with patch.object(models.urllib.request, 'urlopen', side_effect=TimeoutError('interrupted')):
                with self.assertRaises(TimeoutError):
                    models.download_verified('https://example.com/model', path, 'invalid')
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_both_manga_artifacts_are_required_with_custom_root(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, SCAN_WORKFLOW_MODELS_DIR=directory):
            target = Path(directory) / 'manga-inpainting'
            target.mkdir()
            (target / 'manga_inpaintor.jit').touch()
            with self.assertRaisesRegex(ValueError, 'Install manga-inpainting'):
                models.require_installed('manga-inpainting')
            (target / 'erika.jit').touch()
            self.assertEqual(models.require_installed('manga-inpainting'), target)


if __name__ == '__main__':
    unittest.main()
