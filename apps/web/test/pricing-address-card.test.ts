import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('pricing address card exposes clear, conflict, missing, and read-only states', () => {
  const card = read('../app/src/components/PricingAddressCard.tsx');

  assert.match(card, /Pricing address/i);
  assert.match(card, /needs_resolution/);
  assert.match(card, /Use plan address/);
  assert.match(card, /Keep project address/);
  assert.match(card, /pricing cannot start|pricing is blocked/i);
  assert.match(card, /canWrite/);
  assert.match(card, /onResolve/);
  assert.match(card, /plan_address/);
  assert.match(card, /project_address_text/);
  assert.match(card, /address_source/);
  assert.match(card, /address_status/);
});

test('Plans page loads server pricing context and refetches it after human resolution', () => {
  const plans = read('../app/src/pages/PlansPage.tsx');

  assert.match(plans, /PricingAddressCard/);
  assert.match(plans, /getPricingContext/);
  assert.match(plans, /resolvePricingAddress/);
  assert.match(plans, /const loadPricingContext/);
  assert.match(plans, /await resolvePricingAddress\(/);
  assert.match(plans, /await loadPricingContext\(/);
  assert.match(plans, /<PricingAddressCard/);
  assert.match(plans, /canWrite=\{canWrite\}/);
});
