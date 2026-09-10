import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEstimateV2, isCanonicalUnit, UNIT_REGISTRY } from '../src/takeoff-v2.ts';

const quote = {
  sourceType: 'project_quote' as const, sourceName: 'Supplier quote 42', effectiveDate: '2026-09-01',
  geography: 'Boston, MA', vendor: 'Example Supply', sku: 'GWB-58X', expiresAt: '2026-10-01', confidence: 1,
};

test('unit registry has explicit dimensions and validated conversions', () => {
  assert.equal(isCanonicalUnit('SQ'), true);
  assert.equal(isCanonicalUnit('square feet'), false);
  assert.deepEqual(UNIT_REGISTRY.CY, { dimension: 'volume', baseUnit: 'CF', factor: '27' });
  assert.deepEqual(UNIT_REGISTRY.PAIR, { dimension: 'count', baseUnit: 'EA', factor: '2' });
});

test('calculates waste before package rounding and prices every direct-cost layer deterministically', () => {
  const result = calculateEstimateV2({
    lineItems: [{
      id: 'drywall', description: '5/8 Type X board', unit: 'SHEET', rawQuantity: '10', wastePercent: '10',
      packageSize: '4', roundingRule: 'round_up_package', materialUnitRate: '12.50', materialFreight: '10',
      materialTaxable: true, materialTaxPercent: '6.25', laborProductionRate: '2', laborHourlyCost: '50',
      laborProductivityModifier: '1.2', equipmentTotal: '25', subcontractTotal: '30', otherDirectTotal: '5', priceSource: quote,
    }],
    generalConditions: '100', overheadPercent: '10', contingencies: [{ id: 'design', label: 'Design contingency', percent: '5' }],
    profit: { method: 'markup', percent: '20' },
  });
  const line = result.lineItems[0]!;
  assert.equal(line.wasteQuantity, 1);
  assert.equal(line.purchasingQuantity, 12);
  assert.equal(line.materialSubtotal, 150);
  assert.equal(line.materialTax, 10);
  assert.equal(line.materialTotal, 170);
  assert.equal(line.laborHours, 6);
  assert.equal(line.laborTotal, 300);
  assert.equal(line.directTotal, 530);
  assert.equal(result.overheadAmount, 63);
  assert.equal(result.contingencyTotal, 34.65);
  assert.equal(result.costBeforeProfit, 727.65);
  assert.equal(result.profitAmount, 145.53);
  assert.equal(result.finalBid, 873.18);
  assert.equal(result.effectiveMarkupPercent, 20);
  assert.ok(Math.abs(result.grossMarginPercent - 16.666666) < 0.000001);
  assert.deepEqual(result.blockers, []);
});

test('gross margin is not treated as markup and missing price provenance blocks release', () => {
  const result = calculateEstimateV2({
    lineItems: [{ id: 'unpriced', description: 'Unresolved scope', unit: 'EA', rawQuantity: 1, wastePercent: 0 }],
    generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'gross_margin', percent: 20 },
  });
  assert.equal(result.finalBid, 0);
  assert.equal(result.effectiveMarkupPercent, 0);
  assert.match(result.blockers[0]!, /no price source/);

  const priced = calculateEstimateV2({
    lineItems: [{ id: 'a', description: 'Quoted work', unit: 'EA', rawQuantity: 1, wastePercent: 0, subcontractTotal: 80, priceSource: quote }],
    generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'gross_margin', percent: 20 },
  });
  assert.equal(priced.finalBid, 100);
  assert.equal(priced.profitAmount, 20);
  assert.equal(priced.grossMarginPercent, 20);
  assert.equal(priced.effectiveMarkupPercent, 25);
});

test('rejects invalid percentages, precision and duplicate IDs', () => {
  assert.throws(() => calculateEstimateV2({
    lineItems: [{ id: 'a', description: 'A', unit: 'EA', rawQuantity: '1.0000001', wastePercent: 0 }],
    generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 },
  }), /at most 6 decimal places/);
  assert.throws(() => calculateEstimateV2({
    lineItems: [{ id: 'a', description: 'A', unit: 'EA', rawQuantity: 1, wastePercent: 101 }],
    generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 },
  }), /must not exceed 100/);
});
