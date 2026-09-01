import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingConfig, createCheckoutRequest } from '../src/billing/stripe.ts';

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
