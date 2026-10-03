import test from 'node:test';
import assert from 'node:assert/strict';
import { probeProviderInventory } from '../../../scripts/probe-provider-inventory.mjs';

test('server inventory emits only allowlisted presence, model names and numeric pricing', () => {
  const secret = 'sk_live_never_return_this_credential_12345678';
  const value = probeProviderInventory({OPENAI_API_KEY:secret, OPENAI_MODEL:secret, GEMINI_API_KEY:'[masked]',
    GEMINI_MODEL:'gemini-3.8-flash', PROJECT_PAYMENT_FEE_BPS:'290', PROJECT_COST_BASE_CENTS:secret,
    UNKNOWN_VALUE:secret, PAID_FULL_ENABLED:'true'});
  assert.equal(value.credentials.OPENAI_API_KEY,true);
  assert.equal(value.credentials.GEMINI_API_KEY,false);
  assert.equal(value.models.OPENAI_MODEL,null);
  assert.equal(value.models.GEMINI_MODEL,'gemini-3.8-flash');
  assert.equal(value.pricing.PROJECT_PAYMENT_FEE_BPS,290);
  assert.equal(value.pricing.PROJECT_COST_BASE_CENTS,null);
  assert.equal(value.providerCalls,0);
  assert.equal(value.credentialsAuthenticated,false);
  assert.ok(!JSON.stringify(value).includes(secret));
});
