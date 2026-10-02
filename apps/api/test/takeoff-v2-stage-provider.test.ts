import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { AiProviderError } from '../src/ai-plan/provider-errors.ts';
import { withUsageMeter, UsageAccountingError } from '../src/owner-usage/meter.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { createStageDeepPassProviderFactory } from '../src/takeoff-v2/stage-provider.ts';
import { planPageRegions } from '../src/ai-plan/page-tiles.ts';
import type { DeepPassRequest, DeepPassType } from '../src/takeoff-v2/types.ts';

const attestation = { accountVerified: true, compatibilityVerified: true, priceVersion: 'review-2026-10-02', maximumCallCostUsd: 25 };
function env(provider: string, model: string) { return {
  TAKEOFF_V2_ENABLED: 'true', TAKEOFF_V2_WORKER_ENABLED: 'true', TAKEOFF_V2_SCHEMA_VERSION: 'takeoff-v2-foundation-v1',
  TAKEOFF_V2_STAGE_PROVIDER_ENABLED: 'true', TAKEOFF_V2_STAGE_CLASSIFICATION_ENABLED: 'true',
  TAKEOFF_V2_STAGE_CLASSIFICATION_PROVIDER: provider, TAKEOFF_V2_STAGE_CLASSIFICATION_MODEL: model,
  TAKEOFF_V2_MODEL_ATTESTATIONS_JSON: JSON.stringify({ [model]: attestation }),
  OPENAI_API_KEY: 'unit-openai-credential', ANTHROPIC_API_KEY: 'unit-claude-credential', GEMINI_API_KEY: 'unit-gemini-credential',
  KIMI_API_KEY: 'unit-kimi-credential', DEEPSEEK_API_KEY: 'unit-deepseek-credential',
  KIMI_PRIVATE_PLAN_DATA_APPROVED: 'true', DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
}; }
function checkpoint(page = 2, passType: DeepPassType = 'classification') { return JSON.stringify({ status: 'succeeded', checkpoint: {
  version: 'claude-deep-v1', physical_page_number: page, pass_type: passType,
  observations: [{ kind: 'sheet_title', description: 'Architecture', source_excerpt: 'A101 PLAN', confidence: 0.9 }], blockers: [],
} }); }
async function fixture() {
  const pdf = await PDFDocument.create(); pdf.addPage([612, 792]); pdf.addPage([792, 612]);
  const fileBytes = new Uint8Array(await pdf.save());
  const manifest = await createPlanSetManifest(fileBytes);
  const input = { fileBytes, manifest, runId: 'run-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1' };
  const request = (passType: DeepPassType = 'classification'): DeepPassRequest => ({
    runId: input.runId, sheet: manifest.sheets[1]!, passType, attempt: 1, idempotencyKey: `2-${passType}`, reasoningEffort: 'high',
  });
  return { input, request };
}
function accounting(options: { reserved?: unknown; reserveError?: string; failSettlement?: boolean } = {}) {
  const rows: any[] = [], calls: string[] = [], rpcCalls: any[] = [];
  const writer = {
    from(table: string) { assert.equal(table, 'api_usage_events'); return {
      insert: async (row: any) => { calls.push('event'); rows.push(row); return { error: null }; },
      update: (patch: any) => ({ eq: async (_key: string, id: string) => {
        calls.push('settle'); Object.assign(rows.find(row => row.id === id), patch);
        return { error: options.failSettlement ? { message: 'private settlement' } : null };
      } }),
    }; },
    rpc: async (fn: string, args: any) => {
      calls.push(fn); rpcCalls.push({ fn, args });
      return { data: { reserved_usd: options.reserved ?? 25 },
        error: fn === 'reserve_provider_spend' && options.reserveError ? { message: options.reserveError } : null };
    },
  };
  const run = <T>(action: () => Promise<T>) => withUsageMeter({ writer, userId: 'user-1', workspaceId: 'workspace-1', projectId: 'project-1', jobId: 'run-1', billing: 'paid' }, action);
  return { rows, calls, rpcCalls, run, writer };
}
function success(provider: string, text = checkpoint()) {
  if (provider === 'kimi' || provider === 'deepseek') return { id: 'chat-1', choices: [{ finish_reason: 'stop', message: { content: text, reasoning_content: 'private' } }], usage: { prompt_tokens: 123, completion_tokens: 45 } };
  if (provider === 'openai') return { id: 'resp-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 123, output_tokens: 45 } };
  if (provider === 'claude') return { id: 'msg-1', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text }], usage: { input_tokens: 123, output_tokens: 45 } };
  return { responseId: 'gemini-1', candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private' }, { text }] } }], usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 40, thoughtsTokenCount: 5 } };
}
test('stage transports send documented JSON contracts and one physical PDF only, after reservation', async () => {
  const { input, request } = await fixture();
  for (const [providerName, model] of [['openai', 'gpt-6-astra'], ['claude', 'claude-opus-5-5'], ['claude', 'claude-fable-5-1'], ['gemini', 'gemini-3.1-pro-preview'], ['gemini', 'gemini-3.8-flash']]) {
    const meter = accounting(); let body: any; let url = ''; let signal: AbortSignal | null | undefined;
    const provider = await createStageDeepPassProviderFactory(env(providerName!, model!), (async (target, init) => {
      meter.calls.push('fetch'); url = String(target); body = JSON.parse(String(init?.body)); signal = init?.signal;
      return Response.json(success(providerName!));
    }) as typeof fetch).create(input);
    const result = await meter.run(() => provider.runPass(request()));
    assert.deepEqual(meter.calls, ['event', 'reserve_provider_spend', 'fetch', 'settle', 'capture_provider_spend']);
    assert.equal(result.model, model); assert.equal(result.inputTokens, 123); assert.equal(result.outputTokens, 45);
    assert.ok(signal instanceof AbortSignal); assert.equal(result.checkpoint.physical_page_number, 2);
    let data: string;
    if (providerName === 'openai') {
      assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(body.store, false);
      assert.equal(body.reasoning.effort, 'max'); assert.equal(body.text.format.type, 'json_schema');
      data = body.input[0].content[0].file_data.split(',')[1];
    } else if (providerName === 'claude') {
      assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.deepEqual(body.thinking, { type: 'adaptive' });
      assert.equal(body.output_config.effort, 'max'); assert.equal(body.output_config.format.type, 'json_schema');
      assert.equal(body.tool_choice, undefined); data = body.messages[0].content[0].source.data;
    } else {
      assert.match(url, /:generateContent$/); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
      assert.equal(body.generationConfig.responseFormat.text.mimeType, 'application/json');
      data = body.contents[0].parts[0].inlineData.data;
    }
    const isolated = await PDFDocument.load(Buffer.from(data!, 'base64')); assert.equal(isolated.getPageCount(), 1);
    assert.equal(meter.rows[0].actual_cost_usd, null);
    if (providerName !== 'gemini' || model !== 'gemini-3.8-flash') assert.equal(meter.rpcCalls.at(-1).args.p_estimated_cost_usd, null);
    assert.doesNotMatch(JSON.stringify(meter.rows), /A101 PLAN|unit-openai-credential|private/);
  }
});
test('Kimi/DeepSeek image stages route only validated, identified cropped regions and disclose partial coverage', async () => {
  const { input, request } = await fixture();
  const regions = planPageRegions({ width: request().sheet.widthPoints, height: request().sheet.heightPoints }, 2);
  for (const [providerName, model] of [['kimi', 'kimi-k3'], ['deepseek', 'deepseek-flash']]) {
    const meter = accounting(); let body: any; let url = '';
    const provider = await createStageDeepPassProviderFactory(env(providerName!, model!), (async (target, init) => {
      meter.calls.push('fetch'); url = String(target); body = JSON.parse(String(init?.body)); return Response.json(success(providerName!));
    }) as typeof fetch, { loadPageImages: async () => [{ dataUrl: 'data:image/png;base64,aW1hZ2U=', pageNumber: 2,
      widthPixels: 1000, heightPixels: 1000, region: regions[0]!, label: 'Top left verified crop' }] }).create(input);
    const result = await meter.run(() => provider.runPass(request()));
    assert.equal(result.model, model); assert.equal(result.status, 'succeeded');
    assert.equal((result.checkpoint.source_coverage as any).visual_coverage, 'selected_regions');
    assert.deepEqual(meter.calls, ['event', 'reserve_provider_spend', 'fetch', 'settle', 'capture_provider_spend']);
    assert.match(url, /chat\/completions$/); assert.equal(body.reasoning_effort, 'max');
    assert.doesNotMatch(JSON.stringify(body), /input_file|application\/pdf/);
    assert.equal(body.temperature, undefined); assert.equal(body.top_p, undefined);
    assert.equal(body.messages[1].content[2].type, 'image_url');
    if (providerName === 'kimi') { assert.equal(body.max_completion_tokens, 64000); assert.equal(body.response_format.type, 'json_schema'); }
    else { assert.equal(body.max_tokens, 64000); assert.equal(body.response_format.type, 'json_object'); assert.equal(body.messages[1].content[2].image_url.detail, 'original'); }
  }
});
test('missing or oversized image regions block before vendor dispatch and never send the PDF as a fallback', async () => {
  const { input, request } = await fixture(); const region = planPageRegions({ width: 792, height: 612 }, 2)[0]!;
  for (const images of [[], [{ dataUrl: 'data:image/png;base64,aW1hZ2U=', pageNumber: 2 }],
    [{ dataUrl: 'data:image/png;base64,aW1hZ2U=', pageNumber: 2, widthPixels: 1500, heightPixels: 1000, region }]]) {
    const meter = accounting();
    const provider = await createStageDeepPassProviderFactory(env('deepseek', 'deepseek-flash'), (async () => { assert.fail('must not dispatch'); }) as typeof fetch,
      { loadPageImages: async () => images }).create(input);
    const result = await meter.run(() => provider.runPass(request())); assert.equal(result.status, 'blocked'); assert.equal(meter.rows.length, 0);
  }
});
test('DeepSeek Pro receives native text only; blank text is blocked and never becomes a visual review', async () => {
  const { input, request } = await fixture(); const meter = accounting(); let body: any;
  const provider = await createStageDeepPassProviderFactory(env('deepseek', 'deepseek-v4-pro'), (async (_target, init) => {
    body = JSON.parse(String(init?.body)); return Response.json(success('deepseek'));
  }) as typeof fetch, { loadSheetText: async () => 'A101 PLAN\nWindow schedule tag W1.' }).create(input);
  const result = await meter.run(() => provider.runPass(request()));
  assert.equal((result.checkpoint.source_coverage as any).input_kind, 'text');
  assert.equal((result.checkpoint.source_coverage as any).visual_coverage, 'not_observed');
  assert.equal(typeof body.messages[1].content, 'string'); assert.match(body.messages[1].content, /Window schedule/);
  assert.doesNotMatch(JSON.stringify(body), /image_url|input_file|application\/pdf/);
  assert.equal(body.model, 'deepseek-v4-pro'); assert.equal(body.reasoning_effort, 'max');
  const blank = await createStageDeepPassProviderFactory(env('deepseek', 'deepseek-v4-pro'), (async () => { assert.fail('blank cannot dispatch'); }) as typeof fetch,
    { loadSheetText: async () => null }).create(input);
  assert.equal((await meter.run(() => blank.runPass(request()))).status, 'blocked');
});
test('hitting checkpoint observation capacity creates a persistent review blocker, never complete coverage', async () => {
  const { input, request } = await fixture(); const meter = accounting(); const output = JSON.parse(checkpoint());
  output.checkpoint.observations = Array.from({ length: 50 }, () => ({ kind: 'note', description: 'Source note', source_excerpt: 'A101', confidence: 0.9 }));
  const provider = await createStageDeepPassProviderFactory(env('claude', 'claude-fable-5-1'), (async () => Response.json(success('claude', JSON.stringify(output)))) as typeof fetch).create(input);
  const result = await meter.run(() => provider.runPass(request()));
  assert.equal(result.status, 'blocked'); assert.ok((result.checkpoint.blockers as string[]).includes('capacity_more_regional_review_required'));
  assert.equal((result.checkpoint.capacity as any).reached_observation_limit, true);
  assert.equal(result.checkpoint.reasoning_effort, 'max');
});
test('missing scope, wrong project identity, insufficient reservation or unavailable SQL dispatch no provider request', async () => {
  const { input, request } = await fixture(); let calls = 0;
  const create = () => createStageDeepPassProviderFactory(env('openai', 'gpt-6-astra'), (async () => { calls++; return Response.json(success('openai')); }) as typeof fetch).create(input);
  await assert.rejects((await create()).runPass(request()), UsageAccountingError);
  for (const options of [{ reserved: 2.5 }, { reserved: 'invalid' }, { reserveError: 'Provider spend job is not authorized' }]) {
    const meter = accounting(options); const provider = await create();
    await assert.rejects(meter.run(() => provider.runPass(request())), UsageAccountingError);
  }
  const meter = accounting(); const provider = await create();
  await assert.rejects(withUsageMeter({ writer: meter.writer, userId: 'u', workspaceId: 'other', projectId: input.projectId, jobId: input.runId, billing: 'paid' }, () => provider.runPass(request())), UsageAccountingError);
  assert.equal(calls, 0);
});
test('truncated, invalid and cross-sheet output is metered but never checkpointed or retried with another model', async t => {
  t.mock.method(console, 'error', () => {});
  const { input, request } = await fixture();
  for (const response of [success('openai', checkpoint(1)), success('openai', '{bad'), { ...success('openai'), status: 'incomplete' }]) {
    let calls = 0; const meter = accounting();
    const provider = await createStageDeepPassProviderFactory(env('openai', 'gpt-6-astra'), (async () => { calls++; return Response.json(response); }) as typeof fetch).create(input);
    await assert.rejects(meter.run(() => provider.runPass(request())), AiProviderError);
    await assert.rejects(meter.run(() => provider.runPass(request())), AiProviderError);
    assert.equal(calls, 1); assert.equal(meter.rows.length, 1); assert.equal(meter.rpcCalls.at(-1).fn, 'capture_provider_spend');
  }
});
test('provider denial and timeout retain unknown exposure and never emit private upstream details', async t => {
  t.mock.method(console, 'error', () => {});
  const { input, request } = await fixture();
  for (const failure of [() => new Response('private upstream secret', { status: 403 }), () => { throw new DOMException('private timeout', 'TimeoutError'); }]) {
    const meter = accounting(); let calls = 0;
    const provider = await createStageDeepPassProviderFactory(env('claude', 'claude-opus-5-5'), (async () => { calls++; return failure(); }) as typeof fetch).create(input);
    await assert.rejects(meter.run(() => provider.runPass(request())), (error: any) => error instanceof AiProviderError && !error.message.includes('private'));
    await assert.rejects(meter.run(() => provider.runPass(request()))); assert.equal(calls, 1);
    assert.match(meter.rows[0].operation, /failed_unknown$/); assert.equal(meter.rpcCalls.at(-1).args.p_estimated_cost_usd, null);
  }
});
test('local geometry/arithmetic/pricing and disabled risk stages make no paid call or invent quantity/price', async () => {
  const { input, request } = await fixture();
  const provider = await createStageDeepPassProviderFactory(env('openai', 'gpt-6-astra'), (async () => { assert.fail('local stage cannot dispatch'); }) as typeof fetch).create(input);
  for (const pass of ['geometry', 'arithmetic_qa', 'pricing_assemblies', 'risk_review'] as const) {
    const result = await provider.runPass(request(pass)); assert.equal(result.status, 'blocked');
    assert.equal(result.provider, 'roughbid'); assert.ok(Array.isArray(result.checkpoint.blockers));
    assert.equal(result.checkpoint.quantity, undefined); assert.equal(result.checkpoint.price, undefined);
  }
});
