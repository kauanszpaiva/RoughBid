import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPricingAddressResolved,
  comparePricingAddresses,
  normalizeAddressText,
} from '../src/pricing/context.ts';
import type { PlanProjectAddressEvidence } from '../src/ai-plan/types.ts';

const plan = (overrides: Partial<PlanProjectAddressEvidence> = {}): PlanProjectAddressEvidence => ({
  project_name: 'Smith Renovation',
  street_address: '12 Main St',
  city: 'Needham',
  state: 'MA',
  postal_code: '02492',
  building_lot_unit: null,
  page_number: 1,
  source_excerpt: 'PROJECT ADDRESS: 12 MAIN ST NEEDHAM MA 02492',
  confidence: 0.98,
  ...overrides,
});

test('normalizes only deterministic address syntax and common street suffixes', () => {
  assert.equal(
    normalizeAddressText(' 12 Main Street, Needham, MA 02492 '),
    normalizeAddressText('12 MAIN ST Needham MA 02492'),
  );
  assert.equal(normalizeAddressText('4 Oak Road.'), '4 OAK RD');
});

test('plan-only and project-only addresses are clear with an explicit source', () => {
  const fromPlan = comparePricingAddresses(plan(), null);
  assert.equal(fromPlan.status, 'clear');
  assert.equal(fromPlan.source, 'plan');
  assert.ok(fromPlan.pricingAddress);

  const fromProject = comparePricingAddresses(null, '12 Main St, Needham, MA 02492');
  assert.equal(fromProject.status, 'clear');
  assert.equal(fromProject.source, 'project');
  assert.ok(fromProject.pricingAddress);
});

test('equivalent plan and project addresses normalize to a clear decision', () => {
  const decision = comparePricingAddresses(plan(), '12 MAIN STREET, Needham MA 02492');
  assert.equal(decision.status, 'clear');
  assert.equal(decision.source, 'project');
});

test('different street numbers or ZIP codes require human resolution', () => {
  for (const projectAddress of [
    '52 Main St, Needham, MA 02492',
    '12 Main St, Needham, MA 02108',
  ]) {
    const decision = comparePricingAddresses(plan(), projectAddress);
    assert.equal(decision.status, 'needs_resolution');
    assert.equal(decision.source, null);
    assert.equal(decision.pricingAddress, null);
  }
});

test('missing both address sources is explicitly missing', () => {
  const decision = comparePricingAddresses(null, '   ');
  assert.equal(decision.status, 'missing');
  assert.equal(decision.source, null);
  assert.equal(decision.pricingAddress, null);
});

test('pricing gate rejects missing/unresolved context and permits only a usable clear/resolved address', () => {
  assert.throws(
    () => assertPricingAddressResolved({ address_status: 'needs_resolution', pricing_address: null }),
    /resolve|conflict/i,
  );
  assert.throws(
    () => assertPricingAddressResolved({ address_status: 'missing', pricing_address: null }),
    /address/i,
  );
  assert.throws(
    () => assertPricingAddressResolved({ address_status: 'clear', pricing_address: null }),
    /address/i,
  );
  assert.doesNotThrow(() => assertPricingAddressResolved({ address_status: 'clear', pricing_address: { formatted: '12 Main St' } }));
  assert.doesNotThrow(() => assertPricingAddressResolved({ address_status: 'resolved', pricing_address: { formatted: '12 Main St' } }));
});
