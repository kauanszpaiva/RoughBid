import test from 'node:test';
import assert from 'node:assert/strict';
import { probeStripeRuntime } from '../../../scripts/probe-stripe-runtime.mjs';

const env = { STRIPE_SECRET_KEY: 'rk_live_fixture', STRIPE_MODE: 'live', STRIPE_EXPECTED_ACCOUNT_ID: 'acct_expected', STRIPE_WEBHOOK_SECRET: 'whsec_fixture' };
test('Stripe runtime probe uses only bounded reads and returns no credential or customer data', async () => {
  const seen: string[] = [];
  const result = await probeStripeRuntime(env, async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); seen.push(url);
    return Response.json(url.endsWith('/account') ? {id:'acct_expected', charges_enabled:true, email:'private@example.com'}
      : {object:'list', data:[{customer_email:'private@example.com'}]});
  });
  assert.equal(result.status, 'verified_read_only'); assert.equal(result.accountMatches, true);
  assert.equal(result.checkoutWriteVerified, false); assert.equal(result.signedWebhookVerified, false);
  assert.equal(seen.length, 2); assert.ok(seen.every(url => url.startsWith('https://api.stripe.com/v1/')));
  assert.ok(!JSON.stringify(result).includes('fixture')); assert.ok(!JSON.stringify(result).includes('private'));
});
test('Stripe runtime probe distinguishes test key, wrong account and rejected credentials', async () => {
  const ok = async () => Response.json({id:'acct_other',object:'list'});
  assert.equal((await probeStripeRuntime(env, ok)).status, 'account_not_verified');
  const denied = await probeStripeRuntime(env, async () => Response.json({error:{message:'secret'}},{status:401}));
  assert.equal(denied.status,'credential_rejected'); assert.ok(!JSON.stringify(denied).includes('secret'));
  const testKey = await probeStripeRuntime({...env, STRIPE_SECRET_KEY:'sk_test_fixture'}, async (url:string) => Response.json(url.endsWith('/account')?{id:'acct_expected'}:{object:'list',data:[]}));
  assert.equal(testKey.status,'mode_mismatch'); assert.equal(testKey.credentialMode,'test');
});
test('Stripe runtime probe does not call Stripe for a masked credential', async () => {
  const result = await probeStripeRuntime({...env,STRIPE_SECRET_KEY:'[SENSITIVE]'}, async()=>{throw Error('must not call');});
  assert.equal(result.status,'credential_missing_or_invalid_format');
});
