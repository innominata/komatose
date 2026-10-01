"""Compare real-page cleaning candidates without changing the default.

Writes masks, result images, difference maps, and objective timing/memory data.
Visual scoring is intentionally left to a reviewer, never inferred from timing.
"""
import argparse
import json
import os
import pathlib
import subprocess
import sys
import time
import cv2
import numpy as np

ROOT=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('images',nargs='+')
parser.add_argument('--out',default='/tmp/scan-cleaning-benchmark')
parser.add_argument('--methods',default='lama,big-lama,aot')
parser.add_argument('--device',default='cpu')
parser.add_argument('--mask',help='Optional approved mask for a single image')
args=parser.parse_args()
out=pathlib.Path(args.out);out.mkdir(parents=True,exist_ok=True)
rows=[]
def run(req):
    env={**os.environ,'SAM2_BUILD_CUDA':'0'}
    p=subprocess.run([sys.executable,str(ROOT/'ocr/workflow.py')],input=json.dumps(req)+'\n',text=True,capture_output=True,env=env,timeout=600)
    try:return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:return {'ok':False,'error':p.stderr[-3000:]}
for index,path in enumerate(args.images):
    img=cv2.imread(path)
    if img is None:raise ValueError(f'Cannot read {path}')
    # Keep the representative crop at native resolution; select the central page section.
    H,W=img.shape[:2]
    if not args.mask and H>2200:img=img[H//3:H//3+1800]
    source=out/f'{index+1}-source.png';cv2.imwrite(str(source),img)
    maskpath=pathlib.Path(args.mask) if args.mask else out/f'{index+1}-mask.png'
    if not args.mask:
        detected=run({'cmd':'mask','path':str(source),'out':str(maskpath),'detect':True,'expansion':1})
        if not detected.get('ok'):rows.append({'page':path,'stage':'mask',**detected});continue
    mask=cv2.imread(str(maskpath),cv2.IMREAD_GRAYSCALE)
    for method in args.methods.split(','):
        resultpath=out/f'{index+1}-{method}.png'
        result=run({'cmd':'clean','path':str(source),'out':str(resultpath),'mask':str(maskpath),'method':method,'device':args.device})
        row={'page':path,'method':method,**result,'visualReview':{'letteringRemoval':None,'bordersAndLines':None,'screentoneContinuity':None,'regressions':None}}
        if result.get('ok'):
            cleaned=cv2.imread(str(resultpath));delta=cv2.absdiff(img,cleaned)
            row['changedOutsideMask']=int(np.count_nonzero(delta[mask==0]))
            cv2.imwrite(str(out/f'{index+1}-{method}-difference.png'),np.minimum(delta.astype(np.uint16)*4,255).astype(np.uint8))
        rows.append(row)
        (out/'results.json').write_text(json.dumps(rows,indent=2))
        print(json.dumps(row),flush=True)
(out/'results.json').write_text(json.dumps(rows,indent=2))
