import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAiCompatibleVisionPlanReader,
  configuredProviderOrder,
  requireDeepSeekVisionConfig,
  requireKimiVisionConfig,
} from '../src/ai-plan/openai-vision.ts';

const input = {
  fileBytes: new Uint8Array([37, 80, 68, 70]),
  mimeType: 'application/pdf',
  sheetName: 'E101',
  requestedTrades: ['Electrical'],
  scope: 'Electrical takeoff',
  pageImages: [{ pageNumber: 1, bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const }],
};

test('DeepSeek vision fails closed before network when rendered pages are missing', async () => {
  let called = false;
  const reader = new OpenAiCompatibleVisionPlanReader({
    provider: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    maxImages: 8,
  }, async () => {
    called = true;
    throw new Error('should not call network');
  });

  await assert.rejects(
    reader.read({ ...input, pageImages: [] }),
    /requires server-rendered plan page images/i,
  );
  assert.equal(called, false);
});

test('DeepSeek vision sends page images and sanitizes source-backed JSON', async () => {
  let requestUrl = '';
  let requestBody: any = null;
  const reader = new OpenAiCompatibleVisionPlanReader({
    provider: 'deepseek',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    maxImages: 8,
  }, async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init?.body || '{}'));
    return new Response(JSON.stringify({
      id: 'req_deep_1',
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: {
              sheet_count: 1,
              detected_trade_scope: ['Electrical'],
              scale_status: 'detected',
              limitations: [],
            },
            findings: [{
              page_number: 1,
              finding_type: 'symbol',
              label: 'GFCI receptacle',
              value_text: 'GFCI',
              quantity: 1,
              unit: 'EA',
              confidence: 0.95,
              source_excerpt: 'GFCI',
              geometry: { bbox: [0.1, 0.2, 0.05, 0.05], area: 'Kitchen' },
            }],
          }),
        },
      }],
      usage: { prompt_tokens: 1000, completion_tokens: 100 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });

  const result = await reader.read(input);
  assert.equal(requestUrl, 'https://api.deepseek.com/chat/completions');
  assert.equal(requestBody.model, 'deepseek-flash');
  assert.equal(requestBody.response_format.type, 'json_object');
  const imagePart = requestBody.messages[1].content.find((item: any) => item.type === 'image_url');
  assert.match(imagePart.image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(imagePart.image_url.detail, 'original');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.label, 'GFCI receptacle');
  assert.equal(result.findings[0]?.quantity, 1);
  assert.equal(result.findings[0]?.unit, 'EA');
});

test('Kimi requires an explicit region-matched base URL', () => {
  assert.throws(() => requireKimiVisionConfig({
    KIMI_PLAN_READING_ENABLED: 'true',
    KIMI_API_KEY: 'test-key',
    KIMI_MODEL: 'kimi-k2.6',
  }), /not configured/i);

  assert.throws(() => requireKimiVisionConfig({
    KIMI_PLAN_READING_ENABLED: 'true',
    KIMI_API_KEY: 'test-key',
    KIMI_BASE_URL: 'https://example.com/v1',
    KIMI_MODEL: 'kimi-k2.6',
  }), /approved HTTPS host/i);

  const config = requireKimiVisionConfig({
    KIMI_PLAN_READING_ENABLED: 'true',
    KIMI_API_KEY: 'test-key',
    KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
    KIMI_MODEL: 'kimi-k2.6',
  });
  assert.equal(config.provider, 'kimi');
  assert.equal(config.baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(config.model, 'kimi-k2.6');
});

test('DeepSeek defaults to Flash and provider order is explicit and complete', () => {
  assert.throws(() => requireDeepSeekVisionConfig({
    DEEPSEEK_PLAN_READING_ENABLED: 'true',
    DEEPSEEK_API_KEY: 'test-key',
  }), /private-plan processing is not approved/i);

  const config = requireDeepSeekVisionConfig({
    DEEPSEEK_PLAN_READING_ENABLED: 'true',
    DEEPSEEK_PRIVATE_PLAN_DATA_APPROVED: 'true',
    DEEPSEEK_API_KEY: 'test-key',
  });
  assert.equal(config.model, 'deepseek-flash');
  assert.equal(config.baseUrl, 'https://api.deepseek.com');

  // OpenAI first: the owner-selected reader for the drawing itself, then the
  // remaining paid readers in a fixed, explicit order. Unknown names are ignored
  // and every supported provider is appended exactly once. A name is only a
  // preference: a reader is built only when its own gate passes.
  assert.deepEqual(configuredProviderOrder({}), ['openai', 'gemini', 'claude', 'kimi', 'deepseek']);
  assert.deepEqual(
    configuredProviderOrder({ AI_PLAN_PROVIDER_ORDER: 'kimi,gemini' }),
    ['kimi', 'gemini', 'claude', 'openai', 'deepseek'],
  );
  assert.deepEqual(
    configuredProviderOrder({ AI_PLAN_PROVIDER_ORDER: 'openai,claude,not-a-provider' }),
    ['openai', 'claude', 'gemini', 'kimi', 'deepseek'],
  );
});
