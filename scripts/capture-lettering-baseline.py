#!/usr/bin/env python3
"""Capture only a named episode's test inputs, using a read-only database."""
import argparse, hashlib, json, pathlib, shutil, sqlite3
ap=argparse.ArgumentParser()
ap.add_argument('episode');ap.add_argument('--data',type=pathlib.Path,default=pathlib.Path('data'))
ap.add_argument('--out',type=pathlib.Path,required=True);args=ap.parse_args()
if args.out.exists():raise SystemExit('Choose a new output directory; baselines are immutable.')
conn=sqlite3.connect(f'file:{(args.data/"scan.db").resolve()}?mode=ro',uri=True);conn.row_factory=sqlite3.Row
conn.execute('BEGIN')
snapshot={table:[dict(row) for row in conn.execute(f'SELECT * FROM {table} WHERE episode_id=?'+(' ORDER BY sort_order' if table=='images' else ''),(args.episode,))] for table in ('images','lines','workflow_docs')}
if not snapshot['images']:raise SystemExit('Episode has no pages.')
args.out.mkdir(parents=True)
for doc in snapshot['workflow_docs']:doc['data']=json.loads(doc['data'])
checksums={}
for n,page in enumerate(snapshot['images'],1):
    doc=next((d['data'] for d in snapshot['workflow_docs'] if d['id']=='page:'+page['id']),{})
    for key in ('prepared','mask'):
        if key not in doc:continue
        name=f'{n}-{key}.png';raw=(args.data/'workflow/assets'/doc[key]).read_bytes()
        (args.out/name).write_bytes(raw);checksums[name]=hashlib.sha256(raw).hexdigest()
for name in ('detect.py','workflow.py','lettering.py'):
    source=pathlib.Path('ocr')/name
    if source.exists():shutil.copyfile(source,args.out/name)
(args.out/'snapshot.json').write_text(json.dumps(snapshot,indent=2))
(args.out/'checksums.json').write_text(json.dumps(checksums,indent=2))
print(f'Captured {len(snapshot["images"])} pages in {args.out}')
