import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreeProviderConfigured, requireFreeProviderConfig } from '../src/ai-plan/free-provider.ts';

const ok = {
  FREE_PROVIDER_ENABLED: 'true', GEMINI_FREE_API_KEY: 'free-project-credential',
  GEMINI_FREE_MODEL: 'gemini-2.5-flash', GEMINI_FREE_PROJECT_ID: 'roughbid-free',
  GEMINI_FREE_TIER_VERIFIED: 'true',
};

test('fully configured free route resolves its own credentials', () => {
  const cfg = requireFreeProviderConfig(ok);
  assert.equal(cfg.model, 'gemini-2.5-flash');
  assert.equal(cfg.project, 'roughbid-free');
  assert.equal(isFreeProviderConfigured(ok), true);
});

test('fails closed when any required value is missing or a placeholder', () => {
  assert.equal(isFreeProviderConfigured({}), false);
  for (const key of ['FREE_PROVIDER_ENABLED', 'GEMINI_FREE_API_KEY', 'GEMINI_FREE_MODEL', 'GEMINI_FREE_PROJECT_ID', 'GEMINI_FREE_TIER_VERIFIED']) {
    assert.equal(isFreeProviderConfigured({ ...ok, [key]: '' }), false, key);
  }
  for (const bad of ['changeme', 'your-key', '${SECRET}', 'null', '   ']) {
    assert.equal(isFreeProviderConfigured({ ...ok, GEMINI_FREE_API_KEY: bad }), false, bad);
  }
  assert.equal(isFreeProviderConfigured({ ...ok, GEMINI_FREE_MODEL: 'gpt-4o' }), false);
});

test('unverified free tier keeps the route closed even with a key present', () => {
  assert.equal(isFreeProviderConfigured({ ...ok, GEMINI_FREE_TIER_VERIFIED: 'false' }), false);
});

test('refuses to reuse the billed provider credential', () => {
  assert.throws(
    () => requireFreeProviderConfig({ ...ok, GEMINI_API_KEY: 'free-project-credential' }),
    /must not reuse the billed provider credential/,
  );
});

test('never falls back to the paid Gemini variables', () => {
  const paidOnly = { GEMINI_API_KEY: 'paid-tier1-prepay', GEMINI_MODEL: 'gemini-2.5-flash', PAID_PLAN_READINGS_ENABLED: 'true' };
  assert.equal(isFreeProviderConfigured(paidOnly), false);
});
