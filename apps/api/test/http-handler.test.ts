import test from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../src/http/handler.ts';

test('GET /api/health does not require Supabase configuration', async () => {
  const response = await handleApiRequest(new Request('https://roughbid.test/api/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'RoughBid API' });
});

test('returns 500 when SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY are missing', async () => {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_PUBLISHABLE_KEY;
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/workspaces'));
    assert.equal(response.status, 500);
  } finally {
    if (SUPABASE_URL !== undefined) process.env.SUPABASE_URL = SUPABASE_URL;
    if (SUPABASE_PUBLISHABLE_KEY !== undefined) process.env.SUPABASE_PUBLISHABLE_KEY = SUPABASE_PUBLISHABLE_KEY;
  }
});

test('routes unknown paths to 404 once Supabase env is configured', async () => {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = process.env;
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/nonexistent'));
    assert.equal(response.status, 404);
  } finally {
    if (SUPABASE_URL === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = SUPABASE_URL;
    if (SUPABASE_PUBLISHABLE_KEY === undefined) delete process.env.SUPABASE_PUBLISHABLE_KEY; else process.env.SUPABASE_PUBLISHABLE_KEY = SUPABASE_PUBLISHABLE_KEY;
  }
});
