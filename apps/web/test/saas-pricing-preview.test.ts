import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSaasPricingDraft, createSaasPricingDraft, createSaasCostDraft, exportSaasPricingPreview } from '../app/src/services/saasPricing.ts';

function populatedDraft() {
  const draft = createSaasPricingDraft('per_document');
  draft.costs = [{ ...createSaasCostDraft('fixture-cost'), label: 'Mock regional analysis', driver: 'regions', unit: 'region', quantity: '8', unitCostUsd: '0.0125', basis: 'reviewed_forecast', source: 'Local fixture, not a provider rate', priceVersion: 'fixture-v1', documentedDate: '2026-10-02' }];
  draft.coverageConfirmed = true;
  draft.fixedPaymentUsd = '0.30';
  draft.paymentPercent = '2.90';
  draft.paymentSource = 'Offline payment-fee fixture';
  return draft;
}

test('owner pricing form starts with unknown fees and costs instead of default charges', () => {
  for (const mode of ['per_document', 'monthly_membership'] as const) {
    const draft = createSaasPricingDraft(mode);
    const result = calculateSaasPricingDraft(draft);
    assert.equal(draft.fixedPaymentUsd, '');
    assert.equal(draft.monthlyMarginPercent, '');
    assert.equal(result.proposedChargeCents, null);
    assert.equal(result.status, 'pending_inputs');
  }
});

test('form data connects quantity, precision, source and fee inputs into an auditable proposal', () => {
  const result = calculateSaasPricingDraft(populatedDraft());
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.knownCostMicrosUsd, 100_000);
  assert.equal(result.technicalCostCents, 10);
  assert.equal(result.proposedChargeCents, 85);
  assert.equal(result.audit[0]?.documentedAt, '2026-10-02T00:00:00.000Z');
});

test('clearing a previously entered provider rate blocks the proposed charge instead of coercing blank to zero', () => {
  const draft = populatedDraft();
  draft.costs[0]!.unitCostUsd = '';
  const result = calculateSaasPricingDraft(draft);
  assert.equal(result.proposedChargeCents, null);
  assert.equal(result.technicalCostCents, null);
});

test('a reviewed source cannot make decimal or invalid region counts valid', () => {
  for (const value of ['1.5', '-1', '1e2', '']) {
    const draft = populatedDraft();
    draft.costs[0]!.quantity = value;
    assert.equal(calculateSaasPricingDraft(draft).proposedChargeCents, null);
  }
});

test('monthly form has independent costs, allocation and explicit margin parameters', () => {
  const documentDraft = populatedDraft();
  const monthlyDraft = createSaasPricingDraft('monthly_membership');
  assert.equal(calculateSaasPricingDraft(monthlyDraft).proposedChargeCents, null);
  assert.equal(calculateSaasPricingDraft(documentDraft).proposedChargeCents, 85);
  monthlyDraft.costs = documentDraft.costs.map(row => ({ ...row, driver: 'support', label: 'Hypothetical membership support only' }));
  monthlyDraft.coverageConfirmed = true;
  monthlyDraft.fixedPaymentUsd = documentDraft.fixedPaymentUsd;
  monthlyDraft.paymentPercent = documentDraft.paymentPercent;
  monthlyDraft.paymentSource = documentDraft.paymentSource;
  monthlyDraft.monthlyMarginPercent = '40';
  monthlyDraft.monthlyMarginSource = 'Hypothetical owner planning input';
  monthlyDraft.monthlyMarginVersion = 'fixture-v1';
  assert.equal(calculateSaasPricingDraft(monthlyDraft).proposedChargeCents, null);
  monthlyDraft.membershipAllocationConfirmed = true;
  assert.equal(calculateSaasPricingDraft(monthlyDraft).status, 'ready_for_review');
});

test('export record is JSON with local inputs and blockers, never a commercial activation', () => {
  const draft = populatedDraft();
  const record = JSON.parse(exportSaasPricingPreview(draft, calculateSaasPricingDraft(draft)));
  assert.equal(record.schema, 'roughbid-saas-pricing-preview-v1');
  assert.equal(record.commercialActivation, 'not_enabled_by_preview');
  assert.equal(record.result.constructionEstimateIncluded, false);
  assert.equal(record.result.audit[0].source, draft.costs[0]!.source);
});
