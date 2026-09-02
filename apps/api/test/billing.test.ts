import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBillingEndpointHandler } from '../src/billing/endpoints.ts';
import { createBillingConfig, createCheckoutRequest, createPortalRequest, verifyStripeWebhook } from '../src/billing/stripe.ts';

test('billing config is live-mode aware but refuses checkout without an approved price', () => {
  const config = createBillingConfig({
    stripeMode: 'live',
    productId: 'prod_VB3s2SIgOAxwRR',
    priceId: '',
  });
  assert.equal(config.mode, 'live');
  assert.equal(config.productId, 'prod_VB3s2SIgOAxwRR');
  assert.throws(() => createCheckoutRequest(config, {
    customerEmail: 'student@example.com',
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancel',
  }), /approved Stripe price/i);
});

test('portal request requires a Stripe customer and HTTPS return URL', () => {
  assert.deepEqual(createPortalRequest({ customerId: 'cus_123', returnUrl: 'https://app.example.com/settings' }), {
    customer: 'cus_123', return_url: 'https://app.example.com/settings',
  });
  assert.throws(() => createPortalRequest({ customerId: '', returnUrl: 'https://app.example.com' }), /customer/i);
});

test('webhook verifier rejects modified payloads and expired signatures', () => {
  const body = '{"id":"evt_1"}';
  const timestamp = 2_000_000_000;
  const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${body}`).digest('hex');
  verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, 'whsec_test', timestamp * 1000);
  assert.throws(() => verifyStripeWebhook(`${body} `, `t=${timestamp},v1=${signature}`, 'whsec_test', timestamp * 1000), /invalid/i);
  assert.throws(() => verifyStripeWebhook(body, `t=${timestamp},v1=${signature}`, 'whsec_test', (timestamp + 301) * 1000), /too old/i);
});

test('signed subscription webhooks are idempotently persisted with authoritative state', async () => {
  const calls: Array<{ event: unknown; update: any }> = [];
  const seen = new Set<string>();
  const handler = createBillingEndpointHandler({
    config: createBillingConfig({ stripeMode: 'test', productId: 'prod_1', priceId: 'price_1' }),
    webhookSecret: 'whsec_test',
    stripe: { async createCheckoutSession() { return { url: 'https://checkout.stripe.com/x' }; }, async createPortalSession() { return { url: 'https://billing.stripe.com/x' }; } },
    repository: {
      async customerIdForUser() { return null; },
      async processStripeEvent(event, update) {
        if (seen.has(event.id)) return false;
        seen.add(event.id); calls.push({ event, update }); return true;
      },
    },
    async authenticate() { throw new Error('webhooks must not use browser authentication'); },
  });
  const event = { id: 'evt_1', type: 'customer.subscription.updated', livemode: false, data: { object: {
    id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 2_000_000_000,
    metadata: { user_id: '8a188bea-08f4-4b25-97d2-f1b6f9fc20dc' }, items: { data: [{ price: { id: 'price_1' } }] },
  } } };
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${raw}`).digest('hex');
  const invoke = () => handler(new Request('https://api.example.com/api/webhooks/stripe', { method: 'POST', body: raw, headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` } }));
  assert.deepEqual(await (await invoke()).json(), { received: true, duplicate: false });
  assert.deepEqual(await (await invoke()).json(), { received: true, duplicate: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.update, {
    userId: '8a188bea-08f4-4b25-97d2-f1b6f9fc20dc', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1',
    stripePriceId: 'price_1', subscriptionStatus: 'active', currentPeriodEnd: new Date(2_000_000_000 * 1000).toISOString(),
  });
});

test('checkout endpoint is server-authenticated and disabled without STRIPE_PRICE_ID', async () => {
  let stripeCalled = false;
  const handler = createBillingEndpointHandler({
    config: createBillingConfig({ stripeMode: 'live', productId: 'prod_1', priceId: '' }), webhookSecret: 'secret',
    stripe: { async createCheckoutSession() { stripeCalled = true; return { url: '' }; }, async createPortalSession() { return { url: '' }; } },
    repository: { async customerIdForUser() { return null; }, async processStripeEvent() { return true; } },
    async authenticate() { return { id: 'user_1', email: 'owner@example.com' }; },
  });
  const response = await handler(new Request('https://api.example.com/api/billing/checkout', { method: 'POST', body: '{}' }));
  assert.equal(response.status, 503);
  assert.equal(stripeCalled, false);
});

test('checkout request uses hosted subscription checkout only after price approval', () => {
  const config = createBillingConfig({
    stripeMode: 'live',
    productId: 'prod_VB3s2SIgOAxwRR',
    priceId: 'price_approved',
  });
  const request = createCheckoutRequest(config, {
    customerEmail: 'student@example.com',
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancel',
  });
  assert.deepEqual(request, {
    mode: 'subscription',
    ui_mode: 'hosted',
    customer_email: 'student@example.com',
    line_items: [{ price: 'price_approved', quantity: 1 }],
    success_url: 'https://app.example.com/billing/success',
    cancel_url: 'https://app.example.com/billing/cancel',
  });
});
