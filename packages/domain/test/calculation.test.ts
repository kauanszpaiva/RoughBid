import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProject } from '../src/calculation.ts';

test('aggregates line unit costs, overhead, markup, and margin by category', () => {
  const result = calculateProject({
    lineItems: [
      { id: 'concrete', category: 'material', quantity: '3.5', unitRate: '100.125' },
      { id: 'crew', category: 'labor', quantity: 8, unitRate: '42.50' },
    ],
    overheadPercent: '10',
    markupPercent: '20',
  });
  assert.equal(result.lineItems[0]?.unitCost, 350.44);
  assert.equal(result.categoryTotals.material, 350.44);
  assert.equal(result.categoryTotals.labor, 340);
  assert.equal(result.directCost, 690.44);
  assert.equal(result.overheadAmount, 69.04);
  assert.equal(result.costWithOverhead, 759.48);
  assert.equal(result.markupAmount, 151.9);
  assert.equal(result.finalPrice, 911.38);
  assert.equal(result.grossMarginAmount, 151.9);
  assert.ok(Math.abs(result.grossMarginPercent - 16.666666) < 0.000001);
  assert.equal(result.effectiveMarkupPercent, 20);
});

test('avoids floating-point drift and rejects unsafe precision', () => {
  const result = calculateProject({
    lineItems: [
      { id: 'a', category: 'material', quantity: '0.1', unitRate: '0.2' },
      { id: 'b', category: 'material', quantity: '1', unitRate: '0.10' },
    ], overheadPercent: '0', markupPercent: '0',
  });
  assert.equal(result.directCost, 0.12);
  assert.throws(() => calculateProject({
    lineItems: [{ id: 'a', category: 'other', quantity: '0.0000001', unitRate: 1 }],
    overheadPercent: 0, markupPercent: 0,
  }), /at most 6 decimal places/);
});
