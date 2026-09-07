import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient, GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import type { UsageEvent } from '../src/ai-plan/pilot.ts';

const model = 'gemini-2.5-flash';
const baseInput = {
  fileBytes: new Uint8Array([37, 80, 68, 70]),
  mimeType: 'application/pdf', sheetName: 'SDK isolation fixture', requestedTrades: ['Framing'], scope: 'Fixture scope',
  execution: { attempt: 1, model, max_input_tokens: 5000, max_output_tokens: 1000, reserved_usd: 0.05 },
};

// Exercise the installed SDK's real Developer API request/response adapters.
// Only HTTP transport is replaced: no credential, PDF or request leaves this process.
async function withSdkTransport(generationStatus: number, run: (reader: GeminiPlanReader, requests: { url: string; body: any }[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ url, body });
    if (url.endsWith(':countTokens')) {
      return Response.json({ totalTokens: 100 });
    }
    assert.ok(url.endsWith(':generateContent'), `Unexpected SDK endpoint: ${url}`);
    if (generationStatus !== 200) {
      return Response.json({ error: { code: generationStatus, status: 'RESOURCE_EXHAUSTED', message: 'Fixture rate limit' } }, { status: generationStatus });
    }
    const text = JSON.stringify({ summary: { sheet_count: 1 }, findings: [{
      finding_type: 'room', page_number: 1, label: 'Kitchen', source_excerpt: 'KITCHEN', geometry: {},
    }] });
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      modelVersion: model,
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    });
  };
  try {
    const client = await createGeminiClient('isolated-sdk-test-no-real-credential');
    await run(new GeminiPlanReader(client, [model]), requests);
  } finally { globalThis.fetch = originalFetch; }
}

test('real Gemini SDK counts the exact instruction/PDF contents sent for generation', async () => {
  await withSdkTransport(200, async (reader, requests) => {
    const events: UsageEvent[] = [];
    const result = await reader.read({ ...baseInput, onUsage: event => events.push(event) });
    assert.equal(result.findings[0]?.label, 'Kitchen');
    assert.equal(requests.length, 2);
    assert.ok(requests[0]!.url.endsWith(`/${model}:countTokens`));
    assert.ok(requests[1]!.url.endsWith(`/${model}:generateContent`));
    assert.deepEqual(requests[0]!.body.contents, requests[1]!.body.contents);
    const parts = requests[0]!.body.contents.flatMap((content: any) => content.parts);
    assert.match(parts[0].text, /CRITICAL HARD INVARIANTS/);
    assert.ok(parts.some((part: any) => part.inlineData?.mimeType === 'application/pdf'));
    assert.equal(requests[0]!.body.systemInstruction, undefined);
    assert.equal(requests[1]!.body.systemInstruction, undefined);
    assert.equal(requests[1]!.body.generationConfig.maxOutputTokens, baseInput.execution.max_output_tokens);
    assert.deepEqual(events.map(event => event.outcome), ['no_provider', 'unknown', 'measured']);
  });
});

test('real Gemini SDK makes one generation dispatch on a retryable HTTP error', async () => {
  await withSdkTransport(429, async (reader, requests) => {
    const events: UsageEvent[] = [];
    await assert.rejects(reader.read({ ...baseInput, onUsage: event => events.push(event) }), /No quantities were generated/);
    assert.equal(requests.filter(request => request.url.endsWith(':countTokens')).length, 1);
    assert.equal(requests.filter(request => request.url.endsWith(':generateContent')).length, 1);
    assert.deepEqual(events.map(event => event.outcome), ['no_provider', 'unknown']);
  });
});
