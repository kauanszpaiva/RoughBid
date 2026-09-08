import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader, createGeminiClient } from '../src/ai-plan/gemini.ts';
import { MultiProviderPlanReader } from '../src/ai-plan/multi-provider.ts';
import { AiProviderError } from '../src/ai-plan/provider-errors.ts';

const input = { fileBytes: new Uint8Array([37,80,68,70]), mimeType: 'application/pdf', sheetName: 'PRIVATE PLAN', requestedTrades: ['Framing'], scope: null };

test('invalid provider credentials stop after one attempt and preserve a sanitized diagnosis', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args) => { logs.push(JSON.stringify(args)); });
  let calls = 0;
  const reader = new GeminiPlanReader({ generateContent: async () => {
    calls += 1;
    throw Object.assign(new Error(JSON.stringify({ error: { code: 400, message: 'DO_NOT_LOG_API_KEY or PRIVATE PLAN', details: [{ reason: 'API_KEY_INVALID' }] } })), { status: 400 });
  } }, ['gemini-2.5-flash', 'another-configured-model']);
  await assert.rejects(reader.read(input), (error: unknown) => error instanceof AiProviderError && error.diagnostic.code === 'provider_credentials' && !error.message.includes('DO_NOT_LOG'));
  assert.equal(calls, 1, 'Changing models cannot repair invalid credentials; do not send another inference request.');
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('').includes('DO_NOT_LOG'));
  assert.ok(!logs.join('').includes('PRIVATE PLAN'));
});

test('the provider coordinator preserves an existing safe diagnosis and reference', async (t) => {
  t.mock.method(console, 'error', () => {});
  const diagnostic = new AiProviderError('provider_credentials', { provider: 'gemini', model: 'gemini-2.5-flash', stage: 'generate', durationMs: 0 });
  const reader = new MultiProviderPlanReader([{ name: 'gemini', read: async () => { throw diagnostic; } }]);
  await assert.rejects(reader.read(input), (error: unknown) => error === diagnostic);
});

test('truncated provider JSON has a distinct diagnosis instead of a parsing error', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = new GeminiPlanReader({ generateContent: async () => ({ text: '{"findings": [', candidates: [{ finishReason: 'MAX_TOKENS' }] }) } as any, ['gemini-2.5-flash']);
  await assert.rejects(reader.read(input), (error: any) => error.diagnostic?.code === 'provider_output_truncated');
});

test('a token-limited response is rejected even if its partial JSON happens to parse', async (t) => {
  t.mock.method(console, 'error', () => {});
  const reader = new GeminiPlanReader({ generateContent: async () => ({
    text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' }] }),
    candidates: [{ finishReason: 'MAX_TOKENS' }],
  }) } as any, ['gemini-2.5-flash']);
  await assert.rejects(reader.read(input), (error: any) => error.diagnostic?.code === 'provider_output_truncated');
});

test('real SDK serializes the PDF and reads the generated JSON at the HTTP boundary', async (t) => {
  const finding = { page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' };
  let requests = 0;
  let captured: any;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: any) => {
    requests += 1;
    captured = JSON.parse(init.body);
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [finding] }) }] }, finishReason: 'STOP' }] });
  });
  const client = await createGeminiClient('test-sdk-key-not-live');
  const result = await new GeminiPlanReader(client, ['gemini-2.5-flash']).read(input);
  assert.equal(result.findings[0]?.label, 'Kitchen');
  assert.equal(captured.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
  assert.equal(requests, 1);
});
