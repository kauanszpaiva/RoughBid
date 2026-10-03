import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, rpc } from './provider-bridge-runtime.test.mjs';
import { buildPaidFullContract } from '../../apps/api/src/billing/full-takeoff-pricing.ts';
import { multiproviderEnv } from '../../apps/api/test/full-takeoff-multiprovider.test.ts';
import { testManifest } from '../../apps/api/test/full-takeoff-pricing.test.ts';

test('purchase overhead SQL validates the real v2 cost equation and requires immutable whole-cent terms', async () => {
  const db = await fixture();
  try {
    await db.exec(readFileSync(new URL('../migrations/20261003060000_reviewed_operation_reservations.sql', import.meta.url), 'utf8'));
    await db.exec('update provider_spend_policy set spend_cap_usd=25');
    const env = { ...multiproviderEnv(), PAID_FULL_OVERHEAD_BASE_CENTS: '300', PAID_FULL_OVERHEAD_PAGE_CENTS: '25' };
    const profile = JSON.parse(env.PAID_FULL_PROFILE_JSON);
    for (const route of Object.values(profile.routes)) route.tariff.expiresAt = '2099-01-01T00:00:00Z';
    env.PAID_FULL_PROFILE_JSON = JSON.stringify(profile);
    const contract = buildPaidFullContract({ manifest: testManifest(2), membership: 'standard', env,
      companyPolicy: { callReservationUsd: 2.5, spendCapUsd: 25 }, now: Date.parse('2026-10-03T00:00:00Z') });
    assert.equal(contract.pricing.costCents, 11576 + 300 + 50);
    assert.equal(await rpc(db, 'private.validate_full_operation_contract', [contract]), true);
    for (const field of ['overheadBaseCents', 'overheadPageCents', 'overheadBasePolicy', 'costCents']) {
      const changed = structuredClone(contract); delete changed.pricing[field];
      assert.equal(await rpc(db, 'private.validate_full_operation_contract', [changed]), false, field);
    }
    for (const mutate of [p => { p.overheadBaseCents = -1; }, p => { p.overheadPageCents = .5; },
      p => { p.overheadBasePolicy = 'file'; }, p => { p.overheadBasePolicy = 'project_lifetime'; },
      p => { p.overheadBaseCents = 301; }, p => { p.overheadPageCents = 26; },
      p => { p.costCents -= 300; }, p => { p.costCents = null; }]) {
      const changed = structuredClone(contract); mutate(changed.pricing);
      assert.equal(await rpc(db, 'private.validate_full_operation_contract', [changed]), false);
    }
  } finally { await db.close(); }
});
