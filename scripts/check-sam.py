import pathlib
import json
import sys
import cv2
import numpy as np
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'ocr'))
import workflow
img=np.full((400,500,3),255,np.uint8)
cv2.ellipse(img,(250,200),(150,100),0,0,360,(0,0,0),5)
result=workflow.geometry(img,{'method':'sam','device':'cpu','box':[.18,.22,.64,.56],'points':[{'x':.5,'y':.5}]})
assert len(result['polygon'])>=3
assert 'sam2._C' not in sys.modules, 'CUDA extension must stay disabled'
pathlib.Path('/tmp/scan-sam-check.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'vertices':len(result['polygon']),'confidence':result['confidence'],'device':'CPU','cudaExtensionLoaded':False}))
