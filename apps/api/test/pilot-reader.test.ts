import test from 'node:test';
import assert from 'node:assert/strict';
import { PilotPlanReader, PILOT_MODEL, requirePilotReaderConfig } from '../src/ai-plan/pilot-reader.ts';

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
    return { totalTokens: 32_000 };
  }, generateContent: async args => {
    calls++;
    assert.equal(args.model, PILOT_MODEL);
    assert.equal(args.config.maxOutputTokens, 4096);
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