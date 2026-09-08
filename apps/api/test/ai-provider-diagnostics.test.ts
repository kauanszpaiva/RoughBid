import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader, createGeminiClient } from '../src/ai-plan/gemini.ts';
import { MultiProviderPlanReader } from '../src/ai-plan/multi-provider.ts';

const input = { fileBytes: new Uint8Array([37,80,68,70]), mimeType: 'application/pdf', sheetName: 'PRIVATE PLAN', requestedTrades: ['Framing'], scope: null };

test('Gemini preserves invalid-credential diagnosis without exposing provider text or trying another model', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args) => { logs.push(JSON.stringify(args)); });
  let calls = 0;
  const reader = new GeminiPlanReader({ generateContent: async () => {
    calls += 1;
    throw Object.assign(new Error(JSON.stringify({ error: { code: 400, message: 'DO_NOT_LOG_API_KEY or PRIVATE PLAN', details: [{ reason: 'API_KEY_INVALID' }] } })), { status: 400 });
  } }, ['gemini-2.5-flash', 'another-configured-model']);
  await assert.rejects(reader.read(input), (error: any) => error.code === 'AI_PROVIDER_CREDENTIALS' && !error.message.includes('DO_NOT_LOG'));
  assert.equal(calls, 1);
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('').includes('DO_NOT_LOG'));
  assert.ok(!logs.join('').includes('PRIVATE PLAN'));
});

test('the provider coordinator preserves a safe actionable diagnosis', async () => {
  const diagnostic = Object.assign(new Error('Provider access is not configured. No quantities were generated.'), { code: 'AI_PROVIDER_CREDENTIALS', retryable: false });
  const reader = new MultiProviderPlanReader([{ name: 'gemini', read: async () => { throw diagnostic; } }]);
  await assert.rejects(reader.read(input), (error: any) => error.code === 'AI_PROVIDER_CREDENTIALS');
});

test('truncated provider JSON is not silently stored as a valid reading', async () => {
  const reader = new GeminiPlanReader({ generateContent: async () => ({ text: '{"findings": [', candidates: [{ finishReason: 'MAX_TOKENS' }] }) } as any, ['gemini-2.5-flash']);
  await assert.rejects(reader.read(input), (error: any) => error.code === 'AI_RESPONSE_TRUNCATED');
});

test('real SDK serializes the PDF and reads the generated JSON at the HTTP boundary', async (t) => {
  const finding = { page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' };
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    requests += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [finding] }) }] }, finishReason: 'STOP' }] });
  });
  const client = await createGeminiClient('test-sdk-key-not-live');
  const result = await new GeminiPlanReader(client, ['gemini-2.5-flash']).read(input);
  assert.equal(result.findings[0]?.label, 'Kitchen');
  assert.equal(requests, 1);
});
