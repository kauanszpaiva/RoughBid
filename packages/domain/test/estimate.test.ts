import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEstimate } from '../src/index.ts';

test('calculateEstimate calculates deterministic estimate totals', () => {
  const result = calculateEstimate({
    materialCost: 1000,
    laborCost: 500,
    equipmentCost: 100,
    otherCost: 50,
    overheadPercent: 10,
    markupPercent: 20,
  });

  assert.equal(result.directCost, 1650);
  assert.equal(result.overheadAmount, 165);
  assert.equal(result.costWithOverhead, 1815);
  assert.equal(result.markupAmount, 363);
  assert.equal(result.finalPrice, 2178);
  assert.ok(Math.abs(result.grossMarginPercent - 16.666667) < 0.0001);
});
