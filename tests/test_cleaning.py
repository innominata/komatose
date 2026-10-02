import importlib.util
import pathlib
import types
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np

spec=importlib.util.spec_from_file_location('workflow',pathlib.Path(__file__).parents[1]/'ocr'/'workflow.py')
workflow=importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)

class Cleaning(unittest.TestCase):
    def test_automask_clips_expansion_and_strokes_to_region_union(self):
        img = np.zeros((100, 120, 3), np.uint8)
        regions = [
            [{'x': .1, 'y': .1}, {'x': .5, 'y': .1}, {'x': .1, 'y': .5}],
            [{'x': .2, 'y': .2}, {'x': .4, 'y': .2}, {'x': .4, 'y': .4}, {'x': .2, 'y': .4}],
            [{'x': .7, 'y': .7}, {'x': .9, 'y': .7}, {'x': .9, 'y': .9}, {'x': .7, 'y': .9}],
        ]
        detected = np.full(img.shape[:2], 255, np.uint8)
        detector = types.SimpleNamespace(detect_ctd=lambda *args, **kwargs: ([], detected))
        meta={'engine':'ctd','version':'test','backend':'CPU'}
        stub=types.SimpleNamespace(propose=lambda *args, **kwargs: (detected, [], meta), resolve_engine=lambda *args, **kwargs: 'ctd')
        with patch.dict('sys.modules', {'lettering': stub}):
            mask = workflow.removal_mask(img, {'detect': True, 'regions': regions,
                'expansion': 20, 'strokes': [{'points': [{'x': .6, 'y': .6}], 'radius': 5}]})
        self.assertEqual(mask[15, 18], 255)  # Triangle interior.
        self.assertEqual(mask[25, 30], 255)  # Overlap stays filled.
        self.assertEqual(mask[80, 96], 255)  # Separate region stays filled.
        self.assertEqual(mask[45, 54], 0)  # Inside box, outside polygon.
        self.assertEqual(mask[60, 72], 0)  # Supplied stroke outside regions.
        self.assertFalse(np.any(mask[:10]))
        self.assertFalse(np.any(mask[:, :12]))
        self.assertFalse(np.any(mask[91:]))
        self.assertFalse(np.any(mask[:, 109:]))

    def test_automask_requires_regions_before_loading_detector(self):
        img = np.zeros((100, 120, 3), np.uint8)
        for regions in (None, [], [[]]):
            req = {'detect': True}
            if regions is not None:
                req['regions'] = regions
            with self.assertRaisesRegex(ValueError, 'Define a region'):
                workflow.removal_mask(img, req)

    def test_mask_compositing_and_flat_fill(self):
        img=np.full((240,300,3),240,np.uint8)
        cv2.rectangle(img,(20,20),(280,220),(0,0,0),3)
        cv2.putText(img,'TEXT',(90,120),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),2)
        mask=np.zeros(img.shape[:2],np.uint8);mask[90:130,85:180]=255
        result,method=workflow.clean(img,mask,{'method':'auto'})
        self.assertEqual(method,'flat')
        self.assertTrue(np.array_equal(result[mask==0],img[mask==0]))
        self.assertTrue(np.all(result[mask>0]==240))

    def test_brush_erase_expansion_and_exact_dimensions(self):
        img=np.zeros((100,120,3),np.uint8)
        mask=workflow.removal_mask(img,{'strokes':[{'points':[{'x':.5,'y':.5}],'radius':9},{'points':[{'x':.5,'y':.5}],'radius':3,'erase':True}]})
        self.assertEqual(mask.shape,(100,120));self.assertEqual(mask[50,60],0);self.assertEqual(mask[50,67],255)

    def test_saved_mask_never_expands_on_commit_or_clean(self):
        img = np.zeros((100, 120, 3), np.uint8)
        original = np.zeros(img.shape[:2], np.uint8)
        original[30:70, 30:90] = 255
        with tempfile.TemporaryDirectory() as tmp:
            path = str(pathlib.Path(tmp) / 'mask.png')
            cv2.imwrite(path, original)
            edited = workflow.removal_mask(img, {'mask': path, 'expansion': 3,
                'strokes': [{'points': [{'x': .5, 'y': .5}], 'radius': 5, 'erase': True}]})
            self.assertEqual(edited[50, 60], 0)
            self.assertFalse(np.any(edited[original == 0]))
            cv2.imwrite(path, edited)
            for cmd in ('mask', 'clean'):
                np.testing.assert_array_equal(workflow.removal_mask(img,
                    {'cmd': cmd, 'mask': path, 'expansion': 3}), edited)

    def test_balloon_with_unmasked_ink_and_nearby_art_uses_fill(self):
        img = np.full((200, 300, 3), 90, np.uint8)
        cv2.ellipse(img, (120, 100), (75, 65), 0, 0, 360, (255,)*3, -1)
        cv2.putText(img, 'TEXT', (70, 105), cv2.FONT_HERSHEY_SIMPLEX, .7, (0,)*3, 2)
        mask = np.zeros(img.shape[:2], np.uint8)
        mask[88:108, 73:115] = 255
        with patch.object(workflow, 'model_inpaint', side_effect=AssertionError('Balloon sent to AI')):
            out, method = workflow.clean(img, mask, {'method': 'auto'})
        self.assertEqual(method, 'flat')
        self.assertTrue(np.all(out[mask > 0] == 255))
        np.testing.assert_array_equal(out[mask == 0], img[mask == 0])

    def test_open_white_background_is_not_an_enclosed_balloon(self):
        img = np.full((100, 120, 3), 255, np.uint8)
        mask = np.zeros(img.shape[:2], np.uint8)
        mask[40:60, 50:70] = 255
        with patch.object(workflow, 'model_inpaint', side_effect=lambda crop, m, method, device: crop.copy()) as model:
            _, method = workflow.clean(img, mask, {'method': 'auto'})
        self.assertEqual(method, 'lama')
        self.assertEqual(model.call_count, 1)

    def test_balloon_and_crossing_selection_are_routed_separately(self):
        img = np.full((200, 300, 3), 90, np.uint8)
        cv2.rectangle(img, (30, 30), (160, 170), (255,)*3, -1)
        mask = np.zeros(img.shape[:2], np.uint8)
        mask[80:100, 130:140] = 255
        mask[80:100, 150:180] = 255
        with patch.object(workflow, 'model_inpaint', return_value=None) as model:
            model.side_effect = lambda crop, m, method, device: np.full_like(crop, 77)
            out, method = workflow.clean(img, mask, {'method': 'auto'})
        self.assertEqual(method, 'flat+lama')
        self.assertEqual(model.call_count, 1)
        self.assertTrue(np.all(out[80:100, 130:140] == 255))
        self.assertTrue(np.all(out[80:100, 150:180] == 77))
        np.testing.assert_array_equal(out[mask == 0], img[mask == 0])

    def test_auto_on_cuda_uses_big_lama(self):
        img = np.full((100, 120, 3), 255, np.uint8)
        mask = np.zeros(img.shape[:2], np.uint8)
        mask[40:60, 50:70] = 255
        with patch.object(workflow, 'model_inpaint', side_effect=lambda crop, m, method, device: crop.copy()) as model:
            _, method = workflow.clean(img, mask, {'method': 'auto', 'device': 'cuda:0'})
        self.assertEqual(method, 'big-lama')
        self.assertEqual(model.call_args.args[2], 'big-lama')
        self.assertEqual(model.call_args.args[3], 'cuda:0')

    def test_enclosed_geometry_excludes_outline_and_reports_uncertainty(self):
        img=np.full((300,400,3),255,np.uint8)
        cv2.ellipse(img,(200,150),(130,100),0,0,360,(0,0,0),4)
        result=workflow.geometry(img,{'box':[.25,.25,.5,.5]})
        self.assertGreater(len(result['polygon']),8);self.assertTrue(result['uncertain'])
        self.assertTrue(all(.17<p['x']<.83 for p in result['polygon']))
        blank=workflow.geometry(np.full_like(img,255),{'box':[.1,.1,.2,.2]})
        self.assertEqual(blank['polygon'],[])

    def _panel_with_bubble(self, gap=0, hatch=False, blur=True, slit=0):
        """Small white panel on a large page so a leak is under the old 40% cap."""
        img = np.full((1000, 800, 3), 35, np.uint8)
        cv2.rectangle(img, (200, 80), (600, 480), (248, 248, 248), -1)
        cv2.rectangle(img, (200, 80), (600, 480), (0, 0, 0), 8)
        cv2.ellipse(img, (400, 230), (95, 70), 0, 0, 360, (20, 20, 20), 20, cv2.LINE_AA)
        if blur:
            img = cv2.GaussianBlur(img, (3, 3), .8)
        interior = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(interior, (400, 230), (80, 55), 0, 0, 360, 255, -1)
        img[interior > 0] = (250, 250, 250)
        if hatch:
            for i in range(90, 470, 6):
                cv2.line(img, (210, i), (590, i + 25), (70, 70, 70), 1, cv2.LINE_AA)
            img[interior > 0] = (250, 250, 250)
        if slit:
            cv2.rectangle(img, (484, 229), (508, 229 + slit), (248, 248, 248), -1)
        if gap:
            cv2.rectangle(img, (480, 210), (500 + gap, 250), (248, 248, 248), -1)
        return img, [400 / 800 - .06, 230 / 1000 - .04, .12, .08]

    def test_enclosed_geometry_stays_inside_thick_outline_and_ignores_panel(self):
        img, box = self._panel_with_bubble(hatch=True)
        result = workflow.geometry(img, {'box': box})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        # Inner edge of the 20px ellipse, not the panel (0.25–0.75 × 0.08–0.48).
        self.assertTrue(all(.36 < x < .64 for x in xs))
        self.assertTrue(all(.14 < y < .32 for y in ys))
        self.assertLess(min(xs), .42)
        self.assertGreater(max(xs), .58)

    def test_enclosed_geometry_does_not_path_around_panel_through_outline_gap(self):
        img, box = self._panel_with_bubble(gap=8, hatch=True)
        result = workflow.geometry(img, {'box': box})
        if result['polygon']:
            xs = [p['x'] for p in result['polygon']]
            ys = [p['y'] for p in result['polygon']]
            self.assertLess(max(xs) - min(xs), .32)
            self.assertLess(max(ys) - min(ys), .24)
            self.assertTrue(all(.34 < x < .66 for x in xs))
            self.assertTrue(all(.12 < y < .34 for y in ys))
        else:
            self.assertTrue(result['uncertain'])

    def test_enclosed_geometry_seals_antialiased_pinholes_in_thick_outlines(self):
        img, box = self._panel_with_bubble(slit=2, hatch=True)
        result = workflow.geometry(img, {'box': box})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.36 < x < .64 for x in xs))
        self.assertTrue(all(.14 < y < .32 for y in ys))

    def test_enclosed_geometry_follows_pale_closed_outline_not_nearby_hair(self):
        """Closed oval whose stroke is mid-grey in places, next to dark hair.

        Flood-fill walks through the pale AA and wraps the hair; the ring
        detector must still return the balloon.
        """
        img = np.full((1000, 800, 3), 40, np.uint8)
        cv2.rectangle(img, (80, 40), (720, 620), (252, 252, 252), -1)
        cv2.ellipse(img, (280, 240), (110, 150), 0, 0, 360, (24, 24, 24), 8, cv2.LINE_AA)
        fade = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(fade, (280, 240), (110, 150), 0, 0, 360, 255, 8, cv2.LINE_AA)
        fade[:, :280] = 0
        img[fade > 80] = (200, 200, 200)
        interior = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(interior, (280, 240), (100, 140), 0, 0, 360, 255, -1)
        img[interior > 0] = (253, 253, 253)
        cv2.ellipse(img, (520, 420), (140, 80), 0, 0, 360, (30, 30, 30), -1)
        for y in range(340, 500, 4):
            for x in range(400, 660, 4):
                if ((x - 520) / 140) ** 2 + ((y - 420) / 80) ** 2 < 1:
                    img[y, x] = (20, 20, 20)
        box = [280 / 800 - .06, 240 / 1000 - .1, .12, .2]
        result = workflow.geometry(img, {'box': box})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.18 < x < .52 for x in xs))
        self.assertTrue(all(.08 < y < .40 for y in ys))
        self.assertLess(max(xs), .50)
        self.assertLess(max(ys), .42)

    def test_lighter_balloon_outline_beats_the_darker_panel(self):
        """A black panel border closes first. The balloon stroke is only mid-grey."""
        img = np.full((500, 500, 3), 245, np.uint8)
        cv2.rectangle(img, (30, 30), (470, 470), (0, 0, 0), 8)
        cv2.ellipse(img, (250, 220), (70, 90), 0, 0, 360, (170, 170, 170), 3)
        result = workflow.geometry(img, {'box': [(250 - 40) / 500, (220 - 50) / 500, 80 / 500, 100 / 500]})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.34 < x < .66 for x in xs))
        self.assertTrue(all(.24 < y < .64 for y in ys))
        self.assertLess(min(xs), .42)
        self.assertGreater(max(xs), .58)

    def test_solid_black_balloon_uses_its_outer_silhouette(self):
        img = np.full((400, 400, 3), 255, np.uint8)
        cv2.ellipse(img, (200, 180), (36, 50), 0, 0, 360, (0, 0, 0), -1)
        cv2.putText(img, 'A', (188, 190), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 2)
        result = workflow.geometry(img, {'box': [(200 - 28) / 400, (180 - 40) / 400, 56 / 400, 80 / 400]})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.39 < x < .61 for x in xs))
        self.assertTrue(all(.30 < y < .60 for y in ys))

    def test_enclosed_geometry_on_closed_scanned_oval(self):
        fixture = pathlib.Path(__file__).parent / 'fixtures' / 'cleaning' / 'closed_oval_bubble.png'
        if not fixture.is_file():
            self.skipTest('private cleaning fixture is not present')
        img = cv2.imread(str(fixture))
        self.assertIsNotNone(img)
        H, W = img.shape[:2]
        result = workflow.geometry(img, {'box': [70 / W, 50 / H, 90 / W, 180 / H]})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.04 < x < .96 for x in xs))
        self.assertTrue(all(.06 < y < .92 for y in ys))
        self.assertLess(min(xs), .15)
        self.assertGreater(max(xs), .85)
        self.assertLess(min(ys), .16)
        self.assertGreater(max(ys), .80)

    def test_screentone_interior_follows_the_continuous_border(self):
        img = np.full((300, 400, 3), 255, np.uint8)
        cv2.ellipse(img, (200, 150), (130, 100), 0, 0, 360, (0, 0, 0), 4)
        for y in range(70, 230, 5):
            for x in range(90, 310, 5):
                if ((x - 200) / 122) ** 2 + ((y - 150) / 92) ** 2 < 1:
                    cv2.circle(img, (x, y), 2, (0, 0, 0), -1)
        cv2.putText(img, 'TEXT', (140, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)
        result = workflow.geometry(img, {'box': [.25, .25, .5, .5]})
        xs = [p['x'] for p in result['polygon']]
        ys = [p['y'] for p in result['polygon']]
        self.assertGreater(len(result['polygon']), 8)
        self.assertTrue(all(.17 < x < .83 for x in xs))
        self.assertTrue(all(.16 < y < .84 for y in ys))
        self.assertLess(min(xs), .25)
        self.assertGreater(max(xs), .75)
        self.assertLess(min(ys), .28)
        self.assertGreater(max(ys), .72)
        clean = np.full((300, 400, 3), 255, np.uint8)
        cv2.ellipse(clean, (200, 150), (130, 100), 0, 0, 360, (0, 0, 0), 4)
        plain = workflow.geometry(clean, {'box': [.25, .25, .5, .5]})
        self.assertAlmostEqual(min(p['x'] for p in result['polygon']),
                               min(p['x'] for p in plain['polygon']), delta=.04)
        dots_only = np.full((300, 400, 3), 255, np.uint8)
        for y in range(70, 230, 5):
            for x in range(90, 310, 5):
                cv2.circle(dots_only, (x, y), 2, (0, 0, 0), -1)
        self.assertEqual(workflow.geometry(dots_only, {'box': [.25, .25, .5, .5]})['polygon'], [])

    def test_connected_interiors_split_without_overlap(self):
        img = np.full((400, 600, 3), 255, np.uint8)
        mask = np.zeros(img.shape[:2], np.uint8)
        cv2.ellipse(mask, (245, 200), (80, 90), 0, 0, 360, 255, -1)
        cv2.ellipse(mask, (355, 200), (80, 90), 0, 0, 360, 255, -1)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, contours, -1, (0, 0, 0), 3)
        left, right = [.375, .45, .05, .1], [.575, .45, .05, .1]
        results = [workflow.geometry(img, {'box': a, 'neighbors': [b]})
                   for a, b in [(left, right), (right, left)]]
        self.assertTrue(all(r['split'] and r['uncertain'] for r in results))
        self.assertTrue(all(p['x'] < .5 for p in results[0]['polygon']))
        self.assertTrue(all(p['x'] > .5 for p in results[1]['polygon']))
        self.assertGreater(len(results[0]['polygon']), 3)
        self.assertGreater(len(results[1]['polygon']), 3)

    def test_connected_interiors_split_at_the_neck(self):
        mask = np.zeros((400, 600), np.uint8)
        cv2.ellipse(mask, (180, 200), (140, 110), 0, 0, 360, 255, -1)
        cv2.ellipse(mask, (420, 260), (55, 50), 0, 0, 360, 255, -1)
        cv2.ellipse(mask, (340, 240), (40, 18), 0, 0, 360, 255, -1)
        left = [180 / 600 - .04, 200 / 400 - .04, .08, .08]
        right = [420 / 600 - .03, 260 / 400 - .03, .06, .06]
        large, split_l = workflow.split_interior(mask, left, [right])
        small, split_s = workflow.split_interior(mask, right, [left])
        self.assertTrue(split_l and split_s)
        self.assertGreater(large[200, 180], 0)
        self.assertGreater(small[260, 420], 0)
        self.assertEqual(large[260, 420], 0)
        self.assertEqual(small[200, 180], 0)
        # Midpoint of the text centres is x=300, inside the large lobe. The
        # pinch is further right, so a centre bisector would steal that interior.
        self.assertGreater(large[220, 310], 0)
        self.assertEqual(small[220, 300], 0)
        self.assertEqual(np.count_nonzero((large > 0) & (small > 0)), 0)
        img = np.full((400, 600, 3), 255, np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(img, contours, -1, (0, 0, 0), 3)
        results = [workflow.geometry(img, {'box': a, 'neighbors': [b]})
                   for a, b in [(left, right), (right, left)]]
        self.assertTrue(all(r['split'] for r in results))
        self.assertTrue(any(p['x'] > .52 for p in results[0]['polygon']))
        self.assertTrue(all(p['x'] > .5 for p in results[1]['polygon']))

    def test_corner_double_bubble_splits_at_the_join(self):
        mask = np.zeros((400, 400), np.uint8)
        cv2.ellipse(mask, (230, 150), (120, 100), 0, 0, 360, 255, -1)
        cv2.ellipse(mask, (130, 270), (65, 55), 0, 0, 360, 255, -1)
        upper = [230 / 400 - .05, 150 / 400 - .05, .1, .1]
        lower = [130 / 400 - .04, 270 / 400 - .04, .08, .08]
        top, split_t = workflow.split_interior(mask, upper, [lower])
        bot, split_b = workflow.split_interior(mask, lower, [upper])
        self.assertTrue(split_t and split_b)
        self.assertGreater(top[150, 230], 0)
        self.assertGreater(bot[270, 130], 0)
        self.assertEqual(top[270, 130], 0)
        self.assertEqual(bot[150, 230], 0)
        self.assertEqual(np.count_nonzero((top > 0) & (bot > 0)), 0)

    def test_unequal_wide_overlap_splits_at_outline_intersection(self):
        mask = np.zeros((400, 600), np.uint8)
        cv2.ellipse(mask, (200, 200), (150, 140), 0, 0, 360, 255, -1)
        cv2.ellipse(mask, (360, 210), (90, 80), 0, 0, 360, 255, -1)
        left = [200 / 600 - .04, 200 / 400 - .04, .08, .08]
        right = [360 / 600 - .03, 210 / 400 - .03, .06, .06]
        large, split_l = workflow.split_interior(mask, left, [right])
        small, split_s = workflow.split_interior(mask, right, [left])
        self.assertTrue(split_l and split_s)
        self.assertGreater(large[200, 200], 0)
        self.assertGreater(small[210, 360], 0)
        self.assertEqual(large[210, 360], 0)
        self.assertEqual(small[200, 200], 0)
        # Intersection of these ellipses is near x=325. A centre bisector at
        # x=280 would cut through the large balloon instead of the join.
        self.assertGreater(large[200, 310], 0)
        self.assertEqual(small[200, 280], 0)
        self.assertEqual(np.count_nonzero((large > 0) & (small > 0)), 0)

    def test_saved_polygon_split_and_repeat_preserves_geometry(self):
        img = np.full((200, 400, 3), 255, np.uint8)
        points = [{'x': .1, 'y': .1}, {'x': .9, 'y': .1},
                  {'x': .9, 'y': .9}, {'x': .1, 'y': .9}]
        req = {'method': 'split', 'polygon': points,
               'box': [.2, .4, .1, .2], 'neighbors': [[.7, .4, .1, .2]]}
        result = workflow.geometry(img, req)
        self.assertTrue(result['split'])
        self.assertGreater(len(result['polygon']), 3)
        self.assertTrue(all(p['x'] < .5 for p in result['polygon']))
        repeated = workflow.geometry(img, {**req, 'polygon': result['polygon']})
        self.assertFalse(repeated['split'])
        self.assertEqual(repeated['polygon'], result['polygon'])
        unchanged = workflow.geometry(img, {**req, 'neighbors': []})
        self.assertEqual(unchanged['polygon'], points)

    def test_split_ignores_external_and_duplicate_centers(self):
        mask = np.zeros((100, 200), np.uint8)
        mask[20:80, 20:80] = 255
        result, split = workflow.split_interior(mask, [.2, .4, .1, .2],
                                               [[.2, .4, .1, .2], [.8, .4, .1, .2]])
        self.assertFalse(split)
        np.testing.assert_array_equal(result, mask)

    def test_bubble_fill_run_writes_filled_artwork(self):
        img = np.full((300, 400, 3), 80, np.uint8)
        cv2.ellipse(img, (200, 150), (130, 100), 0, 0, 360, (250,)*3, -1)
        cv2.ellipse(img, (200, 150), (130, 100), 0, 0, 360, (0,)*3, 4)
        cv2.putText(img, 'TEXT', (140, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0,)*3, 3)
        with tempfile.TemporaryDirectory() as tmp:
            src = str(pathlib.Path(tmp) / 'src.png')
            out = str(pathlib.Path(tmp) / 'out.png')
            cv2.imwrite(src, img)
            result = workflow.run({'cmd': 'bubble-fill', 'path': src, 'out': out, 'px': .5, 'py': .5})
            filled = cv2.imread(out)
            self.assertEqual(result['method'], 'bubble')
            self.assertTrue(np.all(filled[150, 200] >= 240))
            self.assertTrue(np.all(filled[50, 200] <= 20))

    def test_bubble_fill_covers_lettering_and_leaves_outline(self):
        img = np.full((300, 400, 3), 80, np.uint8)
        cv2.ellipse(img, (200, 150), (130, 100), 0, 0, 360, (250,)*3, -1)
        cv2.ellipse(img, (200, 150), (130, 100), 0, 0, 360, (0,)*3, 4)
        cv2.putText(img, 'TEXT', (140, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0,)*3, 3)
        out = img.copy()
        self.assertEqual(workflow.bubble_fill(out, {'px': .5, 'py': .5}), 'bubble')
        self.assertTrue(np.all(out[150, 200] >= 240))
        self.assertTrue(np.all(out[160, 180] >= 240))
        self.assertTrue(np.all(out[50, 200] <= 20))
        np.testing.assert_array_equal(out[10, 10], img[10, 10])
        with self.assertRaisesRegex(ValueError, 'bubble'):
            workflow.bubble_fill(img.copy(), {'px': .02, 'py': .02})

    def test_bubble_fill_accepts_a_solid_colour_with_a_contrasting_border(self):
        img = np.full((400, 400, 3), 230, np.uint8)
        cv2.ellipse(img, (200, 180), (36, 50), 0, 0, 360, (8, 8, 8), -1)
        cv2.putText(img, 'A', (188, 190), cv2.FONT_HERSHEY_SIMPLEX, .7, (255, 255, 255), 2)
        out = img.copy()
        self.assertEqual(workflow.bubble_fill(out, {'px': 200 / 400, 'py': 180 / 400}), 'bubble')
        self.assertLess(int(out[180, 200, 0]), 30)
        self.assertLess(int(out[188, 196, 0]), 30)
        self.assertGreater(int(out[40, 40, 0]), 200)
        # Landing on the white lettering still fills the black balloon.
        letter = img.copy()
        self.assertEqual(workflow.bubble_fill(letter, {'px': 196 / 400, 'py': 186 / 400}), 'bubble')
        self.assertLess(int(letter[180, 200, 0]), 30)
        weak = np.full((400, 400, 3), 180, np.uint8)
        cv2.ellipse(weak, (200, 180), (36, 50), 0, 0, 360, (140, 140, 140), -1)
        with self.assertRaisesRegex(ValueError, '75%'):
            workflow.bubble_fill(weak, {'px': .5, 'py': 180 / 400})

    def test_bubble_fill_joins_fill_split_by_lettering_that_touches_the_border(self):
        img = np.full((220, 220, 3), 230, np.uint8)
        cv2.ellipse(img, (110, 110), (28, 46), 0, 0, 360, (6, 6, 6), -1)
        # A white stroke from the outline through the balloon, leaving a dark cap above it.
        cv2.line(img, (82, 86), (138, 86), (255, 255, 255), 5)
        out = img.copy()
        self.assertEqual(workflow.bubble_fill(out, {'px': 110 / 220, 'py': 130 / 220}), 'bubble')
        self.assertLess(int(out[130, 110, 0]), 30)
        self.assertLess(int(out[86, 110, 0]), 30)
        self.assertLess(int(out[72, 110, 0]), 30)
        self.assertGreater(int(out[30, 30, 0]), 200)
        self.assertGreater(int(out[110, 78, 0]), 180)

    def test_bubble_fill_does_not_cross_the_outline_to_reach_outside_white(self):
        img = np.full((300, 400, 3), 150, np.uint8)
        cv2.ellipse(img, (200, 150), (80, 60), 0, 0, 360, (250,)*3, -1)
        cv2.ellipse(img, (200, 150), (80, 60), 0, 0, 360, (0,)*3, 3)
        cv2.putText(img, 'HI', (170, 160), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0,)*3, 2)
        # Screentone holes just outside the stroke. They match the fill, so a
        # close that treats them as part of the balloon paints the outline.
        for center in ((200, 78), (200, 222), (108, 150), (292, 150)):
            cv2.circle(img, center, 4, (248,)*3, -1)
        out = img.copy()
        self.assertEqual(workflow.bubble_fill(out, {'px': .5, 'py': .5}), 'bubble')
        self.assertGreater(int(out[150, 200, 0]), 240)
        self.assertGreater(int(out[155, 185, 0]), 240)
        self.assertLess(int(out[90, 200, 0]), 30)
        self.assertLess(int(out[210, 200, 0]), 30)
        np.testing.assert_array_equal(out[78, 200], img[78, 200])
        np.testing.assert_array_equal(out[70, 200], img[70, 200])
        np.testing.assert_array_equal(out[10, 10], img[10, 10])

    def test_mask_grow_expands_only_the_clicked_component(self):
        mask = np.zeros((80, 120), np.uint8)
        mask[10:20, 10:20] = 255
        mask[50:70, 80:110] = 255
        grown = workflow.grow_mask_at(mask, 15 / 120, 15 / 80)
        self.assertEqual(grown[9, 15], 255)
        self.assertEqual(grown[15, 9], 255)
        self.assertEqual(grown[21, 15], 0)
        np.testing.assert_array_equal(grown[50:70, 80:110], mask[50:70, 80:110])
        self.assertFalse(np.any(grown[48:50, 78:112] > 0))
        nearby = workflow.grow_mask_at(mask, 22 / 120, 15 / 80)
        self.assertEqual(nearby[9, 15], 255)
        with self.assertRaisesRegex(ValueError, 'mask region'):
            workflow.grow_mask_at(mask, .5, .5)

    def test_mask_grow_bakes_strokes_then_expands_only_the_clicked_island(self):
        img = np.zeros((80, 120, 3), np.uint8)
        with tempfile.TemporaryDirectory() as tmp:
            src = str(pathlib.Path(tmp) / 'src.png')
            saved = str(pathlib.Path(tmp) / 'mask.png')
            out = str(pathlib.Path(tmp) / 'out.png')
            original = np.zeros((80, 120), np.uint8)
            original[10:20, 10:20] = 255
            cv2.imwrite(src, img)
            cv2.imwrite(saved, original)
            result = workflow.run({
                'cmd': 'mask', 'path': src, 'out': out, 'mask': saved,
                'strokes': [{'points': [{'x': 90 / 120, 'y': 60 / 80}], 'radius': 4}],
                'grow': True, 'px': 90 / 120, 'py': 60 / 80,
            })
            grown = cv2.imread(out, cv2.IMREAD_GRAYSCALE)
            self.assertGreater(result['pixels'], 0)
            self.assertEqual(grown[15, 15], 255)
            self.assertEqual(grown[9, 15], 0)
            self.assertEqual(grown[60, 90], 255)
            self.assertEqual(grown[60, 95], 255)

    def test_mask_grow_radius_expands_by_the_requested_amount(self):
        mask = np.zeros((80, 120), np.uint8)
        mask[10:20, 10:20] = 255
        grown = workflow.grow_mask_at(mask, 15 / 120, 15 / 80, 10)
        self.assertEqual(grown[15, 1], 255)
        self.assertEqual(grown[1, 15], 255)
        self.assertEqual(grown[15, 30], 0)
        self.assertEqual(grown[30, 15], 0)
        np.testing.assert_array_equal(grown[50:70, 80:110], mask[50:70, 80:110])

    def test_mask_grow_radius_comes_from_the_request(self):
        self.assertEqual(workflow.grow_radius({'grow': True}), 1)
        self.assertEqual(workflow.grow_radius({'grow': 10}), 10)
        self.assertEqual(workflow.grow_radius({'grow': 3.6}), 4)
        self.assertEqual(workflow.grow_radius({'grow': 0}), 1)
        self.assertEqual(workflow.grow_radius({'grow': 500}), 50)
        self.assertEqual(workflow.grow_radius({}), 1)

        img = np.zeros((80, 120, 3), np.uint8)
        with tempfile.TemporaryDirectory() as tmp:
            src = str(pathlib.Path(tmp) / 'src.png')
            saved = str(pathlib.Path(tmp) / 'mask.png')
            out = str(pathlib.Path(tmp) / 'out.png')
            original = np.zeros((80, 120), np.uint8)
            original[10:20, 10:20] = 255
            cv2.imwrite(src, img)
            cv2.imwrite(saved, original)
            workflow.run({
                'cmd': 'mask', 'path': src, 'out': out, 'mask': saved,
                'grow': 6, 'px': 15 / 120, 'py': 15 / 80,
            })
            grown = cv2.imread(out, cv2.IMREAD_GRAYSCALE)
            # The 10×10 island dilates by 6px, so 5px from its edge is covered
            # and 7px is not.
            self.assertEqual(grown[15, 5], 255)
            self.assertEqual(grown[15, 3], 0)
            self.assertEqual(grown[5, 15], 255)
            self.assertEqual(grown[3, 15], 0)

    def test_clone_stamp_copies_brush_path_from_aligned_source(self):
        img = np.zeros((80, 120, 3), np.uint8)
        img[10:30, 10:30] = (20, 180, 240)
        img[40:70, 70:110] = (90, 40, 10)
        out = img.copy()
        workflow.clone_brush(out, {
            'offset': [(80 - 20) / 120, (55 - 20) / 80],
            'strokes': [{'points': [{'x': 80 / 120, 'y': 55 / 80}], 'radius': 8}],
        })
        self.assertTrue(np.array_equal(out[55, 80], (20, 180, 240)))
        self.assertTrue(np.array_equal(out[10, 10], img[10, 10]))
        self.assertTrue(np.array_equal(out[20, 100], img[20, 100]))
        with self.assertRaisesRegex(ValueError, 'source'):
            workflow.clone_brush(img.copy(), {'offset': [.1, .1], 'strokes': []})

    def test_blur_brush_feathers_inpaint_patch_into_gradient(self):
        img = np.zeros((80, 120, 3), np.uint8)
        for x in range(120):
            img[:, x] = (40 + x, 80 + x // 2, 200)
        img[30:50, 50:70] = (20, 180, 40)
        out = img.copy()
        workflow.blur_brush(out, {
            'strokes': [{'points': [{'x': 60 / 120, 'y': 40 / 80}], 'radius': 18}],
        })
        def delta(y, x):
            return int(np.abs(out[y, x].astype(np.int16) - img[y, x].astype(np.int16)).sum())
        self.assertGreater(delta(40, 60), 0)
        self.assertFalse(np.array_equal(out[40, 48], img[40, 48]))
        self.assertEqual(delta(40, 82), 0)
        self.assertTrue(np.array_equal(out[5, 5], img[5, 5]))
        with self.assertRaisesRegex(ValueError, 'blur'):
            workflow.blur_brush(img.copy(), {'strokes': []})
        with self.assertRaisesRegex(ValueError, 'blur'):
            workflow.blur_brush(img.copy(), {'strokes': [{'points': [], 'radius': 8}]})

    def test_restore_brush_feathers_previous_save_without_touching_the_rest(self):
        current = np.zeros((80, 120, 3), np.uint8)
        current[:] = (20, 40, 80)
        current[20:50, 20:50] = (40, 180, 40)
        current[20:50, 70:100] = (10, 10, 200)
        previous = current.copy()
        previous[20:50, 70:100] = (180, 90, 20)
        with tempfile.TemporaryDirectory() as tmp:
            prev_path = str(pathlib.Path(tmp) / 'previous.png')
            cv2.imwrite(prev_path, previous)
            out = current.copy()
            workflow.restore_brush(out, {
                'previous': prev_path,
                'strokes': [{'points': [{'x': 85 / 120, 'y': 35 / 80}], 'radius': 16}],
            })
            self.assertTrue(np.array_equal(out[35, 85], (180, 90, 20)))
            self.assertFalse(np.array_equal(out[35, 98], current[35, 98]))
            self.assertTrue(np.array_equal(out[35, 35], current[35, 35]))
            self.assertTrue(np.array_equal(out[5, 5], current[5, 5]))
            self.assertGreater(int(np.abs(out[35, 98].astype(np.int16) - current[35, 98].astype(np.int16)).sum()), 0)
            self.assertGreater(int(np.abs(out[35, 85].astype(np.int16) - out[35, 98].astype(np.int16)).sum()), 0)
            with self.assertRaisesRegex(ValueError, 'restore'):
                workflow.restore_brush(current.copy(), {'previous': prev_path, 'strokes': []})
            with self.assertRaisesRegex(ValueError, 'previous'):
                workflow.restore_brush(current.copy(), {'strokes': [{'points': [{'x': .5, 'y': .5}], 'radius': 8}]})

    def test_raw_brush_feathers_prepared_source_without_touching_the_rest(self):
        current = np.zeros((80, 120, 3), np.uint8)
        current[:] = (20, 40, 80)
        current[20:50, 20:50] = (40, 180, 40)
        current[20:50, 70:100] = (10, 10, 200)
        raw = current.copy()
        raw[20:50, 70:100] = (180, 90, 20)
        with tempfile.TemporaryDirectory() as tmp:
            raw_path = str(pathlib.Path(tmp) / 'raw.png')
            cv2.imwrite(raw_path, raw)
            out = current.copy()
            workflow.raw_brush(out, {
                'raw': raw_path,
                'strokes': [{'points': [{'x': 85 / 120, 'y': 35 / 80}], 'radius': 16}],
            })
            self.assertTrue(np.array_equal(out[35, 85], (180, 90, 20)))
            self.assertFalse(np.array_equal(out[35, 98], current[35, 98]))
            self.assertTrue(np.array_equal(out[35, 35], current[35, 35]))
            self.assertTrue(np.array_equal(out[5, 5], current[5, 5]))
            with self.assertRaisesRegex(ValueError, 'raw'):
                workflow.raw_brush(current.copy(), {'strokes': [{'points': [{'x': .5, 'y': .5}], 'radius': 8}]})
            with self.assertRaisesRegex(ValueError, 'raw'):
                workflow.raw_brush(current.copy(), {'raw': raw_path, 'strokes': []})

    def test_blur_brush_coverage_falls_off_to_the_edge(self):
        img = np.zeros((80, 120, 3), np.uint8)
        img[34:47, 54:67] = 255
        out = img.copy()
        workflow.blur_brush(out, {
            'strokes': [{'points': [{'x': 60 / 120, 'y': 40 / 80}], 'radius': 16}],
        })
        self.assertGreater(int(out[40, 70].mean()), 0)
        self.assertGreater(int(out[40, 60].mean()), int(out[40, 70].mean()))
        self.assertEqual(int(out[40, 78].mean()), 0)
        self.assertTrue(np.array_equal(out[5, 5], (0, 0, 0)))

    def test_clone_retains_unmasked_pixels_and_rejects_invalid_source(self):
        img=np.arange(100*100*3,dtype=np.uint8).reshape(100,100,3)
        mask=np.zeros((100,100),np.uint8);mask[40:50,40:50]=255
        out,_=workflow.clean(img,mask,{'method':'clone','offset':[20,0]})
        self.assertTrue(np.array_equal(out[40:50,40:50],img[40:50,60:70]));self.assertTrue(np.array_equal(out[mask==0],img[mask==0]))
        with self.assertRaises(ValueError):workflow.clean(img,mask,{'method':'clone','offset':[0,0]})

if __name__=='__main__':unittest.main()
