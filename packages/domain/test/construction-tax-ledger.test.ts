import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConstructionQuotedTax, guardConstructionTaxCostBase, type ConstructionTaxCharge } from '../src/construction-tax-ledger.ts';
const charge = (): ConstructionTaxCharge => ({ id: 'synthetic-tax-a', sourceChargeReference: 'SYNTHETIC-DOC:LINE-TAX', sourceRef: 'synthetic-reviewed-evidence', supplierQuoteId: 'synthetic-quote',
  amount: 10, currency: 'USD', jurisdiction: 'SYNTHETIC-ARITHMETIC-ONLY', taxType: 'synthetic-cost-tax', recoverability: 'nonrecoverable', includedInQuotedAmount: false,
  treatment: 'added_once_to_direct_line', reviewed: true, allocations: [{ lineId: 'material-a', amount: 10, basis: 'source-line', sourceRef: 'synthetic-allocation-evidence' }] });
const line = { id: 'material-a', category: 'direct' as const, landedCost: 110, taxChargeIds: ['synthetic-tax-a'] };
test('100 plus 10 line tax yields 110 once and does not add the same tax again globally', () => {
  const normalized = normalizeConstructionQuotedTax({ quotedAmount: 100, taxInclusion: 'exclusive', charges: [charge()], notApplicableEvidenceRef: null });
  assert.equal(normalized.landedCost, 110);
  const result = guardConstructionTaxCostBase({ lines: [line], charges: [charge()], notApplicableEvidenceRef: null });
  assert.equal(result.directCost, 110); assert.equal(result.unallocatedNonrecoverableTaxes, 0); assert.equal(result.total, 110);
  const repeat = { ...charge(), id: 'other-uuid', treatment: 'unallocated_nonrecoverable_cost_tax' as const, allocations: [] };
  const repeated = guardConstructionTaxCostBase({ lines: [line], charges: [charge(), repeat], notApplicableEvidenceRef: null });
  assert.equal(repeated.total, null); assert.ok(repeated.pending.some(reason => reason.includes('duplicate_economic_tax_charge')));
  assert.equal(repeated.knownCostBase, 110);
});
test('inclusive gross quote decomposes from known tax to 100 plus 10, with unknown decomposition blocked', () => {
  const embedded = { ...charge(), includedInQuotedAmount: true, treatment: 'embedded_in_direct_line' as const };
  const result = normalizeConstructionQuotedTax({ quotedAmount: 110, taxInclusion: 'inclusive', charges: [embedded], notApplicableEvidenceRef: null });
  assert.equal(result.nonTaxAmount, 100); assert.equal(result.nonrecoverableTax, 10); assert.equal(result.landedCost, 110);
  assert.equal(normalizeConstructionQuotedTax({ quotedAmount: 110, taxInclusion: 'inclusive', charges: [{ ...embedded, amount: null }], notApplicableEvidenceRef: null }).landedCost, null);
  assert.equal(normalizeConstructionQuotedTax({ quotedAmount: 110, taxInclusion: 'inclusive', charges: [{ ...embedded, recoverability: 'pending' }], notApplicableEvidenceRef: null }).landedCost, null);
  assert.equal(normalizeConstructionQuotedTax({ quotedAmount: 110, taxInclusion: 'unknown', charges: [embedded], notApplicableEvidenceRef: null }).landedCost, null);
});
test('only a reviewed nonrecoverable charge with no allocation may enter unallocated extras', () => {
  const unallocated = { ...charge(), treatment: 'unallocated_nonrecoverable_cost_tax' as const, allocations: [] };
  const result = guardConstructionTaxCostBase({ lines: [{ ...line, landedCost: 100, taxChargeIds: [] }], charges: [unallocated], notApplicableEvidenceRef: null });
  assert.equal(result.total, 110); assert.equal(result.unallocatedNonrecoverableTaxes, 10);
  const invalid = guardConstructionTaxCostBase({ lines: [line], charges: [{ ...charge(), treatment: 'unallocated_nonrecoverable_cost_tax' }], notApplicableEvidenceRef: null });
  assert.equal(invalid.total, null); assert.equal(invalid.unallocatedNonrecoverableTaxes, 0);
});
test('split allocation sums equal one original source charge; missing/over allocation cannot confirm total', () => {
  const allocated = { ...charge(), allocations: [
    { lineId: 'material-a', amount: 6, basis: 'reviewed-share', sourceRef: 'split-evidence' },
    { lineId: 'material-b', amount: 4, basis: 'reviewed-share', sourceRef: 'split-evidence' }] };
  const lines = [{ ...line, landedCost: 66 }, { ...line, id: 'material-b', landedCost: 44 }];
  assert.equal(guardConstructionTaxCostBase({ lines, charges: [allocated], notApplicableEvidenceRef: null }).total, 110);
  allocated.allocations[1]!.amount = 5;
  assert.equal(guardConstructionTaxCostBase({ lines, charges: [allocated], notApplicableEvidenceRef: null }).total, null);
});
test('recoverable/output taxes stay outside cost and an empty ledger needs explicit evidence', () => {
  const recoverable = { ...charge(), includedInQuotedAmount: true, recoverability: 'recoverable' as const, treatment: 'recoverable_tax_excluded_from_cost' as const, allocations: [] };
  assert.equal(normalizeConstructionQuotedTax({ quotedAmount: 110, taxInclusion: 'inclusive', charges: [recoverable], notApplicableEvidenceRef: null }).landedCost, 100);
  assert.equal(guardConstructionTaxCostBase({ lines: [{ ...line, landedCost: 100, taxChargeIds: [] }], charges: [recoverable], notApplicableEvidenceRef: null }).total, 100);
  assert.equal(guardConstructionTaxCostBase({ lines: [{ ...line, landedCost: 100, taxChargeIds: [] }], charges: [], notApplicableEvidenceRef: null }).total, null);
  assert.equal(guardConstructionTaxCostBase({ lines: [{ ...line, landedCost: 100, taxChargeIds: [] }], charges: [], notApplicableEvidenceRef: 'reviewed-exemption-document' }).total, 100);
  assert.throws(() => normalizeConstructionQuotedTax({ quotedAmount: 100, taxInclusion: 'exclusive', charges: [{ ...charge(), amount: 10.001 }], notApplicableEvidenceRef: null }), /cents/);
});
