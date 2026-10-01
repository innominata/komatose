import os
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
import torch
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'ocr'))
import coo
from coo_model import COOModel, legacy_offsets

class COOTests(unittest.TestCase):
    def test_preprocess_preserves_aspect_and_upstream_bgr_mean(self):
        image=np.full((200,400,3),[10,20,30],np.uint8)
        result=coo.prepare(image)
        self.assertEqual(result.shape,(1,3,736,1472))
        np.testing.assert_allclose(result[0,:,0,0],(np.array([10,20,30])-coo.MEAN)/255,atol=1e-7)
        self.assertTrue(result.flags.c_contiguous)
        self.assertLessEqual(max(coo.prepare(np.zeros((10000,100,3),np.uint8)).shape[-2:]),1536)

    def test_polygon_score_mapping_and_expansion(self):
        p=np.zeros((64,128),np.float32);p[20:40,30:60]=.9
        rows=coo.polygons(p,1280,640)
        self.assertEqual(len(rows),1)
        r=rows[0];self.assertEqual(r['cls'],'text_free')
        self.assertAlmostEqual(r['score'],.9,places=5)
        self.assertLess(r['box'][0],300);self.assertGreater(r['box'][2],590)
        self.assertTrue(all(0<=p['x']<=1 and 0<=p['y']<=1 for p in r['polygon']))
        self.assertEqual(coo.polygons(p,1280,640,.95),[])

    def test_border_and_disconnected_effects(self):
        p=np.zeros((64,128),np.float32);p[0:20,0:20]=.95;p[40:60,100:125]=.9
        rows=coo.polygons(p,128,64)
        self.assertEqual(len(rows),2)
        self.assertTrue(all(r['box'][0]>=0 and r['box'][1]>=0 and r['box'][2]<=128 and r['box'][3]<=64 for r in rows))
        self.assertEqual(coo.polygons(np.full((64,128),.1,np.float32),128,64),[])

    def test_stride_two_matches_legacy_pointer_layout(self):
        offset=torch.arange(18*8*10).reshape(1,18,8,10).float()
        mask=torch.arange(9*8*10).reshape(1,9,8,10).float()
        a,b=legacy_offsets(offset,mask,4,5)
        self.assertEqual(tuple(a.shape),(1,18,4,5))
        # CUDA uses channel*Hout*Wout + y*Wout + x, not stride sampling.
        self.assertEqual(a[0,7,2,3].item(),7*4*5+2*5+3)
        self.assertEqual(b[0,4,1,2].item(),4*4*5+1*5+2)

    def test_checkpoint_checksum_rejects_corruption_before_deserialization(self):
        with tempfile.TemporaryDirectory() as folder:
            p=pathlib.Path(folder)/'bad.pt';p.write_bytes(b'not a model')
            with self.assertRaisesRegex(ValueError,'checksum'):
                COOModel(p)

    def test_auto_enable_requires_model_and_off_overrides_installed(self):
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'model'
            with patch.dict(os.environ,{'SCAN_COO':'auto','SCAN_COO_MODEL':str(path)}):
                self.assertFalse(coo.enabled());path.touch();self.assertTrue(coo.enabled())
                with patch.dict(os.environ,{'SCAN_COO':'0'}):self.assertFalse(coo.enabled())

    def test_tiled_polygons_map_to_source(self):
        class Model:
            def __call__(self,image):
                p=torch.zeros(1,1,64,64);p[:,:,20:40,20:40]=.95;return p
        with tempfile.TemporaryDirectory() as folder:
            path=pathlib.Path(folder)/'model';path.touch()
            with patch.dict(os.environ,{'SCAN_COO_MODEL':str(path)}),patch.dict(coo._models,{(str(path),'cpu'):Model()}):
                rows=coo.detect(np.zeros((1800,2200,3),np.uint8))
        self.assertTrue(any(r['crop'][0]>0 for r in rows))
        for r in rows:
            xs=[p['x']*2200 for p in r['polygon']];ys=[p['y']*1800 for p in r['polygon']]
            np.testing.assert_allclose(r['box'],[min(xs),min(ys),max(xs),max(ys)],atol=1e-3)

if __name__=='__main__':unittest.main()
