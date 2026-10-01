import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {id,calls,cleanup,store} from './task-adapter-fixture';
const {runVisionRead} = await import('../src/lib/server/visionRead');
after(cleanup);
test('vision workflow uses an unknown package and forwards context and image attachments',async()=>{
 const result=await runVisionRead(id,{jpeg:Buffer.from('fixture'),lang:'korean'});
 assert.equal(result.source,'待って');
 const last=(await calls()).at(-1);
 assert.equal(last.task.id,'vision');
 assert.equal(last.input.lang,'korean');
 assert.equal(last.attachments.length,1);
 assert.equal(last.model.slug,'fixture-revision');
});
test('unknown selection and untested model override never reach the adapter',async()=>{
 const before=(await calls()).length;
 await assert.rejects(runVisionRead('missing',{jpeg:Buffer.from('fixture')}),/Unsupported/);
 await assert.rejects(runVisionRead(id,{jpeg:Buffer.from('fixture'),model:'new-revision'}),/current passing/);
 assert.equal((await calls()).length,before);
});
test('cancellation and failed evidence block production reads',async()=>{
 const before=(await calls()).length;
 await assert.rejects(runVisionRead(id,{jpeg:Buffer.from('fixture'),abort:AbortSignal.abort()}));
 store.saveProbeResult(id,{operation:'vision',ok:false,outcome:'unsupported',at:Date.now()});
 await assert.rejects(runVisionRead(id,{jpeg:Buffer.from('fixture')}),/current passing/);
 assert.equal((await calls()).length,before);
});
