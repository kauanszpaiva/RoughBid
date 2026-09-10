import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizePriceSelection, rankPriceCandidates } from '../src/pricing/matcher-v2.ts';

const request = { description: 'Type X drywall', unit: 'SHEET' as const, geography: 'Boston, MA', specification: '09 29 00 / 5/8 Type X', asOfDate: '2026-09-10' };

test('price matching is unit-aware and honors source precedence before text similarity', () => {
  const ranked = rankPriceCandidates(request, [
    { id: 'wrong-unit', description: 'Drywall', unit: 'SF', sourceType: 'project_quote', effectiveDate: '2026-09-01', expiresAt: null, geography: 'Boston, MA', specification: request.specification },
    { id: 'benchmark', description: 'Drywall sheet', unit: 'SHEET', sourceType: 'regional_benchmark', effectiveDate: '2026-09-09', expiresAt: null, geography: 'Boston, MA', specification: request.specification },
    { id: 'quote', description: 'GWB', unit: 'SHEET', sourceType: 'project_quote', effectiveDate: '2026-08-01', expiresAt: '2026-10-01', geography: 'Boston, MA', specification: request.specification },
  ]);
  assert.deepEqual(ranked.map(item => item.id), ['quote', 'benchmark']);
  assert.ok(ranked[0]?.reasons.includes('exact unit SHEET'));
});

test('authorization rejects unit mismatches, expired sources and geography-free benchmarks', () => {
  assert.throws(() => authorizePriceSelection(request, { id: 'a', description: 'Drywall', unit: 'EA', sourceType: 'project_quote', effectiveDate: '2026-09-01', expiresAt: null, geography: null, specification: null }), /incompatible/);
  assert.throws(() => authorizePriceSelection(request, { id: 'b', description: 'Drywall', unit: 'SHEET', sourceType: 'project_quote', effectiveDate: '2026-01-01', expiresAt: '2026-02-01', geography: null, specification: null }), /expired/);
  assert.throws(() => authorizePriceSelection(request, { id: 'c', description: 'Drywall', unit: 'SHEET', sourceType: 'regional_benchmark', effectiveDate: '2026-09-01', expiresAt: null, geography: null, specification: null }), /geography/);
});
