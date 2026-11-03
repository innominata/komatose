import pathlib
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / 'ocr'))
import mask_fit  # noqa: E402


def balloon_page():
    """A white balloon with a black outline on grey art, and one glyph inside."""
    img = np.full((300, 300, 3), 120, np.uint8)
    cv2.circle(img, (150, 150), 100, (255, 255, 255), -1)
    cv2.circle(img, (150, 150), 100, (0, 0, 0), 3)
    cv2.rectangle(img, (130, 120), (170, 180), (0, 0, 0), -1)
    seed = np.zeros((300, 300), np.uint8)
    seed[120:181, 130:171] = 255
    return img, seed


def outlined_sfx_page():
    """Black glyphs with a 1 px white outline on dark art, a dot the model missed, and a ring glyph."""
    img = np.full((200, 400, 3), 40, np.uint8)
    seed = np.zeros((200, 400), np.uint8)
    for x0 in (40, 140):
        cv2.rectangle(img, (x0 - 1, 59), (x0 + 61, 141), (255, 255, 255), 1)
        cv2.rectangle(img, (x0, 60), (x0 + 60, 140), (0, 0, 0), -1)
        seed[60:141, x0:x0 + 61] = 255
    # A ring glyph: its counter shows the art through it and must stay unmasked.
    cv2.circle(img, (290, 100), 41, (255, 255, 255), 1)
    cv2.circle(img, (290, 100), 40, (0, 0, 0), 12)
    cv2.circle(img, (290, 100), 33, (255, 255, 255), 1)
    cv2.circle(img, (290, 100), 32, (5, 5, 5), -1)
    ring = np.zeros((200, 400), np.uint8)
    cv2.circle(ring, (290, 100), 40, 255, 12)
    seed |= ring
    # The missed ellipsis dot.
    cv2.circle(img, (360, 130), 7, (255, 255, 255), -1)
    cv2.circle(img, (360, 130), 6, (0, 0, 0), -1)
    return img, seed


class MaskFit(unittest.TestCase):
    def test_missed_outlined_dot_is_added_but_glyph_counters_are_not(self):
        img, seed = outlined_sfx_page()
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[40:160, 20:390] = 255
        fitted = mask_fit.fit_region(gray, seed, allowed, 'outside', 0, page)
        self.assertTrue(fitted[130, 360], 'the dot drawn like the glyphs is masked')
        self.assertFalse(fitted[100, 290], "the ring glyph's counter stays unmasked")
        # Outside the region nothing is added.
        allowed_left = np.zeros_like(seed)
        allowed_left[40:160, 20:220] = 255
        self.assertFalse(mask_fit.fit_region(gray, seed, allowed_left, 'outside', 0, page)[130, 360])


    def test_inside_grows_on_flat_paper(self):
        img, seed = balloon_page()
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[100:200, 110:190] = 255
        fitted = mask_fit.fit_region(gray, seed, allowed, 'inside', 0, page)
        # Grown past the glyph on every side, by more than the anti-aliasing pixel.
        self.assertTrue(np.all(fitted[seed > 0] > 0))
        self.assertGreater(fitted[150, 130 - 3], 0)
        self.assertGreater(fitted[120 - 3, 150], 0)

    def test_inside_growth_stops_at_the_balloon_outline(self):
        img = np.full((200, 200, 3), 255, np.uint8)
        cv2.line(img, (100, 0), (100, 199), (0, 0, 0), 2)
        cv2.rectangle(img, (60, 80), (95, 120), (0, 0, 0), -1)
        seed = np.zeros((200, 200), np.uint8)
        seed[80:121, 60:96] = 255
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[60:140, 40:140] = 255
        fitted = mask_fit.fit_region(gray, seed, allowed, 'inside', 0, page)
        self.assertFalse(np.any(fitted[:, 99:]), 'the mask must not reach the outline')
        self.assertTrue(np.any(fitted[100, 40:60]), 'it still grows away from the outline')

    def test_inside_recovers_a_detached_mark_on_flat_paper(self):
        img, seed = balloon_page()
        cv2.circle(img, (176, 118), 2, (0, 0, 0), -1)  # a dakuten the model missed
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[100:200, 110:190] = 255
        fitted = mask_fit.fit_region(gray, seed, allowed, 'inside', 0, page)
        self.assertGreater(fitted[118, 176], 0)

    def test_outside_takes_the_outline_by_half_a_stroke(self):
        img = np.full((200, 200, 3), 60, np.uint8)
        seed = np.zeros((200, 200), np.uint8)
        seed[60:140, 90:110] = 255  # a 20 px stroke
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[60:140, 90:110] = 255
        fitted = mask_fit.fit_region(gray, seed, allowed, 'outside', 0, page)
        self.assertGreater(fitted[100, 90 - 8], 0)
        self.assertEqual(fitted[100, 90 - 16], 0)

    def test_unknown_place_keeps_a_glyph_poking_out_of_the_box_whole(self):
        img, seed = balloon_page()
        gray, page = mask_fit.page_statistics(img)
        allowed = np.zeros_like(seed)
        allowed[125:175, 135:165] = 255  # cuts 5 px off every side of the glyph
        fitted = mask_fit.fit_region(gray, seed, allowed, None, 0, page)
        np.testing.assert_array_equal(fitted, seed)

    def test_a_textured_page_is_never_flat(self):
        noise = np.random.default_rng(3).integers(0, 256, 4000).astype(np.uint8)
        sigma = mask_fit.noise_sigma(np.random.default_rng(4).integers(0, 256, (128, 128)).astype(np.uint8))
        self.assertIsNone(mask_fit.flat_tone(noise, mask_fit.paper_tolerance(sigma)))


def lettered_balloon(glow):
    """A word in a large balloon; with `glow`, a grey halo 7 px round the letters."""
    img = np.full((300, 400), 245, np.uint8)
    cv2.ellipse(img, (200, 150), (170, 120), 0, 0, 360, 0, 3)
    raw = np.zeros_like(img)
    cv2.putText(raw, 'TEXT', (110, 170), cv2.FONT_HERSHEY_SIMPLEX, 1.8, 255, 5)
    if glow:
        img[cv2.dilate(raw, mask_fit.disc(7)) > 0] = 200
    img[raw > 0] = 20
    allowed = np.zeros_like(img)
    cv2.rectangle(allowed, (100, 110), (300, 190), 255, -1)
    return img, raw, allowed


class Expansion(unittest.TestCase):
    def test_a_larger_expansion_grows_the_mask_inside_a_balloon(self):
        # Neighbouring glyphs used to stop each other's growth, so every expansion
        # gave the same mask.
        img, raw, allowed = lettered_balloon(glow=False)
        _, page = mask_fit.page_statistics(img)
        sizes = [int(np.count_nonzero(mask_fit.fit_region(img, raw, allowed, 'inside', e, page))) for e in (5, 9, 13)]
        self.assertLess(sizes[0], sizes[1])
        self.assertLess(sizes[1], sizes[2])

    def test_a_forced_expansion_reaches_past_a_glow_but_not_the_outline(self):
        img, raw, allowed = lettered_balloon(glow=True)
        _, page = mask_fit.page_statistics(img)
        halo = (img == 200) & (cv2.dilate(allowed, np.ones((3, 3), np.uint8)) > 0)
        plain = mask_fit.fit_region(img, raw, allowed, 'inside', 13, page) > 0
        forced = mask_fit.fit_region(img, raw, allowed, 'inside', 13, page, force=True) > 0
        self.assertLess(np.mean(plain[halo]), .9, 'an ordinary mask still stops where the paper stops')
        self.assertEqual(np.mean(forced[halo]), 1.0)

        tight = np.full((200, 300), 245, np.uint8)
        cv2.rectangle(tight, (80, 70), (220, 130), 0, 3)
        letters = np.zeros_like(tight)
        cv2.putText(letters, 'TEXT', (95, 112), cv2.FONT_HERSHEY_SIMPLEX, 1.0, 255, 3)
        tight[letters > 0] = 20
        box = np.zeros_like(tight)
        cv2.rectangle(box, (85, 75), (215, 125), 255, -1)
        _, page = mask_fit.page_statistics(tight)
        grown = mask_fit.fit_region(tight, letters, box, 'inside', 19, page, force=True) > 0
        self.assertEqual(int(np.count_nonzero(grown & (tight < 60) & (letters == 0))), 0)


if __name__ == '__main__':
    unittest.main()
