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

const fullEnv = {
  ...env, PAID_PLAN_READINGS_ENABLED: 'false', TAKEOFF_V2_ENABLED: 'true',
  TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true', TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED: 'true',
  TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: 'gemini', TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: 'gemini-3.8-flash',
};

test('enabled Full Gemini probes its selected model by GET while legacy reading is disabled', async () => {
  let calls = 0;
  const result = await probeAiRuntime(fullEnv, async (url, init) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
    assert.equal(init.body, undefined);
    return Response.json({ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] });
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: 'available', model: 'gemini-3.8-flash', httpStatus: 200, code: 'OK' });
  assert.ok(!JSON.stringify(result).includes(env.GEMINI_API_KEY));
});

test('Full metadata probe requires every enable flag and an explicit Gemini provider', async () => {
  let calls = 0;
  for (const change of [
    { TAKEOFF_V2_ENABLED: 'false' }, { TAKEOFF_V2_STAGE_PROVIDER_ENABLED: undefined },
    { TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED: 'false' },
    { TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: undefined },
    { TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: 'openai' },
  ]) {
    const result = await probeAiRuntime({ ...fullEnv, ...change }, async () => { calls++; throw new Error('Unexpected metadata request'); });
    assert.deepEqual(result, { status: 'disabled' });
  }
  assert.equal(calls, 0);
});

test('Full metadata probe rejects masked keys and invalid explicit models without legacy fallback', async () => {
  let calls = 0;
  for (const change of [
    { GEMINI_API_KEY: '[SENSITIVE]' }, { TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: '' },
    { TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: 'https://untrusted.example/model' },
  ]) {
    const result = await probeAiRuntime({ ...fullEnv, ...change }, async () => { calls++; throw new Error('Unexpected metadata request'); });
    assert.deepEqual(result, { status: 'unconfigured', code: 'PROVIDER_CONFIGURATION' });
  }
  assert.equal(calls, 0);
});

test('Full metadata probe uses the shared Gemini model only when the stage override is absent', async () => {
  const result = await probeAiRuntime({ ...fullEnv, TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: undefined }, async (url) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash');
    return Response.json({ supportedGenerationMethods: ['generateContent'] });
  });
  assert.equal(result.model, env.GEMINI_MODEL);
});

test('missing model and timeout are distinguished without inventing readiness', async () => {
  const missing = await probeAiRuntime(env, async () => Response.json({ error: { code: 404, message: 'PRIVATE' } }, { status: 404 }));
  assert.equal(missing.code, 'MODEL_UNAVAILABLE');
  const timeout = await probeAiRuntime(env, async () => { throw Object.assign(new Error('PRIVATE'), { name: 'TimeoutError' }); });
  assert.equal(timeout.code, 'PROVIDER_TIMEOUT');
});
