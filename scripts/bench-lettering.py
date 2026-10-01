#!/usr/bin/env python3
"""Offline regression runner; never changes the application database.

Usage: .venv-workflow/bin/python scripts/bench-lettering.py BASELINE --out OUTPUT
BASELINE contains snapshot.json and N-prepared.png captured before testing.
Optional annotations.json maps page numbers to text boxes, required/protected
binary PNG masks. Box matching uses IoU >= .5 and one-to-one assignments.
"""
import argparse, hashlib, importlib.util, json, pathlib, sys, time
import cv2
import numpy as np
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'ocr'))
import detect, lettering


def match_boxes(pred, truth):
    pairs=[]
    for i,a in enumerate(pred):
        for j,b in enumerate(truth):
            inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
            union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
            if union>0 and inter/union>=.5:pairs.append((inter/union,i,j))
    used_p=set();used_t=set()
    for _,i,j in sorted(pairs,reverse=True):
        if i not in used_p and j not in used_t:used_p.add(i);used_t.add(j)
    return {'precision':len(used_p)/max(1,len(pred)),'recall':len(used_t)/max(1,len(truth))}


def main():
    ap=argparse.ArgumentParser();ap.add_argument('baseline',type=pathlib.Path);ap.add_argument('--out',type=pathlib.Path,required=True);args=ap.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    snap=json.loads((args.baseline/'snapshot.json').read_text())
    annotations=json.loads((args.baseline/'annotations.json').read_text()) if (args.baseline/'annotations.json').exists() else {}
    old=None
    if (args.baseline/'detect.py').exists():
        spec=importlib.util.spec_from_file_location('baseline_detect',args.baseline/'detect.py');old=importlib.util.module_from_spec(spec);spec.loader.exec_module(old)
    results=[]
    source_hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (pathlib.Path(detect.__file__), pathlib.Path(lettering.__file__))}
    for n,page in enumerate(snap['images'],1):
        image=cv2.imread(str(args.baseline/f'{n}-prepared.png'));h,w=image.shape[:2]
        t=time.perf_counter();detected=detect.detect_rtdetr(image);elapsed=time.perf_counter()-t
        if old:
            t=time.perf_counter();previous=old.detect_rtdetr(image);old_elapsed=time.perf_counter()-t
        else:previous=[];old_elapsed=None
        text=[r for r in detected if r['cls'] in detect.TEXT_CLASSES]
        regions=[]
        for line in snap['lines']:
            if line['image_id']!=page['id'] or line['source_state']=='ignored':continue
            doc=next((d['data'] for d in snap['workflow_docs'] if d['id']=='region:'+line['id']),{})
            x,y,rh,rw=line['x'],line['y'],line['h'],line['w']
            if x is None:continue
            regions.append(doc.get('polygon') or [{'x':x,'y':y},{'x':x+rw,'y':y},{'x':x+rw,'y':y+rh},{'x':x,'y':y+rh}])
        if not regions:
            for row in text:
                x,y,r,b=row['box'];pad=4
                x,y,r,b=max(0,x-pad)/w,max(0,y-pad)/h,min(w,r+pad)/w,min(h,b+pad)/h
                regions.append([{'x':x,'y':y},{'x':r,'y':y},{'x':r,'y':b},{'x':x,'y':b}])
        t=time.perf_counter();mask,diagnostics,_meta=lettering.propose(image,regions);mask_elapsed=time.perf_counter()-t
        cv2.imwrite(str(args.out/f'{n}-mask.png'),mask)
        overlay=image.copy();overlay[mask>0]=(overlay[mask>0]*.5+np.array([40,40,255])*.5).astype(np.uint8)
        cv2.imwrite(str(args.out/f'{n}-overlay.png'),overlay)
        boxes=image.copy()
        for row in text:
            x,y,r,b=map(round,row['box']);cv2.rectangle(boxes,(x,y),(r,b),(0,0,255),1)
        cv2.imwrite(str(args.out/f'{n}-detection.png'),boxes)
        record={'page':n,'imageId':page['id'],'textRegions':len(text),'baselineTextRegions':len([r for r in previous if r['cls'] in detect.TEXT_CLASSES]),'detectSeconds':elapsed,'baselineDetectSeconds':old_elapsed,'maskSeconds':mask_elapsed,'maskPixels':int(np.count_nonzero(mask)),'diagnostics':diagnostics,'regions':regions,'detections':detected,'baselineDetections':previous}
        truth=annotations.get(str(n),{})
        if truth.get('sourceSha256') and hashlib.sha256((args.baseline/f'{n}-prepared.png').read_bytes()).hexdigest() != truth['sourceSha256']:
            raise ValueError(f'Page {n}: annotation source hash mismatch')
        if 'boxes' in truth:
            record['detectionMetrics']=match_boxes([r['box'] for r in text],truth['boxes'])
            record['baselineDetectionMetrics']=match_boxes([r['box'] for r in previous if r['cls'] in detect.TEXT_CLASSES],truth['boxes'])
        for key in ('required','protected'):
            if key not in truth:continue
            expected=cv2.imread(str(args.baseline/truth[key]),0)>0
            record[key+'Pixels']=int(np.count_nonzero(expected))
            record[key+'MaskedPixels']=int(np.count_nonzero(expected & (mask>0)))
        results.append(record)
        (args.out/'results.json').write_text(json.dumps({'version':lettering.VERSION,'sourceHashes':source_hashes,'models':{'detector':detect.RTDETR_REPO+'/'+detect.RTDETR_FILE,'mask':detect.CTD_REPO+'/'+detect.CTD_FILE},'thresholds':{'strong':lettering.STRONG,'weak':lettering.WEAK},'pages':results},indent=2))
        print(f'Page {n}: {len(text)} regions, detection {elapsed:.2f}s, mask {mask_elapsed:.2f}s',flush=True)

if __name__=='__main__':main()
