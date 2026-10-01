#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sugoi_translate", ROOT / "ocr" / "sugoi_translate.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class DeviceFallback(unittest.TestCase):
    def test_cpu_aliases_stay_on_cpu(self):
        self.assertEqual(worker.ctranslate2_device("cpu"), "cpu")
        self.assertEqual(worker.ctranslate2_device("none"), "cpu")
        self.assertEqual(worker.ctranslate2_device(""), "cpu")

    def test_cuda_falls_back_when_ctranslate2_cannot_use_it(self):
        try:
            import ctranslate2
        except ImportError:
            self.skipTest("ctranslate2 is not installed")
        try:
            usable = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            usable = False
        self.assertEqual(worker.ctranslate2_device("cuda"), "cuda" if usable else "cpu")


if __name__ == "__main__":
    unittest.main()
