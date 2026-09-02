import test from 'node:test';
import assert from 'node:assert/strict';
import { createEstimateCalculationHandler } from '../src/estimates/routes.ts';

const body = {
  lineItems: [{ id: 'labor', category: 'labor', quantity: 10, unitRate: 25 }],
  overheadPercent: 10,
  markupPercent: 20,
};

test('recalculates an estimate for an authenticated request', async () => {
  const handler = createEstimateCalculationHandler({ authenticate: async () => ({ id: 'user' }) });
  const response = await handler(new Request('https://roughbid.test/api/estimates/recalculate', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }));
  assert.equal(response.status, 200);
  const result = await response.json() as Record<string, unknown>;
  assert.equal(result.directCost, 250);
  assert.equal(result.overheadAmount, 25);
  assert.equal(result.markupAmount, 55);
  assert.equal(result.finalPrice, 330);
  assert.equal(result.grossMarginPercent, 16.666666);
});

test('protects the route and reports invalid calculation input', async () => {
  const denied = createEstimateCalculationHandler({ authenticate: async () => null });
  assert.equal((await denied(new Request('https://roughbid.test/api/estimates/recalculate', { method: 'POST' }))).status, 401);
  const handler = createEstimateCalculationHandler({ authenticate: async () => ({ id: 'user' }) });
  const response = await handler(new Request('https://roughbid.test/api/estimates/recalculate', {
    method: 'POST', body: JSON.stringify({ ...body, markupPercent: -1 }),
  }));
  assert.equal(response.status, 400);
});
