import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../app/src/components/Sidebar.tsx', import.meta.url), 'utf8');
const billingPage = readFileSync(new URL('../app/src/pages/BillingPage.tsx', import.meta.url), 'utf8');

test('app exposes a dedicated billing page for the official commercial model', () => {
  assert.match(app, /BillingPage/);
  assert.match(app, /activeTab === "billing"/);
  assert.match(sidebar, /label: "Billing"/);
  assert.match(sidebar, /CreditCard/);
});

test('billing page is wired to shared unit economics and keeps Stripe checkout gated', () => {
  assert.match(billingPage, /ROUGHBID_COMMERCIAL_PLANS/);
  assert.match(billingPage, /ROUGHBID_PROJECT_SIZE_PRICES/);
  assert.match(billingPage, /ROUGHBID_MARKETPLACE_FEEDS/);
  assert.match(billingPage, /calculateSizedProjectUnitEconomics/);
  assert.match(billingPage, /marketplaceFeedEconomics/);
  assert.match(billingPage, /createBillingCheckout/);
  assert.match(billingPage, /Checkout is not live yet/);
  assert.match(billingPage, /Choose plan/);
  assert.match(billingPage, /Buy project/);
  assert.match(billingPage, /Add feed/);
  assert.doesNotMatch(billingPage, /Checkout now|Buy now|Subscribe now/i);
});
