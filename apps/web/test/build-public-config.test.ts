import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicBuildConfig } from '../../../scripts/build-public-config.mjs';

test('production builds fail before emitting a masked or missing Supabase URL', () => {
  for (const url of [undefined, '[SENSITIVE]', 'not-a-url', 'javascript:alert(1)']) {
    assert.throws(() => assertPublicBuildConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_build_fixture' }));
  }
});
test('frontend build rejects server credentials and masked public keys', () => {
  for (const key of ['[SENSITIVE]', 'sb_secret_private_key_fixture', '']) {
    assert.throws(() => assertPublicBuildConfig({ VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key }));
  }
  assert.doesNotThrow(() => assertPublicBuildConfig({ VITE_SUPABASE_URL: 'https://project.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_local_build_fixture' }));
});
