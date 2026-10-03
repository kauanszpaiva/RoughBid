import test from 'node:test';
import assert from 'node:assert/strict';
import { requireStageDeepPassConfig, STAGE_MODEL_REGISTRY } from '../src/takeoff-v2/stage-config.ts';

const gates = {
  TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true',
  TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true', TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1',
};
const attestation = { accountVerified: true, compatibilityVerified: true, priceVersion: 'official-review-2026-10-02', maximumCallCostUsd: 25 };
function config(provider = 'openai', model = 'gpt-6-astra'): Record<string, string> {
  return { ...gates, TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED: 'true', TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: provider,
    TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: model, OPENAI_API_KEY: 'unit-openai-credential', ANTHROPIC_API_KEY: 'unit-claude-credential',
    GEMINI_API_KEY: 'unit-gemini-credential', KIMI_API_KEY: 'unit-kimi-credential', DEEPSEEK_API_KEY: 'unit-deepseek-credential',
    KIMI_PRIVATE_PLAN_DATA_APPROVED: 'true', DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
    TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ [model]: attestation }) };
}
test('stage factory configuration requires explicit worker/schema gates and credentials', () => {
  for (const key of Object.keys(gates)) assert.throws(() => requireStageDeepPassConfig({ ...config(), [key]: '' }), /configuration/i);
  assert.throws(() => requireStageDeepPassConfig({ ...config(), OPENAI_API_KEY: '' }), /credential/);
  assert.throws(() => requireStageDeepPassConfig({ ...config(), OPENAI_API_KEY: '<placeholder>' }), /credential/);
  assert.throws(() => requireStageDeepPassConfig(gates), /at least one/);
});
test('bridge worker may omit keys only under explicit transport, and reviewed request policy remains part of configuration',()=>{
  const optional={...config(),OPENAI_API_KEY:'[SENSITIVE]',TAKEOFF_V2_TRANSPORT:'bridge',PROVIDER_BRIDGE_ENABLED:'true'};
  assert.equal(requireStageDeepPassConfig(optional).stages.classification?.apiKey,undefined);
  assert.throws(()=>requireStageDeepPassConfig({...optional,PROVIDER_BRIDGE_ENABLED:'false'}));
  assert.throws(()=>requireStageDeepPassConfig(optional,'required'));
  assert.equal(requireStageDeepPassConfig({...optional,TAKEOFF_V2_OPENAI_REQUEST_POLICY:'explicit-cache-default-v1'}).stages.classification?.requestPolicy,'explicit-cache-default-v1');
  assert.throws(()=>requireStageDeepPassConfig({...config(),TAKEOFF_V2_OPENAI_REQUEST_POLICY:'automatic'}));
});
test('only documented exact IDs can be used with their corresponding provider', () => {
  for (const [model, capability] of Object.entries(STAGE_MODEL_REGISTRY)) {
    const selected = requireStageDeepPassConfig(config(capability.provider, model)).stages.classification;
    assert.equal(selected?.model, model); assert.equal(selected?.provider, capability.provider);
  }
  for (const model of ['gpt-6', 'claude-opus-5.5', 'gemini-3.8-flash-preview', 'unknown-model']) {
    assert.throws(() => requireStageDeepPassConfig(config('openai', model)), /unsupported/);
  }
  assert.throws(() => requireStageDeepPassConfig(config('gemini', 'gpt-6-astra')), /unsupported/);
});
test('an account/model name never replaces exact-model compatibility and price attestations', () => {
  for (const field of ['accountVerified', 'compatibilityVerified', 'priceVersion', 'maximumCallCostUsd']) {
    const incomplete: Record<string, unknown> = { ...attestation }; delete incomplete[field];
    assert.throws(() => requireStageDeepPassConfig({ ...config(), TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ 'gpt-6-astra': incomplete }) }), /verified|verification/);
  }
  for (const json of ['{', '[]', '{}', JSON.stringify({ 'claude-opus-5-5': attestation })]) {
    assert.throws(() => requireStageDeepPassConfig({ ...config(), TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: json }));
  }
});
test('per-stage model overrides inherit only an explicitly configured shared model', () => {
  const env = config(); delete env.TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL;
  assert.throws(() => requireStageDeepPassConfig(env), /unsupported/);
  env.OPENAI_MODEL = 'gpt-6-astra';
  assert.equal(requireStageDeepPassConfig(env).stages.classification?.model, 'gpt-6-astra');
  env.TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL = '';
  assert.throws(() => requireStageDeepPassConfig(env), /unsupported/);
});
test('disabled stages stay absent; deterministic stages reject paid delegation; timeout is bounded', () => {
  assert.equal(requireStageDeepPassConfig(config()).stages.risk_review, undefined);
  for (const pass of ['GEOMETRY', 'ARITHMETIC_QA', 'PRICING_ASSEMBLIES']) {
    assert.throws(() => requireStageDeepPassConfig({ ...config(), [`TAKEOFF_V2_STAGE_${pass}_ENABLED`]: 'true' }), /deterministic/);
  }
  for (const timeout of ['0', '999', '600001', 'NaN', '1.5']) {
    assert.throws(() => requireStageDeepPassConfig({ ...config(), TAKEOFF_V2_PROVIDER_TIMEOUT_MS: timeout }), /timeout/);
  }
  assert.equal(requireStageDeepPassConfig(config()).requestTimeoutMs, 120_000);
});
test('maximum documented quality is explicit; unsupported effort and output limits never downgrade a model', () => {
  for (const [provider, model, maximum] of [['openai', 'gpt-6-astra', 'max'], ['claude', 'claude-opus-5-5', 'max'], ['claude', 'claude-fable-5-1', 'max'], ['gemini', 'gemini-3.8-flash', 'high']]) {
    const stage = requireStageDeepPassConfig(config(provider, model)).stages.classification;
    assert.equal(stage?.reasoningEffort, maximum); assert.equal(stage?.model, model);
  }
  assert.throws(() => requireStageDeepPassConfig({ ...config('gemini', 'gemini-3.8-flash'), TAKEOFF_V2_GEMINI_REASONING_EFFORT: 'max' }), /reasoning effort/);
  assert.throws(() => requireStageDeepPassConfig({ ...config('gemini', 'gemini-3.1-pro-preview'), TAKEOFF_V2_GEMINI_REASONING_EFFORT: 'medium' }), /reasoning effort/);
  assert.throws(() => requireStageDeepPassConfig({ ...config(), TAKEOFF_V2_STAGE_CLASSIFICATION_MAX_OUTPUT_TOKENS: '128001' }), /token budget/);
  assert.equal(requireStageDeepPassConfig({ ...config(), TAKEOFF_V2_OPENAI_REASONING_EFFORT: 'high' }).stages.classification?.reasoningEffort, 'high');
});
test('Kimi/DeepSeek private plan authorization and approved endpoints are separate from account credentials', () => {
  for (const [provider, model] of [['kimi', 'kimi-k3'], ['deepseek', 'deepseek-flash'], ['deepseek', 'deepseek-v4-pro']]) {
    assert.throws(() => requireStageDeepPassConfig({ ...config(provider, model), [`${provider!.toUpperCase()}_PRIVATE_PLAN_DATA_APPROVED`]: 'false' }), /approved explicitly/);
    assert.throws(() => requireStageDeepPassConfig({ ...config(provider, model), [`${provider!.toUpperCase()}_BASE_URL`]: 'https://example.test/v1' }), /approved HTTPS/);
  }
});
