import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {id,calls,cleanup,store} from './task-adapter-fixture';
const {translateOcrSource}=await import('../src/lib/server/ocrReview');
const {reviewSource}=await import('../src/lib/server/regionAi');
after(cleanup);
test('OCR English uses the selected translator package with language and glossary',async()=>{
 const out=await translateOcrSource('待って',new AbortController().signal,{engine:id,lang:'japanese',seriesGlossary:'Name'});
 assert.equal(out,'Test. 待って');
 const last=(await calls()).at(-1);
 assert.equal(last.task.id,'translate');
 assert.equal(last.input.lang,'japanese');
 assert.equal(last.input.seriesGlossary,'Name');
 assert.equal(last.attachments.length,0);
});
test('reader without enquiry supplies source and selected translator supplies attributed English',async()=>{
 const result=await reviewSource({engine:id,model:''},Buffer.from('fixture'),undefined,'japanese',{engine:id});
 assert.equal(result.suggestions[0].text,'待って');
 assert.equal(result.suggestions[0].translation,'Test. 待って');
 assert.match(result.answer,/English supplied by/);
 assert.equal(store.findRegistryRow(id)!.probes?.advisory,undefined);
});
test('translator failure is reported separately without invalidating reader evidence',async()=>{
 store.saveProbeResult(id,{operation:'translate',ok:false,outcome:'unsupported',at:Date.now()});
 await assert.rejects(reviewSource({engine:id,model:''},Buffer.from('fixture'),undefined,'japanese',{engine:id}),/independent reading completed.*English translation could not run/);
 assert.equal(store.findRegistryRow(id)!.probes?.sourceReview?.ok,true);
});
