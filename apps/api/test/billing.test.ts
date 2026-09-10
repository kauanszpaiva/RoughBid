import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBillingEndpointHandler } from '../src/billing/endpoints.ts';
import { createBillingConfig, createBillingConfigFromEnv, createCheckoutRequest, createPortalRequest, isBillingPriceKey, verifyStripeWebhook, verifiedSubscriptionUpdate } from '../src/billing/stripe.ts';

test('billing config is live-mode aware but refuses checkout without an approved price', () => {
  const config = createBillingConfig({
    stripeMode: 'live',
    productId: 'prod_VB3s2SIgOAxwRR',
    priceId: '',
  });
  assert.equal(config.mode, 'live');
  assert.equal(config.productId, 'prod_VB3s2SIgOAxwRR');
  assert.throws(() => createCheckoutRequest(config, {
    customerEmail: 'estimator@example.com',
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
    config: createBillingConfig({ stripeMode: 'test', productId: 'prod_1', priceId: 'price_1', priceIds: { plan_pro: 'price_1' } }),
    webhookSecret: 'whsec_test',
    stripe: { async createCheckoutSession() { return { url: 'https://checkout.stripe.com/x' }; }, async createPortalSession() { return { url: 'https://billing.stripe.com/x' }; }, async retrieveSubscription() { return event.data.object; } },
    repository: {
      async customerIdForUser() { return null; },
      async beginSubscriptionSync() { return 1; },
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
    latest_invoice: { status: 'paid', amount_paid: 2900, amount_due: 2900 },
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
    invoicePaid: true, syncRevision: 1,
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
    customerEmail: 'estimator@example.com',
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancel',
  });
  assert.deepEqual(request, {
    mode: 'subscription',
    ui_mode: 'hosted',
    customer_email: 'estimator@example.com',
    line_items: [{ price: 'price_approved', quantity: 1 }],
    success_url: 'https://app.example.com/billing/success',
    cancel_url: 'https://app.example.com/billing/cancel',
  });
});

test('billing config still parses legacy RoughBid project-size IDs during migration', () => {
  const config = createBillingConfigFromEnv({
    STRIPE_MODE: 'test',
    STRIPE_PRODUCT_ID: 'prod_roughbid',
    STRIPE_PRICE_PLAN_STARTER: 'price_starter',
    STRIPE_PRICE_PROJECT_STANDARD: 'price_project_standard',
    STRIPE_PRICE_MARKETPLACE_REGIONAL_MATERIAL_PRICES: 'price_marketplace_regional',
  });
  assert.equal(config.priceIds.plan_starter, 'price_starter');
  assert.equal(config.priceIds.project_standard, 'price_project_standard');
  assert.equal(config.priceIds.marketplace_regional_material_prices, 'price_marketplace_regional');
  assert.equal(config.priceId, null);
});

test('checkout can select an approved subscription price by RoughBid price key', () => {
  const request = createCheckoutRequest(
    createBillingConfig({
      stripeMode: 'test',
      productId: 'prod_roughbid',
      priceIds: { plan_pro: 'price_pro' },
    }),
    {
      customerEmail: 'estimator@example.com',
      successUrl: 'https://app.example.com/billing/success',
      cancelUrl: 'https://app.example.com/billing/cancel',
      userId: 'user_1',
      priceKey: 'plan_pro',
    },
  );
  assert.equal(request.mode, 'subscription');
  assert.deepEqual(request.line_items, [{ price: 'price_pro', quantity: 1 }]);
  assert.deepEqual(request.subscription_data, { metadata: { user_id: 'user_1' } });
});

test('checkout request helper keeps legacy one-time project prices out of subscription metadata', () => {
  const request = createCheckoutRequest(
    createBillingConfig({
      stripeMode: 'test',
      productId: 'prod_roughbid',
      priceIds: { project_large: 'price_project_large' },
    }),
    {
      customerEmail: 'estimator@example.com',
      successUrl: 'https://app.example.com/billing/success',
      cancelUrl: 'https://app.example.com/billing/cancel',
      userId: 'user_1',
      priceKey: 'project_large',
    },
  );
  assert.equal(request.mode, 'payment');
  assert.deepEqual(request.line_items, [{ price: 'price_project_large', quantity: 1 }]);
  assert.equal(request.subscription_data, undefined);
  assert.deepEqual(request.metadata, { user_id: 'user_1', price_key: 'project_large' });
});

test('billing endpoint directs project reads to the per-project quote flow', async () => {
  let stripeCalled = false;
  const handler = createBillingEndpointHandler({
    config: createBillingConfig({ stripeMode: 'test', productId: 'prod_1', priceId: 'price_default', priceIds: { project_large: 'price_project_large' } }),
    webhookSecret: 'secret',
    stripe: {
      async createCheckoutSession() {
        stripeCalled = true;
        return { url: 'https://checkout.stripe.com/default' };
      },
      async createPortalSession() { return { url: '' }; },
    },
    repository: { async customerIdForUser() { return null; }, async processStripeEvent() { return true; } },
    async authenticate() { return { id: 'user_1', email: 'owner@example.com' }; },
  });
  const response = await handler(new Request('https://api.example.com/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      priceKey: 'project_large',
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal(stripeCalled, false);
  assert.match(String((await response.json() as { error: string }).error), /project/i);
});

test('billing endpoint rejects invalid price keys without charging a fallback product', async () => {
  let requestPrice = '';
  const handler = createBillingEndpointHandler({
    config: createBillingConfig({ stripeMode: 'test', productId: 'prod_1', priceId: 'price_default' }),
    webhookSecret: 'secret',
    stripe: {
      async createCheckoutSession(input) {
        requestPrice = input.line_items[0]?.price ?? '';
        return { url: 'https://checkout.stripe.com/default' };
      },
      async createPortalSession() { return { url: '' }; },
    },
    repository: { async customerIdForUser() { return null; }, async processStripeEvent() { return true; } },
    async authenticate() { return { id: 'user_1', email: 'owner@example.com' }; },
  });
  const response = await handler(new Request('https://api.example.com/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({
      successUrl: 'https://app.example.com/success',
      cancelUrl: 'https://app.example.com/cancel',
      priceKey: 'price_attacker_controlled',
    }),
  }));
  assert.equal(response.status, 400);
  assert.equal(requestPrice, '');
  assert.equal(isBillingPriceKey('price_attacker_controlled'), false);
});

test('checkout request helper binds Marketplace subscription to user, workspace, feed and approved price', () => {
  const config = createBillingConfig({
    stripeMode: 'test',
    productId: 'prod_roughbid',
    priceIds: { marketplace_supplier_import: 'price_marketplace_supplier_import' },
  });
  const request=createCheckoutRequest(config, {
      customerEmail: 'estimator@example.com',
      successUrl: 'https://app.example.com/billing/success',
      cancelUrl: 'https://app.example.com/billing/cancel',
      userId: 'user_1',
      workspaceId:'workspace_1',
      marketplaceFeedId:'supplier_import',
      priceKey: 'marketplace_supplier_import',
    });
  assert.equal(request.mode,'subscription');
  assert.deepEqual(request.subscription_data?.metadata,{user_id:'user_1',price_key:'marketplace_supplier_import',workspace_id:'workspace_1',marketplace_feed_id:'supplier_import'});
  assert.deepEqual(request.metadata,request.subscription_data?.metadata);
});
