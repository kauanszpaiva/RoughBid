import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiProviderPlanReader } from '../src/ai-plan/multi-provider.ts';
import { syntheticPlanReadingResult } from '../src/ai-plan/fallback.ts';

const baseInput = {
  fileBytes: new Uint8Array([1]),
  mimeType: 'application/pdf',
  sheetName: 'Sheet A-101',
  requestedTrades: ['Framing'],
  scope: null,
};

const realResult = { summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected' as const, human_review_required: true as const, limitations: [] }, findings: [{page_number:1,finding_type:'risk' as const,label:'Unreadable dimension',value_text:null,quantity:null,unit:null,confidence:0.5,geometry:{},source_excerpt:null}] };

test('never calls the second (paid) reader when the first (free) reader returns a real result', async () => {
  let secondCalled = false;
  const reader = new MultiProviderPlanReader([
    { name: 'free', read: async () => realResult },
    { name: 'paid', read: async () => { secondCalled = true; return realResult; } },
  ]);
  const result = await reader.read(baseInput);
  assert.equal(secondCalled, false);
  assert.deepEqual(result, realResult);
});

test('falls through to the next reader only when the previous one comes back synthetic', async () => {
  const order: string[] = [];
  const reader = new MultiProviderPlanReader([
    { name: 'free', read: async () => { order.push('free'); return syntheticPlanReadingResult(['Framing'], 'free provider unconfigured'); } },
    { name: 'paid', read: async () => { order.push('paid'); return realResult; } },
  ]);
  const result = await reader.read(baseInput);
  assert.deepEqual(order, ['free', 'paid']);
  assert.deepEqual(result, realResult);
});

test('fails when every provider returns synthetic results', async () => {
  const reader=new MultiProviderPlanReader([{name:'a',read:async()=>syntheticPlanReadingResult(['Framing'],'failure')}]);
  await assert.rejects(reader.read(baseInput),/No quantities were generated/);
});
test('fails when providers return no findings or throw', async () => {
  const reader=new MultiProviderPlanReader([{name:'a',read:async()=>({...realResult,findings:[]})},{name:'b',read:async()=>{throw new Error('outage')}}]);
  await assert.rejects(reader.read(baseInput),/No quantities were generated/);
});
