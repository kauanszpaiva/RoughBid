import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidenceBudget, canonicalizeSiEvidence, type EvidenceBudgetInput } from '../src/takeoff-v2/evidence-budget.ts';

function fixture(): EvidenceBudgetInput {
  const source = { sourceType: 'project_quote' as const, sourceName: 'Approved quote #Q1', effectiveDate: '2026-09-01', geography: 'MA', vendor: 'Fixture vendor', sku: 'SKU-1', expiresAt: '2026-12-01', confidence: 1 };
  return { asOf: '2026-10-02', physicalPageCount: 1, coverage: [{ physicalPageNumber: 1, reviewed: true, revision: 'rev-a' }], unresolvedConflicts: [],
    measurements: [{ id: 'wall-1', physicalPageNumber: 1, sourceRef: 'geometry-1', revision: 'rev-a', quantity: 100, unit: 'SF', reviewed: true, scaleVerified: true }],
    assemblies: [{ id: 'finish-1', description: 'Approved wall finish composition', unit: 'SF', reviewed: true, wastePercent: 10,
      material: { amount: 2, source }, labor: { amount: 30, source, unitsPerHour: 20, productivityModifier: 1 } }],
    selections: [{ measurementId: 'wall-1', assemblyId: 'finish-1' }],
    policies: { generalConditions: 0, overheadPercent: 10, contingencies: [], profit: { method: 'markup', percent: 10 } } };
}

test('reviewed evidence and sourced composition calculate material and labor separately', () => {
  const result = buildEvidenceBudget(fixture());
  assert.equal(result.releaseStatus, 'review_ready');
  assert.equal(result.humanReviewRequired, true);
  assert.equal(result.estimate?.categoryTotals.material, 220);
  assert.equal(result.estimate?.categoryTotals.labor, 150);
  assert.equal(result.estimate?.finalBid, 447.7);
  assert.equal(result.provenance[0]?.revision, 'rev-a');
});

test('missing rate returns null estimate, never a zero-dollar quote', () => {
  const input = fixture(); input.assemblies[0]!.material!.amount = null;
  const result = buildEvidenceBudget(input);
  assert.equal(result.estimate, null); assert.equal(result.releaseStatus, 'blocked');
  assert.ok(result.blockers.includes('missing_expired_or_unapproved_price_source'));
});

test('null quantity differs from a measured zero', () => {
  const input = fixture(); input.measurements[0]!.quantity = null;
  assert.equal(buildEvidenceBudget(input).releaseStatus, 'blocked');
  input.measurements[0]!.quantity = 0;
  assert.equal(buildEvidenceBudget(input).estimate?.finalBid, 0);
});

test('unreviewed scale, stale revision, missing page and unresolved conflicts block the budget', () => {
  for (const mutate of [
    (input: EvidenceBudgetInput) => { input.measurements[0]!.scaleVerified = false; },
    (input: EvidenceBudgetInput) => { input.measurements[0]!.revision = 'rev-old'; },
    (input: EvidenceBudgetInput) => { input.physicalPageCount = 2; },
    (input: EvidenceBudgetInput) => { input.unresolvedConflicts = ['dimension mismatch']; },
  ]) { const input = fixture(); mutate(input); assert.equal(buildEvidenceBudget(input).estimate, null); }
});

test('expired price, provisional assumption and unit mismatch do not authorize pricing', () => {
  const expired = fixture(); expired.assemblies[0]!.material!.source!.expiresAt = '2026-09-30';
  assert.equal(buildEvidenceBudget(expired).estimate, null);
  const provisional = fixture(); provisional.assemblies[0]!.material!.source!.sourceType = 'provisional_assumption';
  assert.equal(buildEvidenceBudget(provisional).estimate, null);
  const mismatch = fixture(); mismatch.assemblies[0]!.unit = 'LF';
  assert.equal(buildEvidenceBudget(mismatch).estimate, null);
});

test('duplicate mapping cannot double count and unassigned scope cannot disappear', () => {
  const input = fixture(); input.selections = [...input.selections, ...input.selections];
  assert.ok(buildEvidenceBudget(input).blockers.includes('measurement_selected_more_than_once'));
  const unmapped = fixture(); unmapped.selections = [];
  assert.ok(buildEvidenceBudget(unmapped).blockers.includes('unmapped_measurement'));
});

test('SI conversion uses one recorded unit conversion, preserves null/zero and never accepts drawing scale', () => {
  assert.equal(canonicalizeSiEvidence(1, 'm').quantity, 3.28084);
  assert.equal(canonicalizeSiEvidence(10, 'm2').quantity, 107.639104);
  assert.equal(canonicalizeSiEvidence(null, 'm2').quantity, null);
  assert.equal(canonicalizeSiEvidence(0, 'm2').quantity, 0);
  assert.equal(canonicalizeSiEvidence(2, 'count').unit, 'EA');
  assert.throws(() => canonicalizeSiEvidence(1.5, 'count'));
  assert.throws(() => canonicalizeSiEvidence(-1, 'm'));
  assert.equal(canonicalizeSiEvidence(10, 'm2').formula.sourceValue, 10);
});
