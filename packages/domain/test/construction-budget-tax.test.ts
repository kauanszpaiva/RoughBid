import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCatalogCost, CONSTRUCTION_CATALOG_SCHEMA } from '../src/construction-catalog.ts';
import { evaluateSupplierQuote, quotePriceProvenance, SUPPLIER_QUOTE_SCHEMA, type DocumentedSupplierQuote, type QuoteCharge } from '../src/supplier-quotes.ts';
import { buildConstructionBudgetTax, type PersistedConstructionQuoteTaxReview, type PersistedConstructionTaxCharge } from '../src/construction-budget-tax.ts';

const at = '2026-10-02T16:00:00Z', scope = { workspaceId: 'workspace42', projectId: 'project42' };
const excluded = (): QuoteCharge => ({ required: false, amount: null, refundable: false, sourceRef: 'doc42:excluded-line' });
const quote = (): DocumentedSupplierQuote => ({ schema: SUPPLIER_QUOTE_SCHEMA, id: 'quote42', supplier: 'other', supplierName: 'SYNTHETIC arithmetic fixture',
  location: { country: 'US', postalCode: '02110', storeId: 'store42', timeZone: 'America/New_York' }, sku: 'synthetic-material', variant: null, model: null,
  specification: 'SYNTHETIC test only; no supplier quote or local tax rule.', specificationReviewed: true, channel: 'pickup', quotedQuantity: 10, pricedUnit: 'EA',
  unitPrice: 10, currency: 'USD', origin: 'manual_quote', sourceUrl: null, documentRef: 'doc42', observedAt: at, evidenceAt: at,
  sourceUpdatedAt: null, validUntil: '2026-10-03T00:00:00Z', importedAt: at, reviewedBy: 'reviewer42', reviewedAt: at,
  availability: 'in_stock', availableQuantity: 10, availabilityAt: at, coveragePerPricedUnit: { quantity: 1, unit: 'SF' }, unitsPerPackage: null,
  minimumOrderPackages: 0, orderIncrement: 1, roundingRule: 'round_up_increment', charges: { freight: excluded(), handling: excluded(),
    tax: { required: true, amount: 10, refundable: false, sourceRef: 'doc42:tax-line' }, conditionalDiscount: excluded(), refundableDeposit: excluded() } });
const stamp = { ...scope, origin: 'persisted_workspace_review' as const, reviewedBy: 'tax-reviewer42', reviewedAt: at };
const review = (): PersistedConstructionQuoteTaxReview => ({ ...stamp, id: 'tax-review42', quoteId: 'quote42', sourceEvidenceRef: 'doc42', taxInclusion: 'exclusive', taxChargeIds: ['tax42'], notApplicableEvidenceRef: null });
const ledger = (): PersistedConstructionTaxCharge => ({ ...stamp, charge: { id: 'tax42', sourceChargeReference: 'doc42:tax-line', sourceRef: 'doc42', supplierQuoteId: 'quote42',
  amount: 10, currency: 'USD', jurisdiction: 'SYNTHETIC arithmetic jurisdiction', taxType: 'synthetic-cost-tax', recoverability: 'nonrecoverable', includedInQuotedAmount: false,
  treatment: 'added_once_to_direct_line', reviewed: true, allocations: [{ lineId: 'measure42', amount: 10, basis: 'source-line', sourceRef: 'doc42:allocation' }] } });
function input(source = quote()) {
  const evaluation = evaluateSupplierQuote({ supplier: source.supplier, location: source.location, sku: source.sku, variant: source.variant, channel: source.channel,
    quantity: 10, pricedUnit: 'EA', mode: 'documented_quote', partnerAccessVerified: false, contractEligibilityVerified: false }, source, at);
  const provenance = quotePriceProvenance(source, evaluation);
  const calculated = estimateCatalogCost({ schema: CONSTRUCTION_CATALOG_SCHEMA, revision: 'synthetic-v1', items: [{ id: 'material42', kind: 'material', name: 'SYNTHETIC material', unit: 'SF',
    specification: source.specification!, specificationSource: { name: 'Synthetic spec', url: null, documentRef: 'doc42', effectiveDate: '2026-10-02', place: 'US 02110' }, reviewed: true,
    rate: { amount: source.unitPrice, source: provenance, reviewed: true }, wastePercent: 0,
    pack: { pricedUnit: 'EA', coverageQuantity: 1, coverageUnit: 'SF', unitsPerPackage: null, minimumOrderPackages: 0, orderIncrement: 1, roundingRule: 'round_up_increment' } }] },
  [{ id: 'measure42', itemId: 'material42', quantity: 10, unit: 'SF', reviewed: true, sourceRef: 'saved-reviewed-measure42' }], { effectiveDate: '2026-10-02', place: 'US 02110' });
  return { calculated, quotes: [source], quoteBindings: [{ componentId: 'material42', quoteId: source.id, evaluation }], location: source.location, at, scope, taxReviews: [] as PersistedConstructionQuoteTaxReview[], taxLedger: [] as PersistedConstructionTaxCharge[] };
}
test('current server mapping emits named fiscal blockers and actual saved quote/derived quantity traces without empty-ledger zero', () => {
  const actual = input(), result = buildConstructionBudgetTax(actual);
  assert.equal(actual.calculated.knownSubtotal, 100); assert.equal(result.knownSubtotalUsd, 100); assert.equal(result.totalUsd, null);
  assert.equal(result.reviewedScopeCostBaseUsd, null); assert.equal(result.unallocatedNonrecoverableTaxesUsd, null);
  assert.ok(result.pendingNodes.some(node => node.code === 'quote_tax_inclusion_review_pending' && node.quoteId === 'quote42'));
  assert.ok(result.pendingNodes.some(node => node.code === 'tax_ledger_review_not_persisted'));
  assert.deepEqual(result.traces[0]?.derivedPurchasingQuantity, 10); assert.equal(result.traces[0]?.quoteEvidenceRef, 'doc42');
  assert.equal(result.traces[0]?.calculatedCostUsd, 100); assert.equal(result.traces[0]?.landedCostUsd, null);
});
test('persisted source-linked exclusive tax yields reviewed scope 100+10=110 once, while construction total stays partial', () => {
  const actual = input(); actual.taxReviews = [review()]; actual.taxLedger = [ledger()];
  const result = buildConstructionBudgetTax(actual);
  assert.equal(result.fiscalStatus, 'reviewed'); assert.equal(result.reviewedScopeCostBaseUsd, 110); assert.equal(result.totalUsd, null);
  assert.equal(result.traces[0]?.normalizedNonTaxUsd, 100); assert.equal(result.traces[0]?.nonrecoverableTaxUsd, 10);
  assert.equal(result.traces[0]?.landedCostUsd, 110); assert.equal(result.fiscalCostBase?.unallocatedNonrecoverableTaxes, 0);
});
test('inclusive gross quote decomposes from trusted reviewed tax; absence/unknown amount blocks landed cost', () => {
  const source = quote(); source.unitPrice = 11;
  const actual = input(source), taxReview = review(), tax = ledger(); taxReview.taxInclusion = 'inclusive';
  tax.charge.includedInQuotedAmount = true; tax.charge.treatment = 'embedded_in_direct_line'; actual.taxReviews = [taxReview]; actual.taxLedger = [tax];
  const result = buildConstructionBudgetTax(actual);
  assert.equal(actual.calculated.knownSubtotal, 110); assert.equal(result.reviewedScopeCostBaseUsd, 110);
  assert.equal(result.traces[0]?.normalizedNonTaxUsd, 100); assert.equal(result.traces[0]?.landedCostUsd, 110);
  tax.charge.amount = null;
  const unknown = buildConstructionBudgetTax(actual); assert.equal(unknown.reviewedScopeCostBaseUsd, null); assert.equal(unknown.traces[0]?.landedCostUsd, null);
});
test('new UUID cannot repeat same economic tax as unallocated extra', () => {
  const actual = input(); actual.taxReviews = [review()]; const duplicate = ledger(); duplicate.charge = { ...duplicate.charge, id: 'different-uuid', treatment: 'unallocated_nonrecoverable_cost_tax', allocations: [] };
  actual.taxLedger = [ledger(), duplicate]; const result = buildConstructionBudgetTax(actual);
  assert.equal(result.reviewedScopeCostBaseUsd, null); assert.equal(result.fiscalCostBase?.knownCostBase, 110);
  assert.ok(result.pendingNodes.some(node => node.code === 'duplicate_economic_tax_charge'));
});
test('only a distinct persisted unallocated nonrecoverable charge may extend the scope cost base', () => {
  const actual = input(); actual.taxReviews = [review()];
  const extra = ledger(); extra.charge = { ...extra.charge, id: 'separate-tax43', sourceChargeReference: 'doc43:unallocated-tax', sourceRef: 'doc43',
    supplierQuoteId: null, amount: 7, treatment: 'unallocated_nonrecoverable_cost_tax', allocations: [] };
  actual.taxLedger = [ledger(), extra];
  const result = buildConstructionBudgetTax(actual);
  assert.equal(result.reviewedScopeCostBaseUsd, 117); assert.equal(result.unallocatedNonrecoverableTaxesUsd, 7); assert.equal(result.totalUsd, null);
  extra.charge.allocations = [{ lineId: 'measure42', amount: 7, basis: 'already-in-line', sourceRef: 'doc43:allocation' }];
  assert.equal(buildConstructionBudgetTax(actual).reviewedScopeCostBaseUsd, null);
});
test('persisted review source or future timestamps cannot attest a different supplier document', () => {
  const actual = input(); actual.taxReviews = [{ ...review(), sourceEvidenceRef: 'unrelated-document' }]; actual.taxLedger = [ledger()];
  const mismatch = buildConstructionBudgetTax(actual);
  assert.equal(mismatch.reviewedScopeCostBaseUsd, null); assert.equal(mismatch.traces[0]?.landedCostUsd, null);
  assert.ok(mismatch.pendingNodes.some(node => node.code === 'tax_review_document_differs_from_saved_quote'));
  actual.taxReviews = [{ ...review(), reviewedAt: '2026-10-03T16:00:00Z' }];
  assert.ok(buildConstructionBudgetTax(actual).pendingNodes.some(node => node.code === 'persisted_tax_review_scope_or_author_invalid'));
});
test('tax exclusions need exact source evidence; review identities/scope and source quote amount cannot be forged', () => {
  const source = quote(); source.charges.tax = { required: false, amount: null, refundable: false, sourceRef: 'doc42:tax-not-applicable' };
  const actual = input(source), excludedReview = review(); excludedReview.taxInclusion = 'not_applicable'; excludedReview.taxChargeIds = []; excludedReview.notApplicableEvidenceRef = 'doc42:tax-not-applicable'; actual.taxReviews = [excludedReview];
  assert.equal(buildConstructionBudgetTax(actual).reviewedScopeCostBaseUsd, 100);
  excludedReview.notApplicableEvidenceRef = 'invented-reference'; assert.equal(buildConstructionBudgetTax(actual).reviewedScopeCostBaseUsd, null);
  actual.taxReviews = [{ ...review(), workspaceId: 'other-workspace' }]; assert.ok(buildConstructionBudgetTax(actual).pendingNodes.some(node => node.code === 'persisted_tax_review_scope_or_author_invalid'));
  const mismatched = input(); mismatched.taxReviews = [review()]; const wrong = ledger(); wrong.charge.amount = 20; wrong.charge.allocations[0]!.amount = 20; mismatched.taxLedger = [wrong];
  assert.ok(buildConstructionBudgetTax(mismatched).pendingNodes.some(node => node.code === 'tax_ledger_amount_differs_from_documented_quote'));
});
test('helper checks saved quote against independently derived quantity/cost and never trusts ready browser totals', () => {
  const actual = input(); actual.taxReviews = [review()]; actual.taxLedger = [ledger()];
  actual.calculated.lines[0]!.quantity = 11;
  const result = buildConstructionBudgetTax(actual);
  assert.equal(result.reviewedScopeCostBaseUsd, null); assert.ok(result.pendingNodes.some(node => node.code === 'quote_date_location_quantity_or_cost_pending'));
  assert.ok(result.pendingNodes.some(node => node.code === 'calculated_material_cost_differs_from_saved_quote'));
});
