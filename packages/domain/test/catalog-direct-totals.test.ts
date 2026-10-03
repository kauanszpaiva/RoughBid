import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEstimateV2, type EstimateLineV2Input } from '../src/takeoff-v2.ts';
const base = { id: 'allocated', description: 'Reviewed cost allocation', rawQuantity: 2, unit: 'SF' as const, wastePercent: 0,
  priceSource: { sourceType: 'project_quote' as const, sourceName: 'Reviewed construction quote', effectiveDate: '2026-10-02', geography: 'US 02110', vendor: null, sku: null, expiresAt: null, confidence: 1 } };
const calculate = (line: EstimateLineV2Input) => calculateEstimateV2({ lineItems: [line], generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 } });
test('precalculated cents preserve material/labor categories and no labor hours are synthesized', () => {
  const result = calculate({ ...base, materialDirectTotal: 1.01, laborTotal: 2.02 });
  assert.equal(result.directCost, 3.03); assert.equal(result.lineItems[0]!.laborHours, 0); assert.equal(result.lineItems[0]!.materialTotal, 1.01);
  assert.equal(calculate({ ...base, materialDirectTotal: 0, laborTotal: 0 }).lineItems[0]!.pricingStatus, 'priced');
});
test('direct totals require nonnegative exact cents and exclude duplicate rate/freight/tax/production inputs', () => {
  for (const line of [{ ...base, materialDirectTotal: 1.005 }, { ...base, laborTotal: -1 }, { ...base, materialDirectTotal: 10, materialUnitRate: 0 },
    { ...base, materialDirectTotal: 10, materialTaxable: false }, { ...base, laborTotal: 10, laborProductionRate: 1 }]) assert.throws(() => calculate(line));
  const { priceSource, ...unpriced } = base;
  const missing = calculate({ ...unpriced, laborTotal: 10 }); assert.ok(missing.blockers.some(reason => reason.includes('provenance')));
});
