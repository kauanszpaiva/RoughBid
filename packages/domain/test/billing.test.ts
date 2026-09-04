import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUGHBID_COMMERCIAL_PLANS,
  ROUGHBID_TRIAL_CREDITS,
  TARGET_PROJECT_COGS_USD,
  TRIAL_COGS_HARD_CAP_USD,
  TRIAL_COGS_SOFT_CAP_USD,
  assertTrialCogsAllowed,
  calculateUnitEconomics,
  projectCreditUnitPrice,
  subscriptionProjectDiscountPercent,
} from '../src/billing.ts';

test('trial budget stays below the one dollar COGS ceiling', () => {
  assert.equal(ROUGHBID_TRIAL_CREDITS, 2);
  assert.equal(TRIAL_COGS_SOFT_CAP_USD, 0.8);
  assert.equal(TRIAL_COGS_HARD_CAP_USD, 1);
  assert.doesNotThrow(() => assertTrialCogsAllowed(0.72, 0.2));
  assert.throws(() => assertTrialCogsAllowed(0.8, 0.2), /hard cap/i);
});

test('project and subscription pricing keep 50 percent plus unit margin at target COGS', () => {
  const plans = Object.values(ROUGHBID_COMMERCIAL_PLANS);
  assert.ok(plans.every((plan) => plan.includedProjectCredits > 0));

  for (const plan of plans) {
    const price = plan.extraProjectPriceUsd ?? projectCreditUnitPrice(plan);
    const result = calculateUnitEconomics({
      revenueUsd: price,
      variableCogsUsd: TARGET_PROJECT_COGS_USD,
    });
    assert.equal(result.meetsMinimumMargin, true, `${plan.id} should clear margin guardrail`);
  }
});

test('subscriptions make extra projects cheaper than one-off project credits', () => {
  assert.ok(subscriptionProjectDiscountPercent(ROUGHBID_COMMERCIAL_PLANS.starter) > 40);
  assert.ok(subscriptionProjectDiscountPercent(ROUGHBID_COMMERCIAL_PLANS.pro) > 55);
  assert.ok(subscriptionProjectDiscountPercent(ROUGHBID_COMMERCIAL_PLANS.team) > 60);
});
