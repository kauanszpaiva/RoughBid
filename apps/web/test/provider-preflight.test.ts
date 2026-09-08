import test from 'node:test';
import assert from 'node:assert/strict';
import { probeAiRuntime } from '../../../scripts/probe-ai-runtime.mjs';

const env = { PAID_PLAN_READINGS_ENABLED: 'true', GEMINI_API_KEY: 'test-credential-never-log', GEMINI_MODEL: 'gemini-2.5-flash' };

test('read-only preflight checks the configured model without generation or leaking the credential', async () => {
  const result = await probeAiRuntime(env, async (url, init) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    assert.equal(init.body, undefined);
    return Response.json({ supportedGenerationMethods: ['generateContent'] });
  });
  assert.deepEqual(result, { status: 'available', model: env.GEMINI_MODEL, httpStatus: 200, code: 'OK' });
  assert.ok(!JSON.stringify(result).includes(env.GEMINI_API_KEY));
});

test('preflight reports an invalid key without returning the raw provider body', async () => {
  const result = await probeAiRuntime(env, async () => Response.json({ error: {
    code: 400, message: 'test-credential-never-log and PRIVATE PLAN', details: [{ reason: 'API_KEY_INVALID' }],
  } }, { status: 400 }));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'API_KEY_INVALID');
  assert.ok(!JSON.stringify(result).includes('PRIVATE PLAN'));
  assert.ok(!JSON.stringify(result).includes(env.GEMINI_API_KEY));
});

test('preflight never sends placeholder credentials or contacts arbitrary model URLs', async () => {
  for (const change of [{ GEMINI_API_KEY: 'masked-by-policy' }, { GEMINI_API_KEY: '' }, { GEMINI_MODEL: 'https://untrusted.example/model' }]) {
    const result = await probeAiRuntime({ ...env, ...change }, async () => { throw new Error('Unexpected provider request'); });
    assert.equal(result.status, 'unconfigured');
  }
});

test('disabled paid reading stays disabled without a network call', async () => {
  const result = await probeAiRuntime({ ...env, PAID_PLAN_READINGS_ENABLED: 'false' }, async () => { throw new Error('Unexpected provider request'); });
  assert.equal(result.status, 'disabled');
});

test('missing model and timeout are distinguished without inventing readiness', async () => {
  const missing = await probeAiRuntime(env, async () => Response.json({ error: { code: 404, message: 'PRIVATE' } }, { status: 404 }));
  assert.equal(missing.code, 'MODEL_UNAVAILABLE');
  const timeout = await probeAiRuntime(env, async () => { throw Object.assign(new Error('PRIVATE'), { name: 'TimeoutError' }); });
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT');
});
