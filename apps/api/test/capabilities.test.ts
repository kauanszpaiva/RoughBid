import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeCapabilities } from '../src/http/capabilities.ts';
import { handleApiRequest } from '../src/http/handler.ts';

const closed = { aiReadingAvailable: false, billing: false, membershipStarter: false, membershipPro: false, membershipTeam: false, billingPortal: false, marketplaceSupplierImport:false };
const configured = {
  PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'unit-provider-credential', GEMINI_MODEL: 'gemini-2.5-flash',
  OPENROUTER_API_KEY: 'unit-free-provider-credential',
  SUPABASE_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'unit-public-credential', SUPABASE_SERVICE_ROLE_KEY: 'unit-service-credential',
  BLOB_READ_WRITE_TOKEN: 'unit-blob-credential', STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_unitcredential',
  STRIPE_WEBHOOK_SECRET: 'whsec_unitcredential', APP_URL: 'https://roughbid.test',
  PROJECT_COST_BASE_CENTS: '100', PROJECT_COST_PAGE_CENTS: '10', PROJECT_COST_TRADE_CENTS: '20',
  PROJECT_PAYMENT_FIXED_CENTS: '30', PROJECT_PAYMENT_FEE_BPS: '290', PROJECT_PRICING_VERSION: 'test-only',
};

test('capabilities are closed by default and expose only booleans', () => {
  assert.deepEqual(runtimeCapabilities({}), { ...closed });
  const flags = runtimeCapabilities(configured);
  assert.deepEqual(flags, { ...closed, aiReadingAvailable: true, billing: true, billingPortal: true });
  assert.ok(Object.values(flags).every(value => typeof value === 'boolean'));
  assert.deepEqual(runtimeCapabilities({ ...configured, PAID_PLAN_READINGS_ENABLED: 'false' }), { ...closed, billingPortal: true });
  assert.deepEqual(runtimeCapabilities({ ...configured, GEMINI_API_KEY: '' }), { ...closed, billingPortal: true });
  assert.deepEqual(runtimeCapabilities({ ...configured, GEMINI_API_KEY: '', OPENROUTER_API_KEY: '' }), { ...closed, billingPortal: true });
  assert.deepEqual(runtimeCapabilities({ ...configured, BLOB_READ_WRITE_TOKEN: '' }), { ...closed, billingPortal: true });
});

test('billing stays disabled for missing reconciliation, wrong mode or unmeasured pricing', () => {
  for (const overrides of [{ STRIPE_WEBHOOK_SECRET: '' }, { STRIPE_MODE: 'live' }, { PROJECT_COST_BASE_CENTS: '' }]) {
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).billing, false);
  }
});

test('masked secrets, placeholder models and unmeasured policies cannot advertise paid availability', () => {
  for (const overrides of [
    { GEMINI_API_KEY: '', OPENROUTER_API_KEY: '', PAID_PLAN_READINGS_ENABLED: 'false' },
    { SUPABASE_SERVICE_ROLE_KEY: '[sensitive]' }, { BLOB_READ_WRITE_TOKEN: '[sensitive]' },
    { SUPABASE_PUBLISHABLE_KEY: undefined },
  ]) {
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).aiReadingAvailable, false);
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).billing, false);
  }
  for (const overrides of [
    { GEMINI_API_KEY: '[sensitive]' }, { GEMINI_API_KEY: 'redacted' },
    { GEMINI_MODEL: 'your-model' }, { GEMINI_MODEL: 'gemini-placeholder' },
  ]) {
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).aiReadingAvailable, false);
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).billing, false);
  }
  for (const overrides of [
    { STRIPE_SECRET_KEY: '[sensitive]' }, { STRIPE_WEBHOOK_SECRET: '[sensitive]' },
    { PROJECT_COST_PAGE_CENTS: '[sensitive]' }, { PROJECT_PRICING_VERSION: 'default' },
    { PROJECT_PRICING_VERSION: '[sensitive]' },
  ]) {
    assert.equal(runtimeCapabilities({ ...configured, ...overrides }).billing, false);
  }
});

test('public capabilities endpoint needs no login and exposes no environment values', async () => {
  const response = await handleApiRequest(new Request('https://roughbid.test/api/capabilities'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const flags = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(flags).sort(), Object.keys(closed).sort());
  assert.ok(Object.values(flags).every(value => typeof value === 'boolean'));
  const mutation = await handleApiRequest(new Request('https://roughbid.test/api/capabilities', { method: 'POST' }));
  assert.equal(mutation.status, 405);
});

test('monthly memberships require separate opt-in and a configured price for each tier', () => {
  const flags = runtimeCapabilities({ ...configured, BILLING_MEMBERSHIPS_ENABLED: 'true', STRIPE_PRICE_PLAN_PRO: 'price_Pro123', STRIPE_PRICE_PLAN_TEAM: '[sensitive]' });
  assert.equal(flags.billing,true);
  assert.equal(flags.membershipPro,true); assert.equal(flags.membershipStarter,false); assert.equal(flags.membershipTeam,false);
  assert.equal(runtimeCapabilities({ ...configured, STRIPE_PRICE_PLAN_PRO:'price_Pro123' }).membershipPro,false);
  const withoutAi=runtimeCapabilities({ ...configured, PAID_PLAN_READINGS_ENABLED:'false', BILLING_MEMBERSHIPS_ENABLED:'true', STRIPE_PRICE_PLAN_PRO:'price_Pro123' });
  assert.equal(withoutAi.billing,false);assert.equal(withoutAi.membershipPro,true);assert.equal(withoutAi.billingPortal,true);
});

test('Marketplace requires a separate flag and exact approved price configuration',()=>{
  assert.equal(runtimeCapabilities({...configured,STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT:'price_Supplier123'}).marketplaceSupplierImport,false);
  assert.equal(runtimeCapabilities({...configured,BILLING_MARKETPLACE_ENABLED:'true',STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT:'price_Supplier123'}).marketplaceSupplierImport,true);
  assert.equal(runtimeCapabilities({...configured,BILLING_MARKETPLACE_ENABLED:'true',STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT:'[sensitive]'}).marketplaceSupplierImport,false);
});
