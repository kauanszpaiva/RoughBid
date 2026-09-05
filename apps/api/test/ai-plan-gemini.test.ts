import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import { sanitizePlanReadingResult } from '../src/ai-plan/types.ts';

const baseInput = {
  fileBytes: new Uint8Array([1, 2, 3]),
  mimeType: 'application/pdf',
  sheetName: 'Sheet A-101',
  requestedTrades: ['Framing', 'Concrete'],
  scope: 'Residential addition',
};

test('reads a plan via the injected Gemini client and returns its findings', async () => {
  let calledWith: { model: string; contents: unknown[] } | undefined;
  const client = {
    generateContent: async (args: { model: string; contents: unknown[] }) => {
      calledWith = args;
      return {
        text: JSON.stringify({
          summary: { sheet_count: 2, detected_trade_scope: ['Framing'], scale_status: 'detected' },
          findings: [
            { page_number: 1, finding_type: 'material', label: '2x6 Stud Wall', value_text: null, quantity: 96, unit: 'LF', confidence: 0.9, source_excerpt: 'Sheet A-101 wall schedule' },
          ],
        }),
      };
    },
  };
  const reader = new GeminiPlanReader(client, ['gemini-3.8-flash']);
  const result = await reader.read(baseInput);

  assert.equal(calledWith?.model, 'gemini-3.8-flash');
  assert.ok(calledWith?.contents.some((c) => typeof c === 'object' && c !== null && 'inlineData' in c));
  assert.equal(result.summary.sheet_count, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.label, '2x6 Stud Wall');
  assert.equal(result.summary.limitations.length, 0);
});

test('tries the next candidate model when the first returns no findings, before falling back', async () => {
  const attempts: string[] = [];
  const client = {
    generateContent: async (args: { model: string }) => {
      attempts.push(args.model);
      if (args.model === 'model-a') return { text: JSON.stringify({ summary: {}, findings: [] }) };
      return { text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'material', label: 'Drywall', quantity: 100, unit: 'SF', confidence: 0.8, source_excerpt: 'ok' }] }) };
    },
  };
  const reader = new GeminiPlanReader(client, ['model-a', 'model-b']);
  const result = await reader.read(baseInput);

  assert.deepEqual(attempts, ['model-a', 'model-b']);
  assert.equal(result.findings.length, 1);
});

test('falls back to a clearly-labeled synthetic takeoff when no client is configured', async () => {
  const reader = new GeminiPlanReader(null);
  const result = await reader.read(baseInput);

  assert.ok(result.findings.length > 0);
  assert.ok(result.summary.limitations.some((l) => l.includes('GEMINI_API_KEY is not configured')));
  // The synthetic fallback still exercises both finding types the pricing pipeline expects.
  assert.ok(result.findings.some((f) => f.finding_type === 'material'));
  assert.ok(result.findings.some((f) => f.finding_type === 'labor'));
});

test('falls back to a clearly-labeled synthetic takeoff when every model call throws', async () => {
  const client = { generateContent: async () => { throw new Error('rate limited'); } };
  const reader = new GeminiPlanReader(client, ['model-a']);
  const result = await reader.read(baseInput);

  assert.ok(result.summary.limitations.some((l) => l.includes('temporary outage or rate limit')));
});

test('sanitizePlanReadingResult drops a quantity without a verbatim source excerpt', () => {
  const result = sanitizePlanReadingResult({
    summary: { sheet_count: 1 },
    findings: [
      { page_number: 1, finding_type: 'material', label: 'Suspicious Material', quantity: 50, unit: 'SF', confidence: 0.9 },
      { page_number: 1, finding_type: 'material', label: 'Trusted Material', quantity: 50, unit: 'SF', confidence: 0.9, source_excerpt: 'Sheet A1 schedule' },
    ],
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.label, 'Trusted Material');
  assert.ok(result.summary.limitations.some((l) => l.includes('dropped')));
});

test('sanitizePlanReadingResult drops a quantity with a unit outside the allowed imperial list', () => {
  const result = sanitizePlanReadingResult({
    summary: {},
    findings: [
      { page_number: 1, finding_type: 'material', label: 'Metric Item', quantity: 10, unit: 'M2', confidence: 0.9, source_excerpt: 'Sheet A1' },
    ],
  });
  assert.equal(result.findings.length, 0);
});
