import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekTextJsonProvider, requireDeepSeekTextConfig } from '../src/ai-plan/deepseek-text.ts';
import { withUsageMeter } from '../src/owner-usage/meter.ts';

const env = { DEEPSEEK_TEXT_READING_ENABLED: 'true', DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
  DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_TEXT_MODEL: 'deepseek-v4-pro' };
const reviewed = { accountVerified: true as const, compatibilityVerified: true as const, maximumCallCostUsd: 0.25 };
const input = { prompt: 'Source page 1: printed dimension 4m. Reconcile only this evidence.', systemPrompt: 'Return source-backed JSON; missing data must stay null.' };
function context(reservedUsd = 0.25) {
  const calls: string[] = [];
  const builder: any = { insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) };
  return { calls, meter: { userId: 'user-1', workspaceId: 'workspace-1', projectId: 'project-1', jobId: 'job-1', billing: 'paid' as const,
    writer: { from: () => builder, rpc: async (name: string) => {
      calls.push(name); return { data: { reserved_usd: reservedUsd }, error: null };
    } } } };
}
function response(finishReason = 'stop', content = '{"quantity":null,"source_page":1}') {
  return new Response(JSON.stringify({ id: 'mock-pro', choices: [{ finish_reason: finishReason,
    message: { reasoning_content: 'This is not part of the returned evidence.', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200 });
}

test('text factory is separately enabled and requires an explicit verified Pro selection', () => {
  assert.equal(requireDeepSeekTextConfig(env, reviewed).model, 'deepseek-v4-pro');
  assert.throws(() => requireDeepSeekTextConfig({ ...env, DEEPSEEK_TEXT_READING_ENABLED: undefined }, reviewed), /disabled/);
  assert.throws(() => requireDeepSeekTextConfig({ ...env, DEEPSEEK_TEXT_MODEL: undefined }, reviewed), /explicit DEEPSEEK_TEXT_MODEL/);
  assert.throws(() => requireDeepSeekTextConfig({ ...env, DEEPSEEK_TEXT_MODEL: 'deepseek-flash' }, reviewed), /explicit DEEPSEEK_TEXT_MODEL/);
  assert.throws(() => requireDeepSeekTextConfig(env, { ...reviewed, accountVerified: false as any }), /account\/compatibility/);
});

test('Pro sends text-only JSON transport after spend reservation and returns final content', async () => {
  const scope = context();
  let body: any;
  const reader = new DeepSeekTextJsonProvider(requireDeepSeekTextConfig(env, reviewed), async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions');
    assert.deepEqual(scope.calls, ['reserve_provider_spend']);
    assert.equal(init?.redirect, 'error');
    body = JSON.parse(String(init?.body));
    return response();
  });
  const result = await withUsageMeter(scope.meter, () => reader.generate(input));
  assert.deepEqual(result, { quantity: null, source_page: 1 });
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.equal(body.max_tokens, 16_000);
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.messages.every((message: any) => typeof message.content === 'string'), true);
  assert.deepEqual(scope.calls, ['reserve_provider_spend', 'capture_provider_spend']);
});

test('Pro fails closed without metering context, insufficient reservation or with image/PDF blocks', async () => {
  let called = false;
  const reader = new DeepSeekTextJsonProvider(requireDeepSeekTextConfig(env, reviewed), async () => {
    called = true; return response();
  });
  await assert.rejects(reader.generate(input), /accounting is unavailable/);
  const scope = context(0.01);
  await assert.rejects(withUsageMeter(scope.meter, () => reader.generate(input)), /accounting is unavailable/);
  await assert.rejects(reader.generate({ ...input, pageImages: [{ mimeType: 'image/png' }] } as any), /text evidence/);
  await assert.rejects(reader.generate({ ...input, fileBytes: new Uint8Array([1]) } as any), /text evidence/);
  assert.equal(called, false);
});

test('Pro truncated or malformed final evidence is rejected without automatic retry', async () => {
  for (const [finish, content] of [['length', '{}'], ['stop', 'not json'], ['stop', '[]']]) {
    const scope = context();
    let calls = 0;
    const reader = new DeepSeekTextJsonProvider(requireDeepSeekTextConfig(env, reviewed), async () => {
      calls += 1; return response(finish, content);
    });
    await assert.rejects(withUsageMeter(scope.meter, () => reader.generate(input)), error =>
      /provider_output_truncated|provider_invalid_output/.test((error as any).diagnostic?.code));
    assert.equal(calls, 1);
    assert.deepEqual(scope.calls, ['reserve_provider_spend', 'capture_provider_spend']);
  }
});
