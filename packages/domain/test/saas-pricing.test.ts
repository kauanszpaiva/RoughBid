import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previewSaasPerDocumentPrice, previewSaasMonthlyPrice, parseSaasPercentBps,
  parseSaasUsdMicros, parseSaasUsdCents, SAAS_PROJECT_MARGIN_POLICY,
  type SaasCostLine, type SaasPerDocumentPricingInput, type SaasMonthlyPricingInput,
} from '../src/saas-pricing.ts';
import { projectChargeCents } from '../src/project-charge.ts';

const cost = (overrides: Partial<SaasCostLine> = {}): SaasCostLine => ({
  id: 'gemini-regions', label: 'Regional visual review', driver: 'regions', unit: 'region', quantity: 20,
  unitCostMicrosUsd: 25_000, basis: 'reviewed_forecast', source: 'Fixture reviewed cost policy, not provider rates',
  priceVersion: 'offline-fixture-v1', documentedAt: '2026-10-02T00:00:00.000Z', ...overrides,
});
const perDocument = (overrides: Partial<SaasPerDocumentPricingInput> = {}): SaasPerDocumentPricingInput => ({
  membership: 'standard', costs: [cost()], costCoverageComplete: true,
  fees: { fixedCents: 30, variableBps: 290, source: 'Offline payment-fee fixture, not approved commercial fees' }, ...overrides,
});
const monthly = (overrides: Partial<SaasMonthlyPricingInput> = {}): SaasMonthlyPricingInput => ({
  costs: [cost({ id: 'membership-support', label: 'Membership support', driver: 'support', unit: 'hour', quantity: 2, unitCostMicrosUsd: 1_000_000 })],
  costCoverageComplete: true, fees: { fixedCents: 30, variableBps: 290, source: 'Offline fee fixture' },
  targetGrossMarginBps: null, marginPolicySource: null, marginPolicyVersion: null,
  costAllocation: 'membership_only', ...overrides,
});

test('versioned per-reading margin table is reused without inventing monthly prices', () => {
  assert.deepEqual(SAAS_PROJECT_MARGIN_POLICY.marginsBps, { standard: 5000, starter: 4000, pro: 3500, team: 3000, enterprise: 2000 });
  assert.equal(previewSaasMonthlyPrice(monthly()).proposedChargeCents, null);
});

test('per-document charge uses the existing integer margin guardrail and auditable costs', () => {
  const result = previewSaasPerDocumentPrice(perDocument());
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.technicalCostCents, 50);
  assert.equal(result.proposedChargeCents, projectChargeCents(50, 30, 290, 'standard'));
  assert.equal(result.calculation.numerator, '800000');
  assert.equal(result.calculation.denominator, '4710');
  assert.equal(result.audit[0]?.source, 'Fixture reviewed cost policy, not provider rates');
  assert.equal(result.containsForecast, true);
  assert.equal(result.commercialActivation, 'not_enabled_by_preview');
  assert.equal(result.constructionEstimateIncluded, false);
});

test('cost complexity comes from the documented number of regions and stages, not a fabricated multiplier', () => {
  const simple = previewSaasPerDocumentPrice(perDocument());
  const complex = previewSaasPerDocumentPrice(perDocument({ costs: [cost({ quantity: 200 }), cost({ id: 'astra-reconciliation', driver: 'provider_calls', unit: 'call', quantity: 2, unitCostMicrosUsd: 400_000 })] }));
  assert.equal(simple.technicalCostCents, 50);
  assert.equal(complex.technicalCostCents, 580);
  assert.ok(complex.proposedChargeCents! > simple.proposedChargeCents!);
});

test('an unknown applicable provider cost prevents a service price even when other costs are known', () => {
  const result = previewSaasPerDocumentPrice(perDocument({ costs: [cost(), cost({ id: 'unknown-claude', unitCostMicrosUsd: null })] }));
  assert.equal(result.status, 'pending_inputs');
  assert.equal(result.knownCostMicrosUsd, 500_000);
  assert.equal(result.technicalCostCents, null);
  assert.equal(result.proposedChargeCents, null);
  assert.ok(result.issues.some(issue => issue.code === 'unit_cost_missing'));
});

test('incomplete usage coverage blocks pricing and does not report partial cost as complete', () => {
  const result = previewSaasPerDocumentPrice(perDocument({ costCoverageComplete: false }));
  assert.equal(result.knownCostMicrosUsd, 500_000);
  assert.equal(result.technicalCostCents, null);
  assert.equal(result.proposedChargeCents, null);
});

test('duplicate cost identities are blocked instead of double billing the same ledger event', () => {
  const result = previewSaasPerDocumentPrice(perDocument({ costs: [cost({ basis: 'measured' }), cost({ basis: 'measured' })] }));
  assert.equal(result.proposedChargeCents, null);
  assert.ok(result.issues.some(issue => issue.code === 'cost_identity_invalid'));
  assert.equal(result.audit.length, 1);
});

test('all costs require source, rate version, date and reviewed or measured basis', () => {
  for (const incomplete of [cost({ source: null }), cost({ priceVersion: null }), cost({ documentedAt: null }), cost({ documentedAt: '2026-02-30T00:00:00.000Z' }), cost({ basis: 'pending' })]) {
    assert.equal(previewSaasPerDocumentPrice(perDocument({ costs: [incomplete] })).proposedChargeCents, null);
  }
});

test('micro-dollar costs are aggregated before cent rounding to avoid repeated rounding', () => {
  const result = previewSaasPerDocumentPrice(perDocument({ costs: [cost({ quantity: 1, unitCostMicrosUsd: 3_000 }), cost({ id: 'second', quantity: 1, unitCostMicrosUsd: 3_000 })], fees: { fixedCents: 0, variableBps: 0, source: 'Explicit no-fee fixture' } }));
  assert.equal(result.knownCostMicrosUsd, 6_000);
  assert.equal(result.technicalCostCents, 1);
  assert.equal(result.proposedChargeCents, 2);
});

test('missing costs and an explicit zero total do not silently become free processing', () => {
  assert.equal(previewSaasPerDocumentPrice(perDocument({ costs: [] })).proposedChargeCents, null);
  const result = previewSaasPerDocumentPrice(perDocument({ costs: [cost({ quantity: 0 })] }));
  assert.equal(result.technicalCostCents, 0);
  assert.equal(result.proposedChargeCents, null);
  assert.ok(result.issues.some(issue => issue.code === 'zero_cost_policy_pending'));
});

test('each existing membership applies the correct margin after payment fees', () => {
  for (const membership of ['standard', 'starter', 'pro', 'team', 'enterprise'] as const) {
    const result = previewSaasPerDocumentPrice(perDocument({ membership }));
    assert.equal(result.proposedChargeCents, projectChargeCents(50, 30, 290, membership));
    assert.ok(result.expectedGrossProfitMicrosUsd! * 10_000 >= result.proposedChargeCents! * 10_000 * SAAS_PROJECT_MARGIN_POLICY.marginsBps[membership]);
  }
});

test('invalid payment-fee and margin denominator blocks the price rather than weakening the margin', () => {
  const result = previewSaasPerDocumentPrice(perDocument({ fees: { fixedCents: 30, variableBps: 5000, source: 'Fixture' } }));
  assert.equal(result.proposedChargeCents, null);
  assert.ok(result.issues.some(issue => issue.code === 'invalid_margin_denominator'));
  const noSource = previewSaasPerDocumentPrice(perDocument({ fees: { fixedCents: 30, variableBps: 290, source: null } }));
  assert.equal(noSource.proposedChargeCents, null);
  assert.equal(noSource.technicalCostCents, 50);
});

test('monthly costs remain separate from per-document operating costs and unlimited usage is never implied', () => {
  const result = previewSaasMonthlyPrice(monthly({ targetGrossMarginBps: 5000, marginPolicySource: 'Owner planning fixture, not an approved plan', marginPolicyVersion: 'fixture-v1', costAllocation: 'undetermined' }));
  assert.equal(result.proposedChargeCents, null);
  assert.ok(result.issues.some(issue => issue.code === 'monthly_cost_allocation_pending'));
});

test('monthly price is computed only from explicit sourced planning parameters', () => {
  const result = previewSaasMonthlyPrice(monthly({ targetGrossMarginBps: 4000, marginPolicySource: 'Owner hypothetical input', marginPolicyVersion: 'fixture-v1' }));
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.technicalCostCents, 200);
  assert.equal(result.proposedChargeCents, 403);
  assert.equal(result.commercialActivation, 'not_enabled_by_preview');
});

test('unsafe and fractional counts cannot produce a service price', () => {
  for (const quantity of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(previewSaasPerDocumentPrice(perDocument({ costs: [cost({ quantity })] })).proposedChargeCents, null);
  assert.equal(previewSaasPerDocumentPrice(perDocument({ costs: [cost({ quantity: Number.MAX_SAFE_INTEGER, unitCostMicrosUsd: 2 })] })).proposedChargeCents, null);
});

test('strict decimal inputs preserve micro-dollar rates and leave invalid or blank money unknown', () => {
  assert.equal(parseSaasUsdMicros('0.000001'), 1);
  assert.equal(parseSaasUsdMicros('12.345678'), 12_345_678);
  assert.equal(parseSaasUsdCents('12.34'), 1234);
  assert.equal(parseSaasPercentBps('2.9'), 290);
  assert.equal(parseSaasPercentBps('100'), null);
  for (const value of ['', ' ', '-1', 'NaN', '1e3', '0.0000001', '9007199254740991']) assert.equal(parseSaasUsdMicros(value), null);
  assert.equal(parseSaasUsdCents('0.001'), null);
});
