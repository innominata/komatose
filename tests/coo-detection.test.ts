import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSfxRegions, regionsFromDetection, cooEnabled, composeDetections, parseSamTsLRegions, jobStepMessage, samTsLDetectionMode } from '../src/lib/server/detect';
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
test('lettering only SAM-TS-L marks becomes its own region; a box detector keeps what it claims', () => {
 const found = composeDetections({
  rtdetr: [{ cls: 'text_bubble', score: 0.9, box: [10, 10, 80, 60] }, { cls: 'text_free', score: 0.9, box: [300, 300, 340, 380] }],
  ctd: [],
  'sam-ts-l': parseSamTsLRegions([{ box: [10, 12, 78, 58], score: 0.8 }, { box: [200, 200, 260, 240], score: 0.8 }, { box: [1] }]),
 }, 500, 500);
 // The block inside the bubble stays the box detector's region; the unclaimed one is adopted.
 assert.equal(found.length, 3);
 assert.equal(found.filter((row) => row.provenance?.backend === 'rtdetr').length, 2);
 const adopted = found.find((row) => row.provenance?.backend === 'sam-ts-l');
 assert.ok(adopted, 'unclaimed lettering is its own region');
 assert.ok(adopted!.score < 0.9, 'an adopted region scores below a detector box');
});
test('with no box detector SAM-TS-L supplies the regions', () => {
 const found = composeDetections({ 'sam-ts-l': parseSamTsLRegions([{ box: [200, 200, 260, 240], score: 0.8 }]) }, 500, 500);
 assert.equal(found.length, 1);
 assert.equal(found[0].provenance?.backend, 'sam-ts-l');
});
test('job status names the page, step, and model', () => {
  assert.equal(jobStepMessage(2, 8, 'Detecting text regions', 'SAM-TS-L'),
    'Page 2/8 · Detecting text regions · SAM-TS-L');
});
test('SAM-TS-L detection follows the mask engine unless overridden', () => {
  const previous = { detect: process.env.SCAN_SAM_TS_L_DETECT, mask: process.env.SCAN_MASK_ENGINE };
  try {
    delete process.env.SCAN_SAM_TS_L_DETECT;
    delete process.env.SCAN_MASK_ENGINE;
    assert.equal(samTsLDetectionMode(), 'auto');
    process.env.SCAN_MASK_ENGINE = 'ctd';
    assert.equal(samTsLDetectionMode(), 'off');
    process.env.SCAN_MASK_ENGINE = 'sam-ts-l';
    assert.equal(samTsLDetectionMode(), 'on');
    process.env.SCAN_SAM_TS_L_DETECT = '0';
    assert.equal(samTsLDetectionMode(), 'off');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const name = key === 'detect' ? 'SCAN_SAM_TS_L_DETECT' : 'SCAN_MASK_ENGINE';
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
