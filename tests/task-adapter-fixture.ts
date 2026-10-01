/** Real JSONL adapter used only in a temporary model/data directory. */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const root = await mkdtemp(join(tmpdir(), 'task-adapter-fixture-'));
process.env.SCAN_ROOT = root;
process.env.SCAN_DATA_DIR = join(root, 'data');
process.env.SCAN_BUNDLED_PACKAGES_DIR = join(root, 'packages');
process.env.DATABASE_URL = join(root, 'data/test.db');
await mkdir(join(root,'data'),{recursive:true});
const directory = join(root,'packages','unfamiliar-model');
await mkdir(directory,{recursive:true});
await writeFile(join(directory,'model.json'), JSON.stringify({version:1,id:'unfamiliar-model',name:'Fixture reader',revision:'1',access:'local_http',model:'fixture-revision',adapter:{id:'fixture',command:{executable:process.execPath,args:['{package}/adapter.mjs']}}}));
await writeFile(join(directory,'adapter.mjs'), `
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
for await(const line of createInterface({input:process.stdin})) {
 const r=JSON.parse(line); appendFileSync('calls.jsonl',JSON.stringify(r)+'\\n');
 let output, error;
 if(r.task.id==='translate') output=r.input.boxes.map(b=>({...b,translation:'Test. '+b.source}));
 else if(r.task.id==='vision') output={source:'待って',lineType:'""'};
 else if(r.task.id==='sourceReview') output={source:'待って',status:'unassessed',translation:'',answer:'Independent reading; uncertainty unassessed.'};
 else error={kind:'unsupported',message:'Fixture task unsupported'};
 console.log(JSON.stringify({protocol:1,requestId:r.requestId,type:'result',ok:!error,output,error}));
}`);
const packages = await import('../src/lib/server/modelPackages');
export const store = await import('../src/lib/server/modelRegistryStore');
const {probeModelRow} = await import('../src/lib/server/modelProbe');
packages.discoverModelPackages(true);
export const id = 'unfamiliar-model';
for (const task of ['translate','vision','sourceReview'] as const) {
 const result = await probeModelRow(store.findRegistryRow(id)!,task);
 if (!result.ok) throw new Error(result.reason);
 store.saveProbeResult(id,result);
}
export const calls = async () => (await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
export const cleanup = () => rm(root,{recursive:true,force:true});
