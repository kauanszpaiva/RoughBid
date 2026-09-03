import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProjectFinancials } from '../app/src/utils/calculations.ts';
import { calculateProject } from '../../../packages/domain/src/calculation.ts';

const items = [
  { id: 'est-1', name: 'Drywall', quantity: 2400, unit: 'SF', materialCost: 3600, laborCost: 2880, equipmentCost: 240, directCost: 6720 },
  { id: 'est-2', name: 'Framing', quantity: 1200, unit: 'LF', materialCost: 2100, laborCost: 1880, equipmentCost: 200, directCost: 4180 },
] as const;

test('calculateProjectFinancials matches the shared domain engine used by POST /api/estimates/recalculate', () => {
  const financials = calculateProjectFinancials([...items], 12, 20);

  const expected = calculateProject({
    lineItems: [
      { id: 'est-1-material', category: 'material', quantity: 1, unitRate: '3600.00' },
      { id: 'est-1-labor', category: 'labor', quantity: 1, unitRate: '2880.00' },
      { id: 'est-1-equipment', category: 'equipment', quantity: 1, unitRate: '240.00' },
      { id: 'est-2-material', category: 'material', quantity: 1, unitRate: '2100.00' },
      { id: 'est-2-labor', category: 'labor', quantity: 1, unitRate: '1880.00' },
      { id: 'est-2-equipment', category: 'equipment', quantity: 1, unitRate: '200.00' },
    ],
    overheadPercent: 12,
    markupPercent: 20,
  });

  assert.equal(financials.directCost, expected.directCost);
  assert.equal(financials.overheadAmount, expected.overheadAmount);
  assert.equal(financials.costBeforeMarkup, expected.costWithOverhead);
  assert.equal(financials.markupAmount, expected.markupAmount);
  assert.equal(financials.finalPrice, expected.finalPrice);
  assert.equal(financials.marginPercentage, expected.grossMarginPercent);

  // Sanity-check against the product spec example in the Bruno e-mail thread.
  assert.equal(financials.directCost, 10900);
  assert.equal(financials.finalPrice, 14649.6);
});

test('calculateProjectFinancials handles a project with no estimate items yet', () => {
  const financials = calculateProjectFinancials([], 12, 20);
  assert.equal(financials.directCost, 0);
  assert.equal(financials.finalPrice, 0);
  assert.equal(financials.marginPercentage, 0);
});

test('calculateProjectFinancials clamps missing/negative percentages instead of throwing', () => {
  const financials = calculateProjectFinancials([...items], Number.NaN, -5);
  assert.equal(financials.overheadPercentage, 0);
  assert.equal(financials.markupPercentage, 0);
  assert.equal(financials.finalPrice, financials.directCost);
});
