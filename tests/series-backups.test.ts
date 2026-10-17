import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import sharp from 'sharp';

const root = await mkdtemp(join(tmpdir(), 'komatose-series-backups-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.DATABASE_URL = join(root, 'data/scan.db');
const { sqlite } = await import('../src/lib/server/db');
const { createSeriesBackup, restoreSeriesBackup, importSeriesBackup, listSeriesBackups, seriesBackupArchivePath, recoverSeriesRestores } = await import('../src/lib/server/seriesBackups');
const { storeAsset, putDoc, getDoc } = await import('../src/lib/server/workflowStore');
const { trackSeriesWrite, lockSeries, seriesMaintenanceMessage } = await import('../src/lib/server/seriesMaintenance');
const { getSeries, getEpisode, listImages, listLines } = await import('../src/lib/server/queries');
const { preparePage } = await import('../src/lib/server/workflowService');
const { actions } = await import('../src/routes/backups/+page.server');
const { GET } = await import('../src/routes/api/series-backups/[id]/+server');

const user = { id: 'admin', username: 'Admin', role: 'admin' as const };
sqlite.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES('admin','Admin','PRIVATE PASSWORD','admin',1),('other','Other','PRIVATE PASSWORD','translator',1)").run();
after(async () => { sqlite.close(); await rm(root, { recursive: true, force: true }); });

let sequence = 0;
async function fixture() {
  const id = `backup-series-${++sequence}`, ep = `${id}-chapter`, image = `${id}-image`, line = `${id}-line`, run = `${id}-run`, job = `${id}-job`;
  sqlite.prepare("INSERT INTO series(id,slug,title,notes,glossary,credits,created_by,created_at,updated_at) VALUES(?,?,?,'Series notes','[]','{}','admin',1,1)").run(id,id,id);
  sqlite.prepare("INSERT INTO series_members(series_id,user_id,created_at) VALUES(?,'admin',1)").run(id);
  sqlite.prepare("INSERT INTO episodes(id,series_id,slug,title,status,preview_token,created_at,updated_at) VALUES(?,?,'5','5','done',?,1,1)").run(ep,id,`${id}-preview-token`);
  sqlite.prepare("INSERT INTO images(id,episode_id,filename,original_name,sort_order,width,height,created_at,updated_at,page_number) VALUES(?,?,'page.png','upload.png',0,64,64,1,1,1)").run(image,ep);
  sqlite.prepare("INSERT INTO lines(id,episode_id,image_id,body,source,source_state,status,placed,invert,x,y,w,h,created_by,updated_by,updated_at) VALUES(?,?,?,'Translation','Source','read','approved',1,1,0.1,0.2,0.3,0.4,'admin','admin',1)").run(line,ep,image);
  sqlite.prepare("INSERT INTO comments(id,line_id,user_id,body,created_at) VALUES(?,?,'admin','Review comment',1)").run(`${id}-comment`,line);
  sqlite.prepare("INSERT INTO suggestions(id,episode_id,line_id,base_revision,body,reason,kind,state,created_at) VALUES(?,?,?,0,'Alternative','Reason','review','pending',1)").run(`${id}-suggestion`,ep,line);
  const png = await sharp({ create:{ width:64,height:64,channels:3,background:'#123456' } }).png().toBuffer();
  const raw = await sharp({ create:{ width:64,height:64,channels:3,background:'#ffffff' } }).png().toBuffer();
  const asset = await storeAsset(png), original = await storeAsset(raw);
  const undoOnly = await storeAsset(await sharp({create:{width:64,height:64,channels:3,background:'#abcdef'}}).png().toBuffer());
  putDoc(null,`series:${id}`,{ lang:'korean',direction:'ltr',styles:{ ST:{size:20} } },0);
  putDoc(ep,`chapter:${ep}`,{chapterSummary:'Chapter notes'},0);
  putDoc(ep,`page:${image}`,{prepared:original,original,preparedAt:1,thumbnail:original,thumbnailAt:1,cleanBase:asset,cleanApproved:true,completed:{clean:'saved'}},0);
  putDoc(ep,`region:${line}`,{polygon:[{x:0.1,y:0.2}],style:{size:18},textMask:asset,speaker:{name:'Character'}},0);
  putDoc(ep,`region:${line}`,{...getDoc<Record<string,unknown>>(`region:${line}`,{}).data,locked:true},1);
  sqlite.prepare("UPDATE workflow_docs SET redo='[{\"locked\":false}]' WHERE id=?").run(`region:${line}`);
  sqlite.prepare("INSERT INTO font_assets(id,series_id,hash,filename,metadata,created_at) VALUES(?,?,?,'font.ttf','{}',1)").run(`${id}-font`,id,asset);
  sqlite.prepare("INSERT OR IGNORE INTO global_font_assets(id,hash,filename,metadata,created_at) VALUES(? ,?,'shared.otf','{}',1)").run(original,original);
  putDoc(null,`series:${id}`,{...getDoc<Record<string,unknown>>(`series:${id}`,{}).data,style:{fontId:original}},1);
  sqlite.prepare("INSERT INTO workflow_jobs(id,episode_id,kind,state,payload,progress,created_at,updated_at) VALUES(?,?,'export','completed','{}',?,1,1)").run(job,ep,JSON.stringify({artifact:asset}));
  sqlite.prepare("INSERT INTO job_pages(job_id,image_id,state) VALUES(?,?,'completed')").run(job,image);
  sqlite.prepare("INSERT INTO director_runs(id,episode_id,user_id,scope,model,proofreader,state,page_ids,created_at,updated_at) VALUES(?,?,'admin','chapter','model','{}','completed',?,1,1)").run(run,ep,JSON.stringify([image]));
  sqlite.prepare("INSERT INTO director_pages(episode_id,image_id,state,run_id,updated_at) VALUES(?,?,'passed',?,1)").run(ep,image,run);
  sqlite.prepare("INSERT INTO director_events(run_id,episode_id,image_id,kind,detail,created_at) VALUES(?,?,?,'review','Saved audit',1)").run(run,ep,image);
  sqlite.prepare("INSERT INTO director_changes(run_id,episode_id,image_id,label,before_json,after_json,created_at) VALUES(?,?,?,'Change','{}','{}',1)").run(run,ep,image);
  sqlite.prepare('INSERT INTO director_assets(run_id,hash) VALUES(?,?)').run(run,asset);
  sqlite.prepare("INSERT INTO director_stages(run_id,image_id,stage,state,attempts,input,detail,updated_at) VALUES(?,?,'clean','completed',1,'{}','{}',1)").run(run,image);
  sqlite.prepare("INSERT INTO director_operations(run_id,episode_id,image_id,label,before_json,finished) VALUES(?,?,?,'Operation','{}',1)").run(run,ep,image);
  sqlite.prepare("INSERT INTO director_series(series_id,data) VALUES(?,'{\"memory\":true}')").run(id);
  sqlite.prepare("INSERT INTO director_examples(id,series_id,episode_id,image_id,line_id,type_id,fingerprint,data,updated_at) VALUES(?,?,?,?,?,'ST','fingerprint','{}',1)").run(`${id}-example`,id,ep,image,line);
  sqlite.prepare('INSERT INTO director_memory_assets(series_id,hash) VALUES(?,?)').run(id,asset);
  sqlite.prepare("INSERT INTO director_created_types(series_id,type_id,run_id,image_id,data) VALUES(?,'ST',?,?,'{}')").run(id,run,image);
  sqlite.prepare("INSERT INTO director_classifications(line_id,run_id,fingerprint,data) VALUES(?,?,'fingerprint','{}')").run(line,run);
  sqlite.prepare('UPDATE episodes SET numbering_stale=0 WHERE id=?').run(ep);
  const dir = join(root,'data/images',id,'5');
  await mkdir(join(dir,'reslice-undo-saved'),{recursive:true});
  for (const [name,bytes] of [['page.png',png],['page.png.orig',raw],['page.png.bak.1',raw],['reslice-undo-saved/old.png',raw]] as const) await writeFile(join(dir,name),bytes);
  await writeFile(join(dir,'undo.json'),JSON.stringify([{type:'reslice',dir:join(dir,'reslice-undo-saved'),previous:[],createdIds:[image],lines:[],geometry:{[image]:{page:{prepared:undoOnly},lines:[]}}}]));
  return {id,ep,image,line,dir,asset,original,undoOnly,png,raw};
}

test('series backup restores every scoped table, images, assets, undo, shared fonts and deleted chapters',async()=>{
  const f=await fixture(), unrelated=await fixture();
  const otherBefore=sqlite.prepare('SELECT * FROM episodes WHERE id=?').get(unrelated.ep);
  const backup=await createSeriesBackup(f.id,user,'Before testing');
  const bytes=await readFile(seriesBackupArchivePath(backup.id));
  assert.ok(!bytes.includes(Buffer.from('PRIVATE PASSWORD')));
  const zip=await JSZip.loadAsync(bytes), header=JSON.parse(await zip.file('manifest.json')!.async('string'));
  const manifest={...header,tables:Object.fromEntries(await Promise.all(Object.keys(header.tables).map(async table=>[table,(await zip.file(`tables/${table}.jsonl`)!.async('string')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))])))};
  assert.equal(manifest.tables.director_examples.length,1);
  assert.ok(zip.file(`assets/${f.undoOnly}`),'assets used only by page undo history are retained');
  const originalDoc=sqlite.prepare('SELECT * FROM workflow_docs WHERE id=?').get(`region:${f.line}`) as Record<string,unknown>;
  sqlite.prepare('DELETE FROM episodes WHERE id=?').run(f.ep);
  sqlite.prepare("UPDATE series SET notes='Test edits',slug=? WHERE id=?").run(`${f.id}-renamed`,f.id);
  await rm(join(root,'data/images',f.id),{recursive:true});
  await mkdir(join(root,'data/images',`${f.id}-renamed`),{recursive:true});
  // Deleted shared dependencies are restored from the archive.
  sqlite.prepare('DELETE FROM global_font_assets WHERE id=?').run(f.original);
  await rm(join(root,'data/workflow/assets',f.asset));
  const result=await restoreSeriesBackup(backup.id,user);
  assert.ok(result.safetyBackupId);
  assert.equal((await getSeries(f.id))!.notes,'Series notes');
  assert.equal((await getEpisode(f.ep))!.status,'done');
  const [line]=await listLines(f.ep);
  assert.equal(line.body,'Translation'); assert.equal(line.source,'Source'); assert.equal(line.placed,true);
  const restored=sqlite.prepare('SELECT * FROM workflow_docs WHERE id=?').get(`region:${f.line}`) as Record<string,unknown>;
  for (const field of ['data','undo','redo']) assert.equal(restored[field],originalDoc[field]);
  assert.ok(Number(restored.revision)>Number(originalDoc.revision));
  assert.deepEqual(await readFile(join(f.dir,'page.png')),f.png);
  assert.deepEqual(await readFile(join(f.dir,'page.png.orig')),f.raw);
  assert.deepEqual(await readFile(join(f.dir,'page.png.bak.1')),f.raw);
  assert.deepEqual(await readFile(join(f.dir,'reslice-undo-saved/old.png')),f.raw);
  assert.deepEqual(await readFile(join(root,'data/workflow/assets',f.asset)),f.png);
  for (const table of Object.keys(manifest.tables)) {
    if (table==='global_font_assets' || table==='activity') continue;
    for (const original of manifest.tables[table]) {
      const columns=(sqlite.prepare(`PRAGMA table_info(${table})`).all() as {name:string;pk:number}[]).filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
      const row=sqlite.prepare(`SELECT * FROM ${table} WHERE ${columns.map(c=>`${c}=?`).join(' AND ')}`).get(...columns.map(c=>original[c])) as Record<string,unknown>;
      assert.ok(row,table);
      for (const key of Object.keys(original)) if (!['revision','caption_revision','base_revision'].includes(key)) assert.deepEqual(row[key],original[key],`${table}.${key}`);
    }
  }
  const e=await getEpisode(f.ep),s=await getSeries(f.id),[image]=await listImages(f.ep);
  const before=getDoc(`page:${f.image}`,{});
  await preparePage(s!,e!,image);
  assert.deepEqual(getDoc(`page:${f.image}`,{}),before,'preparing restored pages retains saved cleaning');
  assert.deepEqual(sqlite.prepare('SELECT * FROM episodes WHERE id=?').get(unrelated.ep),otherBefore);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal((await listSeriesBackups(user)).filter(b=>b.seriesId===f.id).length,2,'original and safety backups persist');
  await restoreSeriesBackup(result.safetyBackupId!,user);
  assert.equal((await getSeries(f.id))!.notes,'Test edits','the safety backup can undo a restore');
  assert.equal((await getSeries(f.id))!.slug,`${f.id}-renamed`);
  assert.equal(await getEpisode(f.ep),null);
  assert.deepEqual(sqlite.prepare('SELECT * FROM episodes WHERE id=?').get(unrelated.ep),otherBefore);
});

test('download/import validates contents and restores a series after deletion without account data',async()=>{
  const f=await fixture(),backup=await createSeriesBackup(f.id,user,'Delete test');
  const response=await GET({locals:{user},params:{id:backup.id}} as never);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');
  const bytes=Buffer.from(await response.arrayBuffer());
  sqlite.prepare('DELETE FROM series WHERE id=?').run(f.id);
  await rm(join(root,'data/images',f.id),{recursive:true});
  const imported=await importSeriesBackup(bytes,user);
  await restoreSeriesBackup(imported.id,user);
  assert.ok(await getEpisode(f.ep));
  assert.equal((await listLines(f.ep)).length,1);
});

test('bad schema, corrupt files and unsafe archive paths are rejected before any restore writes',async()=>{
  const f=await fixture(),backup=await createSeriesBackup(f.id,user);
  const before=sqlite.prepare('SELECT * FROM series WHERE id=?').get(f.id);
  const original=await readFile(seriesBackupArchivePath(backup.id));
  for (const scenario of ['schema','corruption','traversal','scope','missing-file']) {
    const zip=await JSZip.loadAsync(original),m=JSON.parse(await zip.file('manifest.json')!.async('string'));
    if(scenario==='schema')m.schema='other-version';
    if(scenario==='corruption')zip.file(m.files[0].path,'corrupt');
    if(scenario==='traversal')m.files[0].path='images/../../escape';
    if(scenario==='scope'){
      const rows=(await zip.file('tables/images.jsonl')!.async('string')).trim().split('\n').map(line=>JSON.parse(line));rows[0].episode_id='other-series';
      const text=rows.map(row=>JSON.stringify(row)+'\n').join('');zip.file('tables/images.jsonl',text);m.tableHashes.images=createHash('sha256').update(text).digest('hex');
    }
    if(scenario==='missing-file')zip.remove(m.files[0].path);
    zip.file('manifest.json',JSON.stringify(m));
    await assert.rejects(importSeriesBackup(await zip.generateAsync({type:'nodebuffer'}),user));
    assert.deepEqual(sqlite.prepare('SELECT * FROM series WHERE id=?').get(f.id),before);
  }
});

test('series permissions, running jobs and overlapping editor writes are enforced',async()=>{
  const f=await fixture();
  const stranger={id:'other',username:'Other',role:'translator' as const};
  await assert.rejects(createSeriesBackup(f.id,stranger),{status:403});
  const backup=await createSeriesBackup(f.id,user);
  assert.equal((await GET({locals:{user:stranger},params:{id:backup.id}} as never)).status,403);
  await assert.rejects(restoreSeriesBackup(backup.id,stranger),{status:403});
  assert.deepEqual(await listSeriesBackups(stranger),[]);
  sqlite.prepare("UPDATE workflow_jobs SET state='running' WHERE episode_id=?").run(f.ep);
  await assert.rejects(createSeriesBackup(f.id,user),{status:409});
  await assert.rejects(restoreSeriesBackup(backup.id,user),{status:409});
  sqlite.prepare("UPDATE workflow_jobs SET state='completed' WHERE episode_id=?").run(f.ep);
  const finished=trackSeriesWrite(f.id);
  await assert.rejects(createSeriesBackup(f.id,user),{status:409}); finished();
  const release=lockSeries(f.id,'restore');
  assert.ok(seriesMaintenanceMessage(f.id));
  assert.throws(()=>trackSeriesWrite(f.id),{status:409});release();
});

test('restore database failures roll back the filesystem and preserve the safety backup',async(t)=>{
  const f=await fixture(),backup=await createSeriesBackup(f.id,user);
  await writeFile(join(f.dir,'page.png'),'new working bytes');
  sqlite.prepare("UPDATE lines SET body='Later edit' WHERE id=?").run(f.line);
  const prepare=sqlite.prepare;
  t.mock.method(sqlite,'prepare',function(this:typeof sqlite,sql:string){
    if(sql.startsWith('INSERT INTO "lines"'))throw new Error('simulated restore failure');
    return prepare.call(this,sql);
  });
  try{await assert.rejects(restoreSeriesBackup(backup.id,user),/simulated restore failure/);}finally{t.mock.restoreAll();}
  assert.equal((await listLines(f.ep))[0].body,'Later edit');
  assert.equal(await readFile(join(f.dir,'page.png'),'utf8'),'new working bytes');
  assert.equal(seriesMaintenanceMessage(f.id),undefined);
  assert.equal((await listSeriesBackups(user)).filter(b=>b.seriesId===f.id).length,2);
  assert.ok(!(await readdir(join(root,'data/series-backups'))).some(name=>name.startsWith('.restore-')));
});

test('restore requires explicit confirmation at the form action',async()=>{
  const response=await actions.restore!({locals:{user},request:new Request('http://local/backups?/restore',{method:'POST',body:new FormData()})} as never) as {status:number};
  assert.equal(response.status,400);
});

test('interrupted restore swaps roll back before DB commit and finish after commit',async()=>{
  for (const committed of [false,true]) {
    const f=await fixture(),id=randomUUID(),work=join(root,'data/series-backups',`.restore-${id}`);
    const seriesDir=join(root,'data/images',f.id);
    await mkdir(work,{recursive:true});
    await writeFile(join(work,'journal.json'),JSON.stringify({id,seriesId:f.id,currentSlug:f.id,restoredSlug:f.id,hadCurrentDirectory:true}));
    await rename(seriesDir,join(work,'previous'));
    await mkdir(seriesDir);
    await writeFile(join(seriesDir,'new-state.txt'),'restored state');
    if(committed)sqlite.prepare("INSERT INTO activity(id,series_id,user_id,action,payload,created_at) VALUES(?,?,'admin','restored_series_backup','{}',1)").run(id,f.id);
    await recoverSeriesRestores();
    if(committed)assert.equal(await readFile(join(seriesDir,'new-state.txt'),'utf8'),'restored state');
    else assert.deepEqual(await readFile(join(f.dir,'page.png')),f.png);
    assert.ok(!(await readdir(join(root,'data/series-backups'))).includes(`.restore-${id}`));
  }
});
