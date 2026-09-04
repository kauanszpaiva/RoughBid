import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUGHBID_COMMERCIAL_PLANS,
  ROUGHBID_MARKETPLACE_FEEDS,
  ROUGHBID_PLAN_LIMITS,
  ROUGHBID_TRIAL_CREDITS,
  TARGET_PROJECT_COGS_USD,
  TRIAL_COGS_HARD_CAP_USD,
  TRIAL_COGS_SOFT_CAP_USD,
  assertTrialCogsAllowed,
  calculateProjectUnitEconomics,
  calculateUnitEconomics,
  estimateStripeCardFee,
  marketplaceFeedEconomics,
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

test('project pricing clears 50 percent margin after estimated Stripe card fees', () => {
  for (const plan of Object.values(ROUGHBID_COMMERCIAL_PLANS)) {
    const revenue = plan.extraProjectPriceUsd ?? projectCreditUnitPrice(plan);
    const result = calculateProjectUnitEconomics(revenue);
    assert.equal(result.meetsMinimumMargin, true, `${plan.id} should clear margin after card fees`);
  }
});

test('marketplace feeds clear the margin guardrail as separate paid add-ons', () => {
  for (const feed of Object.values(ROUGHBID_MARKETPLACE_FEEDS)) {
    const result = marketplaceFeedEconomics(feed);
    assert.equal(result.meetsMinimumMargin, true, `${feed.id} should clear marketplace margin`);
  }
});

test('plan limits keep a low-friction entry tier and separated workspace capacity', () => {
  assert.equal(ROUGHBID_PLAN_LIMITS.credit_1.seats, 1);
  assert.equal(ROUGHBID_PLAN_LIMITS.starter.seats, 1);
  assert.equal(ROUGHBID_PLAN_LIMITS.pro.seats, 3);
  assert.equal(ROUGHBID_PLAN_LIMITS.team.seats, 10);
  assert.ok(ROUGHBID_PLAN_LIMITS.starter.marketplaceFeedsIncluded.includes('new_england_codes'));
  assert.ok(ROUGHBID_PLAN_LIMITS.pro.activeProjects > ROUGHBID_PLAN_LIMITS.starter.activeProjects);
});

test('Stripe fee estimator includes percent and fixed card fee', () => {
  assert.equal(estimateStripeCardFee(0), 0);
  assert.equal(estimateStripeCardFee(10), 0.59);
});
