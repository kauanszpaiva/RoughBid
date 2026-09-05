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

const realResult = { summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected' as const, human_review_required: true as const, limitations: [] }, findings: [] };

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

test('returns the last reader\'s synthetic result when every configured reader falls back', async () => {
  const reader = new MultiProviderPlanReader([
    { name: 'free', read: async () => syntheticPlanReadingResult(['Framing'], 'free notice') },
    { name: 'paid', read: async () => syntheticPlanReadingResult(['Framing'], 'paid notice') },
  ]);
  const result = await reader.read(baseInput);
  assert.equal(result.summary.synthetic, true);
  assert.ok(result.summary.limitations.some((l) => l.includes('paid notice')));
});
