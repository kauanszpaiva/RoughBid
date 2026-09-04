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

test('billing routes are mounted but disabled until server billing credentials exist', async () => {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRODUCT_ID: process.env.STRIPE_PRODUCT_ID,
    STRIPE_PRICE_ID: process.env.STRIPE_PRICE_ID,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_PRODUCT_ID = 'prod_123';
  delete process.env.STRIPE_PRICE_ID;
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/billing/checkout', { method: 'POST' }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Billing is not configured.' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('AI plan reading route is mounted but disabled until AI runtime credentials exist', async () => {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    REDIS_URL: process.env.REDIS_URL,
    S3_BUCKET: process.env.S3_BUCKET,
    S3_REGION: process.env.S3_REGION,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  delete process.env.OPENAI_API_KEY;
  delete process.env.REDIS_URL;
  delete process.env.S3_BUCKET;
  delete process.env.S3_REGION;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/projects/project-1/ai-plan-readings', { method: 'POST' }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'AI plan reading is not configured.' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
