import pathlib
import sys
import unittest
from unittest.mock import MagicMock, patch

import numpy as np
import torch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'ocr'))
import worker
import workflow


class LamaDevice(unittest.TestCase):
    def test_native_model_is_cached_per_device_and_loads_the_manga_checkpoint(self):
        cpu, gpu = MagicMock(), MagicMock()
        cpu.to.return_value.eval.return_value = cpu
        gpu.to.return_value.eval.return_value = gpu
        loader = MagicMock()
        loader.load_from_state_dict.side_effect = [cpu, gpu]
        with patch.object(worker, '_lama', {}), \
                patch.dict('os.environ', {'SCAN_LAMA_CHECKPOINT': ''}), \
                patch.dict(sys.modules, {'onnxruntime': None}), \
                patch('huggingface_hub.hf_hub_download', return_value='lama-manga.safetensors') as download, \
                patch('torch.load', side_effect=AssertionError('LaMa Manga must use SafeTensors')), \
                patch('safetensors.torch.load_file', return_value={'model.weight': 'weight'}) as load, \
                patch('spandrel.ModelLoader', return_value=loader):
            self.assertIs(worker._get_lama('cpu'), cpu)
            self.assertIs(worker._get_lama('cuda:1'), gpu)
            self.assertIs(worker._get_lama('cuda:1'), gpu)
        self.assertEqual(load.call_count, 2)
        load.assert_called_with('lama-manga.safetensors', device='cpu')
        download.assert_called_with('mayocream/lama-manga', 'lama-manga.safetensors',
                                  revision='f91c85b26913b3e83f9877867b4c336da3675238')
        loader.load_from_state_dict.assert_called_with({'generator.model.weight': 'weight'})
        cpu.to.assert_called_once_with('cpu')
        gpu.to.assert_called_once_with('cuda:1')

    def test_checkpoint_override_works_offline(self):
        model = MagicMock()
        with patch.object(worker, '_lama', {}), \
                patch.dict('os.environ', {'SCAN_LAMA_CHECKPOINT': '/custom/lama-manga.safetensors'}), \
                patch('huggingface_hub.hf_hub_download', side_effect=AssertionError('download')), \
                patch('safetensors.torch.load_file', return_value={'generator.weight': 'weight'}) as load, \
                patch('spandrel.ModelLoader', return_value=model):
            worker._get_lama('cpu')
        load.assert_called_once_with('/custom/lama-manga.safetensors', device='cpu')
        model.load_from_state_dict.assert_called_once_with({'generator.weight': 'weight'})

    def test_varying_shapes_preserve_pixels_and_masks_and_send_both_inputs_to_gpu(self):
        class EchoModel:
            def __call__(self, image, mask):
                self.image, self.mask = image, mask
                self.inference = torch.is_inference_mode_enabled()
                return image
        model = EchoModel()
        for height, width in ((117, 123), (129, 240), (320, 501)):
            img = np.arange(height * width * 3, dtype=np.uint8).reshape(height, width, 3)
            mask = np.zeros((height, width), np.uint8)
            mask[40:60, 50:70] = 255
            devices = []
            def record_device(tensor, device):
                devices.append(device)
                return tensor
            with patch.object(worker, '_get_lama', return_value=model) as get, \
                    patch.object(torch.Tensor, 'to', record_device), \
                    patch.dict(sys.modules, {'onnxruntime': None}):
                result = worker._lama_run(img, mask, 'cuda:1')
            get.assert_called_once_with('cuda:1')
            self.assertEqual(devices, ['cuda:1', 'cuda:1'])
            self.assertTrue(model.inference)
            np.testing.assert_array_equal(result, img)
            self.assertEqual(tuple(model.image.shape),
                             (1, 3, height + (-height) % 8, width + (-width) % 8))
            np.testing.assert_array_equal(model.mask.numpy()[0, 0, :height, :width], mask > 0)
            self.assertEqual(int(model.mask.count_nonzero()), 400)

    def test_workflow_passes_the_selected_device_and_keeps_unmasked_pixels(self):
        img = np.full((117, 123, 3), 90, np.uint8)
        mask = np.zeros((117, 123), np.uint8)
        mask[40:60, 50:70] = 255
        with patch.object(worker, '_lama_run', side_effect=lambda image, mask, device: np.full_like(image, 77)) as run:
            result, method = workflow.clean(img, mask, {'method': 'lama', 'device': 'cuda:1'})
        self.assertEqual(method, 'lama')
        self.assertEqual(run.call_args.args[2], 'cuda:1')
        self.assertTrue(np.all(result[mask > 0] == 77))
        np.testing.assert_array_equal(result[mask == 0], img[mask == 0])


if __name__ == '__main__':
    unittest.main()
