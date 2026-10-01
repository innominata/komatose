#!/usr/bin/env python3
"""Imsbee source prep always; real checkpoint quality when weights are installed."""
import importlib.util
import os
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
CKPT = ROOT / "data/models/translation/imsbee-ko-en-translator/sentence-base/best.pt"
TOK = ROOT / "data/models/translation/imsbee-ko-en-translator/tokenizer.json"

spec = importlib.util.spec_from_file_location("ko_en_translate", ROOT / "ocr" / "ko_en_translate.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SourcePrep(unittest.TestCase):
    def test_vertical_syllables_concatenate(self):
        self.assertEqual(worker.join_ocr_lines("기\n다\n려\n!"), "기다려!")

    def test_word_wrapped_bubbles_keep_spaces(self):
        self.assertEqual(
            worker.join_ocr_lines("네가\n나를\n사랑한다고\n했잖아!"),
            "네가 나를 사랑한다고 했잖아!",
        )
        self.assertEqual(worker.join_ocr_lines("오늘은 그냥\n집에 가자"), "오늘은 그냥 집에 가자")

    def test_newlines_are_not_sentence_breaks(self):
        self.assertEqual(
            worker.split_sentences("네가\n나를\n사랑한다고\n했잖아!"),
            ["네가 나를 사랑한다고 했잖아!"],
        )
        self.assertEqual(worker.sentences_for_decode("기다려!\n뭐야, 너 지금 어디야?"), ["기다려! 뭐야, 너 지금 어디야?"])

    def test_long_text_can_split_on_punctuation_only(self):
        long = "기다려! " + ("한 명의 환자가 부분 반응을 보였다. " * 8)
        parts = worker.sentences_for_decode(long, token_count=lambda text: 200)
        self.assertGreater(len(parts), 1)
        self.assertTrue(all("\n" not in part for part in parts))
        self.assertTrue(any("환자" in part for part in parts))

    def test_short_collapse_detects_ill_tell_you(self):
        self.assertTrue(worker.collapsed_short_translation("말할기회를 주겠다", "I'll tell you."))
        self.assertFalse(worker.collapsed_short_translation("기다려!", "Wait!"))
        self.assertFalse(worker.collapsed_short_translation("말할 기회를 주겠다", "I'll give you a chance."))


def _imsbee_ready():
    if not (CKPT.is_file() and TOK.is_file()):
        return False
    try:
        import torch  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(_imsbee_ready(), "Imsbee checkpoint or PyTorch is not available")
class CheckpointQuality(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        os.environ["HIP_VISIBLE_DEVICES"] = ""
        import sys
        sys.path.insert(0, str(ROOT / "ocr"))
        import torch
        from ko_en.minrnn import MinRNNConfig, MinRNNSeq2Seq
        from ko_en.tokenizer import load_tokenizer
        from ko_en.translate_runtime import beam_translate, greedy_translate

        ckpt = torch.load(CKPT, map_location="cpu", weights_only=False)
        model = MinRNNSeq2Seq(MinRNNConfig(**ckpt["config"]))
        model.load_state_dict(ckpt["model"])
        model.eval()
        cls.model = model
        cls.tok = load_tokenizer(TOK)
        cls.torch = torch
        cls.greedy_translate = staticmethod(greedy_translate)
        cls.beam_translate = staticmethod(beam_translate)

    def translate(self, source: str) -> str:
        with self.torch.inference_mode():
            return worker.translate_korean(
                self.model, self.tok, "cpu", source,
                greedy_fn=self.greedy_translate, beam_fn=self.beam_translate,
            )

    def test_publisher_samples_are_on_topic(self):
        wait = self.translate("기다려!")
        self.assertRegex(wait, r"(?i)\bwait\b")
        patient = self.translate("한 명의 환자가 부분 반응을 보였다")
        self.assertRegex(patient, r"(?i)\bpatient\b")
        self.assertRegex(patient, r"(?i)\b(reaction|response)\b")

    def test_manga_dialogue_stays_coherent(self):
        loved = self.translate("네가 나를 사랑한다고 했잖아!")
        self.assertRegex(loved, r"(?i)\b(love[d]?|said)\b")
        self.assertNotRegex(loved, r"(?i)\b(gui|lem)\b")

    def test_ocr_line_wraps_do_not_become_random_words(self):
        wrapped = self.translate("네가\n나를\n사랑한다고\n했잖아!")
        self.assertRegex(wrapped, r"(?i)loved me")
        syllables = self.translate("기\n다\n려\n!")
        self.assertRegex(syllables, r"(?i)\bwait\b")
        self.assertNotRegex(syllables, r"(?i)\b(gui|lem)\b")

    def test_glued_chance_clause_does_not_collapse_to_ill_tell_you(self):
        self.assertEqual(worker.respace_hangul(self.tok, "말할기회를 주겠다"), "말할 기회를 주겠다")
        english = self.translate("말할기회를 주겠다")
        self.assertRegex(english, r"(?i)\bchance\b")
        self.assertNotRegex(english, r"(?i)^I'll tell you\.?$")


if __name__ == "__main__":
    unittest.main()
