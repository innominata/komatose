import assert from 'node:assert/strict';
import test from 'node:test';
import { currentMaskDiagnostics } from '../src/lib/maskDiagnostics';
import type { PageData } from '../src/lib/workflow';
test('diagnostics expire with mask, artwork, or region revision', () => {
  const page: PageData = {mask:'mask1', prepared:'source1', maskDiagnostics:{
    mask:'mask1',source:'source1',regions:'revision1',version:'v1',entries:[],
  }};
  assert.ok(currentMaskDiagnostics(page,'revision1'));
  assert.equal(currentMaskDiagnostics(page,'revision2'),undefined);
  assert.equal(currentMaskDiagnostics({...page,mask:'mask2'},'revision1'),undefined);
  assert.equal(currentMaskDiagnostics({...page,cleanBase:'source2'},'revision1'),undefined);
});
