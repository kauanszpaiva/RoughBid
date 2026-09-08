import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicBuildConfig, resolvePublicBuildConfig } from '../../../scripts/build-public-config.mjs';

test('production builds fail before emitting a masked or missing Supabase URL', () => {
  for (const url of [undefined, '[SENSITIVE]', 'not-a-url', 'javascript:alert(1)']) {
    assert.throws(() => assertPublicBuildConfig({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_build_fixture' }));
  }
});

test('frontend build rejects server credentials and masked public keys outside preview', () => {
  for (const key of ['[SENSITIVE]', 'sb_secret_private_key_fixture', '']) {
    assert.throws(() => assertPublicBuildConfig({ VERCEL_ENV: 'production', VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key }));
  }
  assert.doesNotThrow(() => assertPublicBuildConfig({ VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_build_fixture' }));
});

test('Vercel preview replaces only masked or missing public config with the RoughBid public fallback', () => {
  const resolved = resolvePublicBuildConfig({
    VERCEL_ENV: 'preview',
    VITE_SUPABASE_URL: '[SENSITIVE]',
    VITE_SUPABASE_PUBLISHABLE_KEY: '[SENSITIVE]',
  });
  assert.equal(resolved.url, 'https://piasgpciojstjalaqazu.supabase.co');
  assert.match(resolved.publishableKey, /^sb_publishable_/);
});

test('Vercel preview preserves explicitly configured valid public values', () => {
  const configured = {
    VERCEL_ENV: 'preview',
    VITE_SUPABASE_URL: 'https://example-project.supabase.co',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_123456789012345678901234567890',
  };
  assert.deepEqual(resolvePublicBuildConfig(configured), {
    url: configured.VITE_SUPABASE_URL,
    publishableKey: configured.VITE_SUPABASE_PUBLISHABLE_KEY,
  });
});

test('preview never converts arbitrary invalid values or server credentials into a public fallback', () => {
  assert.throws(() => resolvePublicBuildConfig({
    VERCEL_ENV: 'preview',
    VITE_SUPABASE_URL: 'not-a-project-url',
    VITE_SUPABASE_PUBLISHABLE_KEY: '[SENSITIVE]',
  }));
  assert.throws(() => resolvePublicBuildConfig({
    VERCEL_ENV: 'preview',
    VITE_SUPABASE_URL: '[SENSITIVE]',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not_for_the_browser',
  }));
});
