import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudePlanReader, type ClaudeMessagesClient } from '../src/ai-plan/claude.ts';

const baseInput = {
  fileBytes: new Uint8Array([1, 2, 3]),
  mimeType: 'application/pdf',
  sheetName: 'Sheet A-101',
  requestedTrades: ['Framing'],
  scope: 'Residential addition',
};

test('reads a plan via the injected Claude client, sending the PDF as a document content block', async () => {
  let calledWith: { model: string; content: unknown[] } | undefined;
  const client: ClaudeMessagesClient = {
    createMessage: async (args) => {
      calledWith = args;
      return {
        text: JSON.stringify({
          summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'detected' },
          findings: [
            { page_number: 1, finding_type: 'material', label: '2x6 Stud Wall', value_text: null, quantity: 96, unit: 'LF', confidence: 0.9, source_excerpt: 'Sheet A-101 wall schedule' },
          ],
        }),
      };
    },
  };
  const reader = new ClaudePlanReader(client, 'claude-haiku-4-5-20251001');
  const result = await reader.read(baseInput);

  assert.equal(calledWith?.model, 'claude-haiku-4-5-20251001');
  const documentBlock = calledWith?.content.find((c) => typeof c === 'object' && c !== null && (c as { type?: string }).type === 'document') as { source?: { media_type?: string } } | undefined;
  assert.equal(documentBlock?.source?.media_type, 'application/pdf');
  assert.equal(result.findings.length, 1);
  assert.equal(result.summary.synthetic, undefined);
});

test('strips an accidental markdown code fence before parsing', async () => {
  const client: ClaudeMessagesClient = {
    createMessage: async () => ({
      text: '```json\n' + JSON.stringify({ summary: {}, findings: [{ page_number: 1, finding_type: 'material', label: 'Drywall', quantity: 10, unit: 'SF', confidence: 0.8, source_excerpt: 'ok' }] }) + '\n```',
    }),
  };
  const reader = new ClaudePlanReader(client);
  const result = await reader.read(baseInput);
  assert.equal(result.findings.length, 1);
});

test('falls back to a clearly-labeled synthetic takeoff when no client is configured', async () => {
  const reader = new ClaudePlanReader(null);
  const result = await reader.read(baseInput);
  assert.equal(result.summary.synthetic, true);
  assert.ok(result.summary.limitations.some((l) => l.includes('ANTHROPIC_API_KEY is not configured')));
});

test('falls back to synthetic (without retrying) when the API call throws', async () => {
  let calls = 0;
  const client: ClaudeMessagesClient = { createMessage: async () => { calls += 1; throw new Error('rate limited'); } };
  const reader = new ClaudePlanReader(client);
  const result = await reader.read(baseInput);
  assert.equal(calls, 1); // a single attempt only — this is a paid fallback, never a retry loop
  assert.equal(result.summary.synthetic, true);
});
