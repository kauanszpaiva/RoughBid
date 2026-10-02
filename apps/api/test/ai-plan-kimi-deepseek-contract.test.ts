import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleVisionPlanReader, requireDeepSeekVisionConfig, requireKimiVisionConfig } from '../src/ai-plan/openai-vision.ts';
import { assertRenderedVisionRequestSize, requireImageProviderBaseUrl, renderedVisionGenerationOptions } from '../src/ai-plan/vision-capabilities.ts';

const kimiEnv = { KIMI_PLAN_READING_ENABLED: 'true', KIMI_PRIVATE_PLAN_DATA_APPROVED: 'true',
  KIMI_API_KEY: 'mock-key', KIMI_BASE_URL: 'https://api.moonshot.ai/v1', KIMI_MODEL: 'kimi-k3' };
const deepseekEnv = { DEEPSEEK_PLAN_READING_ENABLED: 'true', DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
  DEEPSEEK_API_KEY: 'mock-key', DEEPSEEK_MODEL: 'deepseek-flash' };
const input = { fileBytes: new Uint8Array([37, 80, 68, 70]), mimeType: 'application/pdf', sheetName: 'A101',
  requestedTrades: ['Architecture'], scope: 'Drawing evidence',
  pageImages: [{ pageNumber: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' as const }] };
const completion = () => new Response(JSON.stringify({ id: 'mock-kimi', choices: [{ finish_reason: 'stop',
  message: { reasoning_content: 'This field is deliberately not parsed as JSON.', content: JSON.stringify({
    summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'KITCHEN',
      quantity: null, unit: null, confidence: 0.8, source_excerpt: 'KITCHEN' }],
  }) } }], usage: { prompt_tokens: 123, completion_tokens: 42 } }), { status: 200 });

test('Kimi K3 is explicit and private data approval remains closed by default', () => {
  assert.equal(requireKimiVisionConfig(kimiEnv).model, 'kimi-k3');
  assert.throws(() => requireKimiVisionConfig({ ...kimiEnv, KIMI_MODEL: undefined }), /not configured/i);
  assert.throws(() => requireKimiVisionConfig({ ...kimiEnv, KIMI_PRIVATE_PLAN_DATA_APPROVED: undefined }), /not approved/i);
  for (const model of ['kimi-k2', 'kimi-latest', 'kimi-k3-guessed', 'kimi-k2.5']) {
    assert.throws(() => requireKimiVisionConfig({ ...kimiEnv, KIMI_MODEL: model }), /verified vision model/i);
  }
});

test('DeepSeek Pro cannot enter image transport, and a dedicated visual model overrides text selection', () => {
  assert.throws(() => requireDeepSeekVisionConfig({ ...deepseekEnv, DEEPSEEK_MODEL: 'deepseek-v4-pro' }), /text only/i);
  assert.equal(requireDeepSeekVisionConfig({ ...deepseekEnv, DEEPSEEK_MODEL: 'deepseek-v4-pro',
    DEEPSEEK_VISION_MODEL: 'deepseek-flash' }).model, 'deepseek-flash');
  assert.throws(() => requireDeepSeekVisionConfig({ ...deepseekEnv, DEEPSEEK_MODEL: 'deepseek-v4-flash' }), /verified vision model/i);
});

test('provider base URL validates API path, explicit region, and absence of inline credentials', () => {
  assert.equal(requireImageProviderBaseUrl('kimi', 'https://api.moonshot.cn/v1/'), 'https://api.moonshot.cn/v1');
  for (const url of ['https://api.moonshot.ai', 'https://api.moonshot.ai/v1/other', 'https://api.moonshot.ai/v1?secret=x',
    'https://user:mock-key@api.moonshot.ai/v1', 'http://api.moonshot.ai/v1', 'https://api.moonshot.ai:8443/v1']) {
    assert.throws(() => requireImageProviderBaseUrl('kimi', url), /approved HTTPS host and API path/);
  }
  assert.throws(() => requireImageProviderBaseUrl('deepseek', 'https://api.deepseek.com/anthropic'), /approved HTTPS/);
});

test('Kimi K3 sends only the documented single-turn visual options and parses final content', async () => {
  let body: any;
  const reader = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async (url, init) => {
    assert.equal(String(url), 'https://api.moonshot.ai/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    body = JSON.parse(String(init?.body));
    return completion();
  });
  const result = await reader.read({ ...input, reasoningEffort: 'high' });
  assert.equal(result.findings[0]?.label, 'KITCHEN');
  assert.equal(body.max_completion_tokens, 16_000);
  assert.equal(body.reasoning_effort, 'high');
  for (const key of ['temperature', 'top_p', 'thinking', 'max_tokens', 'tools']) assert.equal(Object.hasOwn(body, key), false);
  assert.equal(body.messages[1].content.some((part: any) => part.type === 'file'), false);
  assert.match(body.messages[1].content.find((part: any) => part.type === 'image_url').image_url.url, /^data:image\/png;base64,/);
});

test('Kimi K2.6 uses its explicit thinking toggle and max_tokens contract', () => {
  assert.deepEqual(renderedVisionGenerationOptions('kimi', 'kimi-k2.6', 12_000, 'high'),
    { max_tokens: 12_000, thinking: { type: 'enabled' } });
  assert.deepEqual(renderedVisionGenerationOptions('deepseek', 'deepseek-flash', 12_000, 'low'),
    { max_tokens: 12_000, thinking: { type: 'disabled' } });
});

test('visual providers reject missing, over-limit, duplicate or unsupported pages before a request', async () => {
  let called = false;
  const reader = new OpenAiCompatibleVisionPlanReader({ ...requireKimiVisionConfig(kimiEnv), maxImages: 1 }, async () => {
    called = true; throw new Error('Unexpected provider request.');
  });
  await assert.rejects(reader.read({ ...input, pageImages: [] }), /server-rendered/);
  await assert.rejects(reader.read({ ...input, pageImages: [input.pageImages[0]!, { ...input.pageImages[0]!, pageNumber: 2 }] }), /explicit page windows/);
  await assert.rejects(reader.read({ ...input, pageImages: [{ ...input.pageImages[0]!, mimeType: 'application/pdf' as any }] }), /supported image types/);
  assert.equal(called, false);
  const duplicates = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async () => {
    called = true; throw new Error('Unexpected provider request.');
  });
  await assert.rejects(duplicates.read({ ...input, pageImages: [input.pageImages[0]!, input.pageImages[0]!] }), /unique physical page numbers/);
  assert.equal(called, false);
});

test('DeepSeek inline bound includes base64 expansion rather than just raw images', () => {
  const body = 'x'.repeat(48 * 1024 * 1024 + 1);
  assert.throws(() => assertRenderedVisionRequestSize('deepseek', body), /inline body limit/);
});

test('a direct DeepSeek Pro reader cannot bypass the vision capability gate', async () => {
  let called = false;
  const reader = new OpenAiCompatibleVisionPlanReader({ ...requireDeepSeekVisionConfig(deepseekEnv), model: 'deepseek-v4-pro' }, async () => {
    called = true; throw new Error('Unexpected request.');
  });
  await assert.rejects(reader.read(input), /text only/);
  assert.equal(called, false);
});

test('a partial rendered set is blocked before network instead of claiming full coverage', async () => {
  let called = false;
  const reader = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async () => {
    called = true; throw new Error('Unexpected request.');
  });
  await assert.rejects(reader.read({ ...input, pageCount: 17 }), /every physical page to be rendered/);
  await assert.rejects(reader.read({ ...input, pageCount: 2, pageImages: [input.pageImages[0]!,
    { ...input.pageImages[0]!, pageNumber: 3 }] }), /every physical page to be rendered/);
  assert.equal(called, false);
});

test('one-page extracted PDF normalizes copied rendered-image numbering for caller restoration', async () => {
  const original = { ...input, pageCount: 1, pageImages: [{ ...input.pageImages[0]!, pageNumber: 17 }] };
  let body: any;
  const reader = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async (_url, init) => {
    body = JSON.parse(String(init?.body)); return completion();
  });
  const result = await reader.read(original);
  assert.equal(original.pageImages[0]?.pageNumber, 17, 'caller input remains unchanged');
  assert.equal(body.messages[1].content.some((part: any) => part.text === 'Physical PDF page 1:'), true);
  assert.equal(result.findings[0]?.page_number, 1);
});

test('unknown source page count is disclosed instead of asserting complete plan-set coverage', async () => {
  const reader = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async () => completion());
  const result = await reader.read(input);
  assert.equal(result.summary.human_review_required, true);
  assert.ok(result.summary.limitations.some(notice => /source page count is unknown/.test(notice)));
});

test('a visual answer cannot invent a source-page number outside its attached images', async () => {
  const reader = new OpenAiCompatibleVisionPlanReader(requireKimiVisionConfig(kimiEnv), async () =>
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      summary: { sheet_count: 99 }, findings: [{ page_number: 17, finding_type: 'room', label: 'KITCHEN',
        confidence: 0.8, source_excerpt: 'KITCHEN' }],
    }) } }] }), { status: 200 }));
  await assert.rejects(reader.read({ ...input, pageCount: 1 }), error =>
    (error as any).diagnostic?.code === 'provider_invalid_output');
});
