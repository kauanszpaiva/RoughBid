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

test('AI plan reading route is mounted but disabled until Supabase service-role credentials exist', async () => {
  // GEMINI_API_KEY is deliberately NOT required here: GeminiPlanReader falls
  // back to a synthetic takeoff when it's unset (see gemini.ts) rather than
  // disabling the route. Only the service-role write path is a hard gate.
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
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

test('AI plan reading route falls through to 503 when object storage credentials are missing too', async () => {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  delete process.env.OBJECT_STORAGE_ENDPOINT;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/projects/project-1/ai-plan-readings', { method: 'POST' }));
    assert.equal(response.status, 503);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('document upload routes are mounted but disabled until storage runtime credentials exist', async () => {
  const previous = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    REDIS_URL: process.env.REDIS_URL,
    OBJECT_STORAGE_ENDPOINT: process.env.OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_BUCKET: process.env.OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY_ID: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'test-anon-key';
  process.env.REDIS_URL = 'redis://localhost:6379';
  delete process.env.OBJECT_STORAGE_ENDPOINT;
  delete process.env.OBJECT_STORAGE_BUCKET;
  delete process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  delete process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  try {
    const response = await handleApiRequest(new Request('https://roughbid.test/api/projects/project-1/documents/upload-url', { method: 'POST' }));
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'OBJECT_STORAGE_ENDPOINT is required' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
