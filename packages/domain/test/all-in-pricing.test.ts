import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAllInProcessingPrice } from '../src/billing.ts';

test('calculateAllInProcessingPrice matches exact acceptance prices for $10 illustrative cost', () => {
  const noSub = calculateAllInProcessingPrice(10, null);
  assert.equal(noSub.bufferedCostUsd, 13.00);
  assert.equal(noSub.markupPercent, 50);
  assert.equal(noSub.finalPriceUsd, 19.50);
  assert.equal(noSub.finalPriceCents, 1950);

  const starter = calculateAllInProcessingPrice(10, 'starter');
  assert.equal(starter.bufferedCostUsd, 13.00);
  assert.equal(starter.markupPercent, 40);
  assert.equal(starter.finalPriceUsd, 18.20);
  assert.equal(starter.finalPriceCents, 1820);

  const pro = calculateAllInProcessingPrice(10, 'pro');
  assert.equal(pro.bufferedCostUsd, 13.00);
  assert.equal(pro.markupPercent, 33);
  assert.equal(pro.finalPriceUsd, 17.29);
  assert.equal(pro.finalPriceCents, 1729);

  const team = calculateAllInProcessingPrice(10, 'team');
  assert.equal(team.bufferedCostUsd, 13.00);
  assert.equal(team.markupPercent, 25);
  assert.equal(team.finalPriceUsd, 16.25);
  assert.equal(team.finalPriceCents, 1625);
});
