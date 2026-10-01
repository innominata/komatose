#!/usr/bin/env python3
"""Read-only COO SFX regression benchmark. Requires the captured private pages."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'ocr'))
import coo
from coo_model import CHECKPOINT_SHA256


def iou(a,b):
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    return intersection/max(1,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('baseline',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--previous',type=Path,help='Optional bench-lettering results.json for comparison')
    args=parser.parse_args()
    annotations=json.loads((ROOT/'tests/fixtures/lettering/sfx.json').read_text())
    previous={r['page']:r['detections'] for r in json.loads(args.previous.read_text())['pages']} if args.previous else {}
    args.out.mkdir(parents=True,exist_ok=True)
    results=[]
    for n in range(1,9):
        path=args.baseline/f'{n}-prepared.png'
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        truth=annotations.get(str(n),{})
        if truth and truth['sourceSha256']!=digest:raise ValueError(f'Page {n}: annotation source hash mismatch')
        image=cv2.imread(str(path));h,w=image.shape[:2]
        started=time.monotonic();rows=coo.detect(image);elapsed=time.monotonic()-started
        scores=[]
        for box in truth.get('boxes',[]):
            scores.append({'expected':box,'cooIoU':max((iou(box,r['box']) for r in rows),default=0),
              'previousIoU':max((iou(box,r['box']) for r in previous.get(n,[]) if r['cls']!='bubble'),default=0)})
        for r in rows:
            points=np.array([[p['x']*w,p['y']*h] for p in r['polygon']],np.int32)
            cv2.polylines(image,[points],True,(0,0,255),2)
        cv2.imwrite(str(args.out/f'{n}-detection.png'),image)
        results.append({'page':n,'sourceSha256':digest,'seconds':elapsed,'regions':rows,'targets':scores})
        print(f'Page {n}: {len(rows)} SFX proposals, {elapsed:.2f}s',flush=True)
    report={'model':coo.VERSION,'checkpointSha256':CHECKPOINT_SHA256,'confidence':.6,'pages':results}
    (args.out/'results.json').write_text(json.dumps(report,indent=2)+'\n')

if __name__=='__main__':main()
