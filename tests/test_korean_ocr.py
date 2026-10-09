"""Offline installer integrity and crop-result handling; no downloads or GPU needed."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'ocr'))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


worker = module("ppocr_worker", ROOT / "ocr/ppocr_korean_review.py")
installer = module("review_installer", ROOT / "scripts/install-review-models.py")


class KoreanOcrTests(unittest.TestCase):
    def test_verified_install_reuses_assets_offline_and_rejects_damage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache, dest = root / "cache", root / "models"
            hashes = {}
            for name in installer.PPOCR_WEIGHT_SHA256:
                folder = cache / name
                folder.mkdir(parents=True)
                for file in installer.MODELS["pp-ocrv5-korean"][2]:
                    (folder / file).write_bytes(b"fixture")
                hashes[name] = hashlib.sha256(b"fixture").hexdigest()
            with patch.object(installer, "DEST", dest), patch.object(installer, "PPOCR_WEIGHT_SHA256", hashes):
                receipt = installer.install_paddle_cache(cache)
                installed = {"pp-ocrv5-korean": receipt}
                self.assertEqual(installer.verified_paddle_install(installed), receipt)
                file = dest / "pp-ocrv5-korean/detector/inference.pdiparams"
                file.write_bytes(b"changed")  # Same size; only the SHA256 check catches this.
                self.assertIsNone(installer.verified_paddle_install(installed))
                file.unlink()
                self.assertIsNone(installer.verified_paddle_install(installed))
                self.assertIsNone(installer.verified_paddle_install({"pp-ocrv5-korean": {"detector": []}}))

    def test_cache_hash_mismatch_preserves_previous_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache, dest = root / "cache", root / "models"
            hashes = {}
            for name in installer.PPOCR_WEIGHT_SHA256:
                folder = cache / name
                folder.mkdir(parents=True)
                for file in installer.MODELS["pp-ocrv5-korean"][2]:
                    (folder / file).write_bytes(b"fixture")
                hashes[name] = hashlib.sha256(b"fixture").hexdigest()
            previous = dest / "pp-ocrv5-korean/recognizer/inference.pdiparams"
            previous.parent.mkdir(parents=True)
            previous.write_bytes(b"working previous weights")
            hashes["PP-OCRv5_server_det"] = "invalid"
            with patch.object(installer, "DEST", dest), patch.object(installer, "PPOCR_WEIGHT_SHA256", hashes):
                with self.assertRaisesRegex(RuntimeError, "SHA256 mismatch"):
                    installer.install_paddle_cache(cache)
                self.assertEqual(previous.read_bytes(), b"working previous weights")
                self.assertFalse((dest / "pp-ocrv5-korean/detector").exists())
                hashes["PP-OCRv5_server_det"] = hashlib.sha256(b"fixture").hexdigest()
                receipt = installer.install_paddle_cache(cache)
                self.assertEqual(set(receipt), {"recognizer", "detector"})
                self.assertEqual(previous.read_bytes(), b"fixture")

    def test_multiline_results_and_empty_detection_preserve_text(self):
        import numpy as np
        class Image:
            def convert(self, mode):
                return np.zeros((4, 4, 3), dtype=np.uint8)
        class Model:
            def predict(self, image):
                return [{"rec_texts": [" 기다려! ", "", "정말 괜찮아요?"],
                         "rec_scores": np.array([0.98, 0.0, 0.91])}]
        result = worker.recognize(Model(), Image())
        self.assertEqual(result["source"], "기다려!\n정말 괜찮아요?")
        self.assertAlmostEqual(result["confidence"], 0.91)
        with patch.object(Model, "predict", return_value=[{"rec_texts": [], "rec_scores": np.array([])}]):
            self.assertEqual(worker.recognize(Model(), Image()), {"source": "", "confidence": None})


if __name__ == "__main__":
    unittest.main()
