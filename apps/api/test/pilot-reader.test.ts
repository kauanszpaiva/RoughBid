import test from 'node:test';
import assert from 'node:assert/strict';
import { PilotPlanReader, PILOT_MODEL, PILOT_MAX_FINDINGS, PILOT_COVERAGE_NOTICE, PILOT_RESPONSE_SCHEMA, requirePilotReaderConfig } from '../src/ai-plan/pilot-reader.ts';
import { AiProviderError } from '../src/ai-plan/provider-errors.ts';
import { createGeminiClient } from '../src/ai-plan/gemini.ts';

const input = { fileBytes: new TextEncoder().encode('%PDF-example'), mimeType: 'application/pdf', sheetName: 'plan.pdf', requestedTrades: ['Framing'], scope: '' };
const evidence = JSON.stringify({ summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'missing' }, findings: [{ page_number: 1, finding_type: 'question', label: 'Verify dimensions', source_excerpt: 'VERIFY IN FIELD', confidence: 0.8, geometry: {} }] });

test('pilot is pinned to the production-verified Gemini model', () => {
  assert.equal(PILOT_MODEL, 'gemini-3.8-flash');
});

test('pilot fails before generation when token count is unavailable or above envelope', async () => {
  for (const totalTokens of [undefined, NaN, 32_001, -1]) {
    let generated = false;
    const reader = new PilotPlanReader({ countTokens: async () => ({ totalTokens }), generateContent: async () => { generated = true; return { text: evidence }; } });
    await assert.rejects(() => reader.read(input), /exceeds the pilot/);
    assert.equal(generated, false);
  }
});

test('pilot uses exactly one pinned bounded request and reports reserved cost separately from usage', async () => {
  let calls = 0;
  const reader = new PilotPlanReader({ countTokens: async args => {
    assert.equal(args.model, PILOT_MODEL);
    assert.match(JSON.stringify(args.contents), /CRITICAL HARD INVARIANTS/);
    assert.deepEqual(args.contents.at(-1), { role: 'user', parts: [{ text: JSON.stringify(PILOT_RESPONSE_SCHEMA) }] });
    return { totalTokens: 32_000 };
  }, generateContent: async args => {
    calls++;
    assert.equal(args.model, PILOT_MODEL);
    assert.equal(args.config.maxOutputTokens, 4096);
    assert.deepEqual(args.config.responseJsonSchema, PILOT_RESPONSE_SCHEMA);
    assert.equal(PILOT_RESPONSE_SCHEMA.properties.findings.maxItems, PILOT_MAX_FINDINGS);
    assert.deepEqual(args.config.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.deepEqual(args.config.httpOptions, { timeout: 60_000, retryOptions: { attempts: 1 } });
    assert.equal(args.config.tools, undefined);
    return { text: evidence };
  } });
  const result = await reader.read(input);
  assert.equal(calls, 1);
  assert.equal(result.summary.pilot_usage?.reserved_cents, 25);
  assert.equal(result.summary.pilot_usage?.provider_usage, undefined);
  assert.equal(result.summary.human_review_required, true);
  assert.ok(result.summary.limitations.includes(PILOT_COVERAGE_NOTICE));
});

test('pilot malformed paid response never falls back or retries', async () => {
  let calls = 0;
  const reader = new PilotPlanReader({ countTokens: async () => ({ totalTokens: 100 }), generateContent: async () => { calls++; return { text: 'invalid' }; } });
  await assert.rejects(() => reader.read(input));
  assert.equal(calls, 1);
});

test('pilot config needs opt-in and closes when reviewed pricing expires', () => {
  assert.throws(() => requirePilotReaderConfig({ GEMINI_API_KEY: 'key' }));
  assert.throws(() => requirePilotReaderConfig({ GEMINI_API_KEY: 'key', PILOT_READINGS_ENABLED: 'true' }, Date.parse('2026-12-01')));
  assert.equal(requirePilotReaderConfig({ GEMINI_API_KEY: 'key', PILOT_READINGS_ENABLED: 'true' }, Date.parse('2026-09-08')).model, PILOT_MODEL);
});

test('pilot identifies truncated output before parsing and never retries, even for parseable JSON', async (t) => {
  const logs: string[] = [];
  t.mock.method(console, 'error', (...args) => { logs.push(JSON.stringify(args)); });
  for (const text of ['{"findings":[ PRIVATE_SOURCE_TEXT', evidence]) {
    let calls = 0;
    const reader = new PilotPlanReader({ countTokens: async () => ({ totalTokens: 6281 }),
      generateContent: async () => { calls++; return { text, candidates: [{ finishReason: 'MAX_TOKENS' }] }; },
    });
    await assert.rejects(reader.read(input), (error: unknown) => error instanceof AiProviderError
      && error.diagnostic.code === 'provider_output_truncated' && error.diagnostic.stage === 'parse');
    assert.equal(calls, 1);
  }
  assert.equal(logs.length, 2);
  assert.ok(logs.every(log => !log.includes('PRIVATE_SOURCE_TEXT') && !log.includes('VERIFY IN FIELD')));
});

test('bounded pilot findings preserve source evidence, drop unsupported quantities and disclose partial coverage', async () => {
  const raw = JSON.parse(evidence);
  raw.findings = Array.from({ length: 16 }, (_, index) => ({
    page_number: 1, finding_type: 'material', label: `Source item ${index}`, source_excerpt: '12 EA BLOCKS',
    quantity: 12, unit: 'EA', confidence: 0.9, geometry: { bbox: [0.1, 0.1, 0.2, 0.2], area: 'Printed room', pricing: [{ cost: 10000 }] },
  }));
  raw.findings.unshift({ ...raw.findings[0], label: 'Unsupported quantity', source_excerpt: null });
  const reader = new PilotPlanReader({ countTokens: async () => ({ totalTokens: 7000 }),
    generateContent: async () => ({ text: JSON.stringify(raw), candidates: [{ finishReason: 'STOP' }] }),
  });
  const result = await reader.read({ ...input, requestedTrades: ['Framing', 'Concrete', 'Drywall', 'Electrical', 'Plumbing', 'HVAC', 'Finishes'] });
  assert.equal(result.findings.length, PILOT_MAX_FINDINGS);
  assert.equal(result.findings[0].label, 'Source item 0');
  assert.equal(result.findings[0].quantity, 12);
  assert.equal(result.findings[0].unit, 'EA');
  assert.equal(result.findings[0].source_excerpt, '12 EA BLOCKS');
  assert.equal(result.findings[0].geometry.pricing, undefined);
  assert.ok(result.summary.limitations.includes(PILOT_COVERAGE_NOTICE));
  assert.ok(result.summary.limitations.some(value => value.includes('dropped')));
});

test('pilot blocked finish reasons and empty sanitized findings remain failures without substitute data', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [text, finishReason, code] of [
    [evidence, 'SAFETY', 'provider_invalid_output'],
    ['{"summary":{"sheet_count":1},"findings":[]}', 'STOP', 'provider_empty_output'],
  ]) {
    let calls = 0;
    const reader = new PilotPlanReader({ countTokens: async () => ({ totalTokens: 100 }), generateContent: async () => {
      calls++; return { text, candidates: [{ finishReason }] };
    } });
    await assert.rejects(reader.read(input), (error: unknown) => error instanceof AiProviderError && error.diagnostic.code === code);
    assert.equal(calls, 1);
  }
});

test('real SDK sends the bounded pilot schema and accounts for schema text before one generation', async (t) => {
  const calls: Array<{ url: string; body: any }> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    if (String(url).includes(':countTokens')) return Response.json({ totalTokens: 7000 });
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: evidence }] }, finishReason: 'STOP' }] });
  });
  const result = await new PilotPlanReader(await createGeminiClient('sdk-fixture-not-live')).read(input);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /:countTokens$/);
  assert.equal(calls[0].body.contents.at(-1).parts[0].text, JSON.stringify(PILOT_RESPONSE_SCHEMA));
  assert.match(calls[1].url, /:generateContent$/);
  assert.deepEqual(calls[1].body.generationConfig.responseJsonSchema, PILOT_RESPONSE_SCHEMA);
  assert.equal(calls[1].body.generationConfig.maxOutputTokens, 4096);
  assert.equal(calls[1].body.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
  assert.equal(result.findings[0].source_excerpt, 'VERIFY IN FIELD');
});
