import pathlib
import os
import sys
import unittest
from unittest.mock import patch
import types
import cv2
import numpy as np
sys.path.insert(0, str(pathlib.Path(__file__).parents[1]/'ocr'))
import detect
import lettering

class Lettering(unittest.TestCase):
    def test_crop_coverage_and_context(self):
        crops=list(detect._crops(1500,1800,690,172))
        self.assertEqual(crops[0],(0,0,1500,1800))
        cover=np.zeros((1800,1500),np.uint8)
        for x,y,r,b in crops[1:]: cover[y:b,x:r]=1
        self.assertTrue(cover.all())
        self.assertEqual(list(detect._crops(300,400,690,172)),[(0,0,300,400)])

    def test_rtdetr_names_each_model_as_it_starts(self):
        class Session:
            def run(self, _, inputs):
                w, h = inputs['orig_target_sizes'][0]
                return np.array([[1]]), np.array([[[10, 10, 40, 40]]]), np.array([[.9]])
        steps = []
        with patch.object(detect, '_session', return_value=Session()), \
                patch.object(detect, 'detect_ctd', return_value=[{'cls': 'text', 'score': .5, 'box': [200, 200, 240, 230]}]), \
                patch.dict(os.environ, {'SCAN_DETECT_CTD_SUPPLEMENT': '1'}):
            detect.detect_rtdetr(np.zeros((80, 80, 3), np.uint8), tile=0,
                                 progress=lambda model, step: steps.append((model, step)))
        self.assertEqual(steps, [
            ('RT-DETR', 'Detecting regions'),
            ('Comic Text Detector', 'Detecting regions'),
        ])

    def test_rtdetr_crop_offsets_are_source_coordinates(self):
        class Session:
            def run(self, _, inputs):
                w,h=inputs['orig_target_sizes'][0]
                return np.array([[2]]), np.array([[[w/2,h/2,w/2+20,h/2+30]]]), np.array([[.8]])
        with patch.object(detect,'_session',return_value=Session()), patch.dict(os.environ,{'SCAN_DETECT_CTD_SUPPLEMENT':'0'}):
            rows=detect.detect_rtdetr(np.zeros((900,1500,3),np.uint8))
        self.assertTrue(any(r['crop'][0]>0 and r['box'][0]>r['crop'][0] for r in rows))
        self.assertTrue(all(0<=r['box'][0]<r['box'][2]<=1500 for r in rows))

    def test_complete_box_wins_without_union(self):
        rows=[{'cls':'text','score':.6,'box':[90,20,160,120],'crop':[0,0,300,300]},
              {'cls':'text','score':.9,'box':[100,20,160,120],'truncated':True,'crop':[100,0,400,300]}]
        self.assertEqual(detect._dedupe(rows)[0]['box'],[90,20,160,120])

    def test_aligned_seam_fragments_join(self):
        rows=[{'cls':'text','score':.8,'box':[10,70,40,110],'truncated':True,'crop':[0,0,100,110]},
              {'cls':'text','score':.7,'box':[10,90,40,150],'truncated':True,'crop':[0,90,100,200]}]
        self.assertEqual(detect._dedupe(rows)[0]['box'],[10,70,40,150])

    def test_nested_distinct_text_survives(self):
        rows=[{'cls':'text','score':.9,'box':[0,0,200,200]},
              {'cls':'text','score':.8,'box':[10,10,30,60]}]
        self.assertEqual(len(detect._dedupe(rows)),2)

    def test_flat_texture_probability_is_not_lettering(self):
        image=np.full((80,100,3),180,np.uint8)
        probability=np.zeros((80,100),np.uint8); probability[25:30,10:90]=240
        mask,_=lettering.refine(probability,image,[])
        self.assertFalse(mask.any())

    def test_outline_recovered_and_remote_art_preserved(self):
        image=np.full((100,150,3),160,np.uint8)
        cv2.putText(image,'A',(20,60),cv2.FONT_HERSHEY_SIMPLEX,1,(255,)*3,7)
        cv2.putText(image,'A',(20,60),cv2.FONT_HERSHEY_SIMPLEX,1,(0,)*3,2)
        cv2.line(image,(100,10),(100,90),(0,)*3,3)
        probability=np.zeros((100,150),np.uint8);probability[38:58,22:38]=180
        mask,_=lettering.refine(probability,image,[])
        self.assertGreater(np.count_nonzero(mask[:,15:50]),100)
        self.assertFalse(mask[:,80:].any())

    def test_thick_ink_is_restored_without_filling_white_background(self):
        image=np.full((160,160,3),180,np.uint8)
        cv2.putText(image,'A',(35,110),cv2.FONT_HERSHEY_SIMPLEX,2,(255,)*3,18)
        cv2.putText(image,'A',(35,110),cv2.FONT_HERSHEY_SIMPLEX,2,(0,)*3,11)
        probability=np.zeros((160,160),np.uint8)
        probability[65:115,30:85]=220
        mask,_=lettering.refine(probability,image,[])
        ink=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)<125
        self.assertGreater(np.count_nonzero(mask[ink])/np.count_nonzero(ink),.95)
        self.assertFalse(mask[:40].any())

    def test_crop_coordinates_map_back_and_padding_stays_inside_region(self):
        image=np.full((400,500,3),180,np.uint8)
        regions=[[{'x':.8,'y':.7},{'x':.95,'y':.7},{'x':.95,'y':.9},{'x':.8,'y':.9}]]
        def fake(img,**kwargs):return [],np.zeros(img.shape[:2],np.uint8)
        def refined(p,img,boxes):return np.full(p.shape,255,np.uint8),False
        with patch.object(detect,'detect_ctd',side_effect=fake), patch.object(lettering,'refine',side_effect=refined):
            mask,diagnostics,_meta=lettering.propose(image,regions,20,engine='ctd')
        expected=np.zeros((400,500),np.uint8);expected[280:361,400:476]=255
        np.testing.assert_array_equal(mask,expected)
        self.assertIn('boundary clipping',diagnostics[0]['reasons'])

    def test_proposals_clip_and_report_empty_regions(self):
        image=np.full((120,180,3),180,np.uint8)
        regions=[[{'x':.1,'y':.1},{'x':.3,'y':.1},{'x':.3,'y':.4},{'x':.1,'y':.4}]]
        def fake(img,**kwargs):return [],np.zeros(img.shape[:2],np.uint8)
        with patch.object(detect,'detect_ctd',side_effect=fake):
            mask,diagnostics,_meta=lettering.propose(image,regions,engine='ctd')
        self.assertEqual(mask.shape,image.shape[:2]);self.assertFalse(mask.any())
        self.assertIn('empty coverage',diagnostics[0]['reasons'])

if __name__=='__main__': unittest.main()
