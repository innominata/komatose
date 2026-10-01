"""COO-trained DBNet++ SFX proposals. Coordinates are mapped to source pixels.

DB probabilities describe shrunken text regions, not removable lettering pixels.
They must never be used directly as an erasure mask.
"""
import math
import os
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / 'data/models/coo/dbnetpp-coo.pt'
VERSION = 'coo-dbnetpp-889a26c-v1'
MEAN = np.array([122.67891434, 116.66876762, 104.00698793], np.float32)
_models = {}


def model_path():
    return Path(os.environ.get('SCAN_COO_MODEL') or MODEL_PATH)


def enabled():
    mode = os.environ.get('SCAN_COO', 'auto').lower()
    return mode not in ('0', 'off', 'false') and (mode != 'auto' or model_path().is_file())


def prepare(image, short_side=736, max_side=1536):
    h,w = image.shape[:2]
    scale = min(short_side/min(h,w), max_side/max(h,w))
    nw,nh = max(32,math.ceil(w*scale/32)*32), max(32,math.ceil(h*scale/32)*32)
    # Upstream reads BGR with OpenCV, despite naming this constant RGB_MEAN.
    resized = cv2.resize(image,(nw,nh)).astype(np.float32)
    return np.ascontiguousarray(((resized-MEAN)/255).transpose(2,0,1)[None])


def polygons(probability, width, height, confidence=.6):
    import pyclipper
    mh,mw = probability.shape
    contours,_ = cv2.findContours((probability>.3).astype(np.uint8),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    rows=[]
    for contour in sorted(contours,key=cv2.contourArea,reverse=True)[:1024]:
        length=cv2.arcLength(contour,True)
        if length<=0 or cv2.contourArea(contour)<3: continue
        points=cv2.approxPolyDP(contour,.002*length,True).reshape(-1,2)
        if len(points)<3: continue
        x,y,w,h=cv2.boundingRect(points)
        inside=np.zeros((h,w),np.uint8)
        cv2.fillPoly(inside,[points-[x,y]],1)
        score=float(cv2.mean(probability[y:y+h,x:x+w],inside)[0])
        if score<confidence: continue
        offset=pyclipper.PyclipperOffset()
        offset.AddPath(points.tolist(),pyclipper.JT_ROUND,pyclipper.ET_CLOSEDPOLYGON)
        expanded=offset.Execute(cv2.contourArea(points)*2/max(1,cv2.arcLength(points,True)))
        if len(expanded)!=1: continue
        shape=np.asarray(expanded[0],np.float32)
        if min(cv2.minAreaRect(shape)[1])<5: continue
        shape[:,0]=np.clip(shape[:,0]*width/mw,0,width)
        shape[:,1]=np.clip(shape[:,1]*height/mh,0,height)
        shape=cv2.approxPolyDP(shape,.5,True).reshape(-1,2)
        if len(shape)<3: continue
        lo,hi=shape.min(axis=0),shape.max(axis=0)
        rows.append({'cls':'text_free','backend':VERSION,'score':score,
                     'box':[float(lo[0]),float(lo[1]),float(hi[0]),float(hi[1])],
                     'polygon':[{'x':float(x/width),'y':float(y/height)} for x,y in shape]})
    return rows


def detect(image, confidence=.6, device='cpu'):
    import torch
    from coo_model import COOModel
    from detect import _crops
    path=model_path()
    if not path.is_file(): raise RuntimeError('COO model missing; run scripts/install-coo.py')
    torch.set_num_threads(max(1,int(os.environ.get('SCAN_COO_THREADS','4'))))
    key=(str(path),device)
    if key not in _models: _models[key]=COOModel(path,device)
    h,w=image.shape[:2]
    # A bounded context view plus large overlapping crops for long/high-res pages.
    crops=[(0,0,w,h)] if max(h,w)<=1600 else list(_crops(w,h,1280,320))
    rows=[]
    for left,top,right,bottom in crops:
        crop=image[top:bottom,left:right]
        probability=_models[key](torch.from_numpy(prepare(crop)))[0,0].cpu().numpy()
        for row in polygons(probability,right-left,bottom-top,confidence):
            a,b,c,d=row['box'];row['box']=[a+left,b+top,c+left,d+top]
            row['polygon']=[{'x':(p['x']*(right-left)+left)/w,'y':(p['y']*(bottom-top)+top)/h} for p in row['polygon']]
            row['crop']=[left,top,right,bottom]
            row['truncated']=bool((left and a<3) or (top and b<3) or (right<w and c>right-left-3) or (bottom<h and d>bottom-top-3))
            rows.append(row)
    # Use suppression only: joining boxes would leave stale polygon geometry.
    kept=[]
    from detect import _iou_min
    for row in sorted(rows,key=lambda r:(r['truncated'],-r['score'])):
        a=row['box'];aa=(a[2]-a[0])*(a[3]-a[1])
        if any(_iou_min(a,b['box'])>.65 and min(aa,(b['box'][2]-b['box'][0])*(b['box'][3]-b['box'][1]))/max(1,aa,(b['box'][2]-b['box'][0])*(b['box'][3]-b['box'][1]))>.35 for b in kept):continue
        kept.append(row)
    return sorted(kept,key=lambda r:(r['box'][1],r['box'][0]))
