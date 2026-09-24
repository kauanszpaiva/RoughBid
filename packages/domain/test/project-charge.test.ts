import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_CHARGE_MULTIPLIER_BPS,
  PROJECT_COST_UPLIFT_BPS,
  projectChargeCents,
  projectChargeMultiplierBps,
  projectCostPlusChargeCents,
} from '../src/project-charge.ts';

const TIERS = ['standard', 'starter', 'pro', 'team', 'enterprise'] as const;

test('a project charge is the measured cost, plus 30 percent, then the membership factor', () => {
  assert.equal(PROJECT_COST_UPLIFT_BPS, 13_000);
  // No membership pays full cost-plus; each plan tier carries a lower factor.
  assert.deepEqual(PROJECT_CHARGE_MULTIPLIER_BPS, {
    standard: 20_000, starter: 18_500, pro: 17_000, team: 16_000, enterprise: 16_000,
  });
  assert.equal(projectChargeMultiplierBps('standard'), 20_000);
  assert.equal(projectChargeMultiplierBps('starter'), 18_500);

  assert.equal(projectCostPlusChargeCents(1000), 2600);
  assert.equal(projectCostPlusChargeCents(1000, 'standard'), 2600);
  assert.equal(projectCostPlusChargeCents(1000, 'starter'), 2405);
  assert.equal(projectCostPlusChargeCents(1000, 'pro'), 2210);
  assert.equal(projectCostPlusChargeCents(1000, 'team'), 2080);

  // The ladder descends from the no-membership price, priciest plan cheapest per project.
  const ladder = TIERS.map(tier => projectCostPlusChargeCents(1000, tier));
  assert.ok(ladder[0]! > ladder[1]!);
  assert.ok(ladder[1]! > ladder[2]!);
  assert.ok(ladder[2]! > ladder[3]!);

  // Cents always round up, so the factor never rounds in the customer's favor.
  assert.equal(projectCostPlusChargeCents(102, 'standard'), 266); // 265.2
  assert.equal(projectCostPlusChargeCents(102, 'starter'), 246); // 245.31
  assert.equal(projectCostPlusChargeCents(102, 'pro'), 226); // 225.42
  assert.equal(projectCostPlusChargeCents(102, 'team'), 213); // 212.16

  assert.throws(() => projectCostPlusChargeCents(0));
  assert.throws(() => projectCostPlusChargeCents(-5));
  assert.throws(() => projectCostPlusChargeCents(1.5));
  assert.throws(() => projectCostPlusChargeCents(Number.MAX_SAFE_INTEGER));
  assert.throws(() => projectChargeMultiplierBps('unknown' as never));
});

test('every membership factor stays above that membership minimum-margin floor', () => {
  for (const membership of TIERS) {
    for (const cost of [100, 1000, 25_000]) {
      const floor = projectChargeCents(cost, 0, 0, membership);
      assert.ok(
        projectCostPlusChargeCents(cost, membership) >= floor,
        `${membership} at ${cost} cents must not undercut the ${floor} cent floor`,
      );
    }
  }
});
