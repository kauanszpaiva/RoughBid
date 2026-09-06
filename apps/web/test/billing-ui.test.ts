import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app/src/App.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../app/src/components/Sidebar.tsx', import.meta.url), 'utf8');
const billingPage = readFileSync(new URL('../app/src/pages/BillingPage.tsx', import.meta.url), 'utf8');
const authGate = readFileSync(new URL('../app/src/components/AuthGate.tsx', import.meta.url), 'utf8');

test('app exposes a dedicated billing page for the official commercial model', () => {
  assert.match(app, /BillingPage/);
  assert.match(app, /activeTab === "billing"/);
  assert.match(sidebar, /label: "Billing"/);
  assert.match(sidebar, /CreditCard/);
});

test('customer billing page explains payment and does not expose internal pricing assumptions', () => {
  assert.match(billingPage,/createBillingCheckout/);
  assert.match(billingPage,/Pay for each project before AI starts/);
  assert.doesNotMatch(billingPage,/COGS|margin guardrail|free trial|Buy project/);
});

test('login gate does not promise free AI usage', () => {
  assert.match(authGate,/Secure workspace access/);
  assert.match(authGate,/AI plan reading is paid per project/);
  assert.doesNotMatch(authGate,/free trial|No card required|cost-limited/i);
});
