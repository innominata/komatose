import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {id,calls,cleanup,store} from './task-adapter-fixture';
const {runTranslationTask}=await import('../src/lib/server/translationTask');
after(cleanup);
const boxes=[{id:'r1',source:'テスト',x:.1,y:.2,w:.3,h:.4,lineType:'""' as const,literal:'',translation:'',reasoning:''}];
const context={seriesNotes:'Scene',seriesGlossary:'Name',prior:'Earlier',pageLabel:'Page 2',lang:'japanese' as const};
test('unknown translator package receives all context and preserves region identity',async()=>{
 const out=await runTranslationTask({engine:id,boxes,...context});
 assert.equal(out[0].translation,'Test. テスト');
 for(const key of ['id','source','x','y','w','h'] as const) assert.equal(out[0][key],boxes[0][key]);
 const input=(await calls()).at(-1).input;
 for(const [key,value] of Object.entries(context)) assert.equal(input[key],value);
 assert.equal(boxes[0].translation,'');
});
test('unavailable selections, overrides and cancelled requests never silently fall back',async()=>{
 const before=(await calls()).length;
 await assert.rejects(runTranslationTask({engine:'missing',boxes,...context}),/Unsupported/);
 await assert.rejects(runTranslationTask({engine:id,boxes,...context,model:'different'}),/current passing/);
 await assert.rejects(runTranslationTask({engine:id,boxes,...context,abort:AbortSignal.abort()}));
 assert.equal((await calls()).length,before);
});
test('an unsupported retest prevents production translation',async()=>{
 store.saveProbeResult(id,{operation:'translate',ok:false,outcome:'unsupported',at:Date.now()});
 await assert.rejects(runTranslationTask({engine:id,boxes,...context}),/current passing/);
});
