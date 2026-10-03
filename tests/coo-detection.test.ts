import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSfxRegions, regionsFromDetection, cooEnabled, composeDetections, parseKoharuRegions, jobStepMessage, koharuDetectionMode } from '../src/lib/server/detect';
const shape = [{x:.2,y:.2},{x:.4,y:.2},{x:.35,y:.4},{x:.2,y:.35}];
const sfx = {box:[100,100,200,200],score:.9,polygon:shape,backend:'coo-dbnetpp-v1'};
test('COO contour survives conversion and suppresses a similar RT-DETR duplicate',()=>{
 const rows=regionsFromDetection([...parseSfxRegions([sfx]),{cls:'text_free',box:[105,105,195,195],score:.4}],500,500);
 assert.equal(rows.length,1);assert.equal(rows[0].kind,'free');
 assert.deepEqual(rows[0].polygon,shape);assert.equal(rows[0].provenance?.backend,sfx.backend);
});
test('COO does not swallow nested dialogue or balloon classification',()=>{
 const rows=regionsFromDetection([...parseSfxRegions([sfx]),{cls:'text_bubble',box:[120,120,160,160],score:.95}],500,500);
 assert.equal(rows.length,2);assert.ok(rows.some(r=>r.kind==='bubble'));
});
test('malformed COO output is rejected',()=>{
 for(const raw of [null,{},[{}],[{...sfx,score:NaN}],[{...sfx,box:[100,100,NaN,200]}],
  [{...sfx,polygon:[{x:2,y:0},...shape]}],[{...sfx,polygon:[]}]] ) assert.deepEqual(parseSfxRegions(raw),[]);
});
test('a Koharu segment alone is evidence, not a region', () => {
 const found = composeDetections({
  rtdetr: [{ cls: 'text_bubble', score: 0.9, box: [10, 10, 80, 60] }, { cls: 'text_free', score: 0.9, box: [300, 300, 340, 380] }],
  ctd: [],
  koharu: parseKoharuRegions([{ box: [10, 12, 78, 58], score: 0.8 }, { box: [200, 200, 260, 240], score: 0.8 }, { box: [1] }]),
 }, 500, 500);
 assert.equal(found.length, 2);
 assert.ok(found.every((row) => row.provenance?.backend === 'rtdetr'));
});
test('with no box detector Koharu supplies the regions', () => {
 const found = composeDetections({ koharu: parseKoharuRegions([{ box: [200, 200, 260, 240], score: 0.8 }]) }, 500, 500);
 assert.equal(found.length, 1);
 assert.equal(found[0].provenance?.backend, 'koharu');
});
test('job status names the page, step, and model', () => {
  assert.equal(jobStepMessage(2, 8, 'Detecting text regions', 'Koharu SAM-TS-L'),
    'Page 2/8 · Detecting text regions · Koharu SAM-TS-L');
});
test('Koharu detection follows the mask engine unless overridden', () => {
  const previous = { detect: process.env.SCAN_KOHARU_DETECT, mask: process.env.SCAN_MASK_ENGINE };
  try {
    delete process.env.SCAN_KOHARU_DETECT;
    delete process.env.SCAN_MASK_ENGINE;
    assert.equal(koharuDetectionMode(), 'auto');
    process.env.SCAN_MASK_ENGINE = 'ctd';
    assert.equal(koharuDetectionMode(), 'off');
    process.env.SCAN_MASK_ENGINE = 'koharu';
    assert.equal(koharuDetectionMode(), 'on');
    process.env.SCAN_KOHARU_DETECT = '0';
    assert.equal(koharuDetectionMode(), 'off');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = key === 'detect' ? 'SCAN_KOHARU_DETECT' : 'SCAN_MASK_ENGINE';
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
test('COO can be disabled explicitly',()=>{
 const old=process.env.SCAN_COO;
 try{process.env.SCAN_COO='0';assert.equal(cooEnabled(),false);}
 finally{if(old===undefined)delete process.env.SCAN_COO;else process.env.SCAN_COO=old;}
});
