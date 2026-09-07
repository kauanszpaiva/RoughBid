import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader, MAX_INLINE_PLAN_BYTES } from '../src/ai-plan/gemini.ts';
import { sanitizePlanReadingResult } from '../src/ai-plan/types.ts';
import type { UsageEvent } from '../src/ai-plan/pilot.ts';

const model = 'gemini-2.5-flash';
const execution = { attempt: 1, model, max_input_tokens: 5000, max_output_tokens: 1000, reserved_usd: 0.05 };
const usageMetadata = { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 };
const findingBody = JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ finding_type: 'room', page_number: 1, label: 'Kitchen', source_excerpt: 'KITCHEN', geometry: {} }] });

const baseInput = {
  fileBytes: new Uint8Array([1, 2, 3]),
  mimeType: 'application/pdf',
  sheetName: 'Sheet A-101',
  requestedTrades: ['Framing', 'Concrete'],
  scope: 'Residential addition',
  execution,
};

test('large plans use the Files API and remove the temporary provider file after reading', async () => {
  let uploaded = false;
  let deleted = false;
  const client = {
    countTokens: async () => ({ totalTokens: 100 }),
    files: {
      upload: async ({file}: {file: Blob}) => { uploaded = true; assert.equal(file.size,MAX_INLINE_PLAN_BYTES+1); return {name:'files/test',uri:'https://provider.test/test',state:'ACTIVE'}; },
      get: async () => { throw new Error('Active files do not need polling'); },
      delete: async ({name}: {name:string}) => { assert.equal(name,'files/test'); deleted = true; },
    },
    generateContent: async ({contents}: {contents: unknown[]}) => {
      assert.equal(uploaded,true);
      assert.ok(contents.some((c:any) => c.fileData?.fileUri === 'https://provider.test/test'));
      assert.ok(!contents.some((c:any) => c.inlineData));
      return {usageMetadata,text:JSON.stringify({summary:{sheet_count:1},findings:[{finding_type:'room',page_number:1,label:'Kitchen',source_excerpt:'KITCHEN',geometry:{bbox:[0.1,0.1,0.2,0.2]}}]})};
    },
  };
  const result = await new GeminiPlanReader(client,[model]).read({...baseInput,fileBytes:new Uint8Array(MAX_INLINE_PLAN_BYTES+1)});
  assert.equal(result.findings[0]?.finding_type,'room');
  assert.equal(deleted,true);
});

test('a failed large-file preparation is cleaned up without inference', async () => {
  let deleted = false;
  const client = {
    countTokens: async () => ({ totalTokens: 100 }),
    files: {
      upload: async () => ({name:'files/test',state:'FAILED'}),
      get: async () => ({name:'files/test',state:'FAILED'}),
      delete: async () => {deleted=true;},
    },
    generateContent: async () => {throw new Error('Unexpected inference');},
  };
  await assert.rejects(new GeminiPlanReader(client,[model]).read({...baseInput,fileBytes:new Uint8Array(MAX_INLINE_PLAN_BYTES+1)}),/could not be prepared/);
  assert.equal(deleted,true);
});

test('reads a plan via the injected Gemini client and returns its findings', async () => {
  let calledWith: { model: string; contents: unknown[] } | undefined;
  const client = {
    countTokens: async () => ({ totalTokens: 100 }),
    generateContent: async (args: { model: string; contents: unknown[] }) => {
      calledWith = args;
      return {
        usageMetadata,
        text: JSON.stringify({
          summary: { sheet_count: 2, detected_trade_scope: ['Framing'], scale_status: 'detected' },
          findings: [
            { page_number: 1, finding_type: 'material', label: '2x6 Stud Wall', value_text: null, quantity: 96, unit: 'LF', confidence: 0.9, source_excerpt: 'Sheet A-101 wall schedule' },
          ],
        }),
      };
    },
  };
  const reader = new GeminiPlanReader(client, [model]);
  const result = await reader.read(baseInput);

  assert.equal(calledWith?.model, model);
  assert.ok(calledWith?.contents.some((c) => typeof c === 'object' && c !== null && 'inlineData' in c));
  assert.equal(result.summary.sheet_count, 2);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.label, '2x6 Stud Wall');
  assert.equal(result.summary.limitations.length, 0);
});

test('multiple model candidates are rejected before any token count or inference', async () => {
  const attempts: string[] = [];
  const client = {
    countTokens: async () => { attempts.push('count'); return { totalTokens: 100 }; },
    generateContent: async (args: { model: string }) => {
      attempts.push(args.model);
      if (args.model === 'model-a') return { text: JSON.stringify({ summary: {}, findings: [] }) };
      return { text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'material', label: 'Drywall', quantity: 100, unit: 'SF', confidence: 0.8, source_excerpt: 'ok' }] }) };
    },
  };
  const reader = new GeminiPlanReader(client, ['model-a', 'model-b']);
  await assert.rejects(reader.read(baseInput), (error: any) => error.status === 503);
  assert.deepEqual(attempts, []);
});

test('missing Gemini credentials fail without invented output', async () => {
  await assert.rejects(new GeminiPlanReader(null).read(baseInput), (error: any) => error.status === 503 && /manual quantities/.test(error.message));
});
test('Gemini outage fails without invented output', async () => {
  let calls=0;
  const events: UsageEvent[] = [];
  const client = { countTokens: async () => ({ totalTokens: 100 }), generateContent: async (args: any) => {
    calls++; assert.equal(args.config.httpOptions.retryOptions.attempts, 1);
    assert.equal(events.at(-1)?.outcome, 'unknown');
    throw new Error('rate limited');
  } };
  await assert.rejects(new GeminiPlanReader(client, [model]).read({...baseInput, onUsage: event => events.push(event)}), /No quantities were generated/);
  assert.equal(calls,1);
  assert.deepEqual(events.map(event => event.outcome), ['no_provider', 'unknown']);
});

test('missing token-count capability blocks all inference', async () => {
  let generated = false;
  const reader = new GeminiPlanReader({ generateContent: async () => { generated = true; return { text: findingBody, usageMetadata }; } }, [model]);
  await assert.rejects(reader.read(baseInput), (error: any) => error.status === 503);
  assert.equal(generated, false);
});

test('unknown, invalid or over-budget token counts never dispatch generation', async () => {
  for (const totalTokens of [undefined, 0, -1, 1.5, NaN, execution.max_input_tokens + 1]) {
    let generated = false;
    const events: UsageEvent[] = [];
    const client = {
      countTokens: async () => ({ totalTokens }),
      generateContent: async () => { generated = true; return { text: findingBody, usageMetadata }; },
    };
    await assert.rejects(new GeminiPlanReader(client, [model]).read({ ...baseInput, onUsage: event => events.push(event) }), (error: any) => error.status === 413);
    assert.equal(generated, false);
    assert.deepEqual(events.map(event => event.outcome), ['no_provider']);
  }
});

test('a reservation for a different model or absent spending authorization cannot call Gemini', async () => {
  let calls = 0;
  const client = { countTokens: async () => { calls++; return { totalTokens: 100 }; }, generateContent: async () => { calls++; return {}; } };
  for (const reserved of [undefined, { ...execution, model: 'gemini-2.5-pro' }, { ...execution, attempt: 3 }, { ...execution, model: 'gemini-latest' }]) {
    await assert.rejects(new GeminiPlanReader(client, [model]).read({ ...baseInput, execution: reserved }), (error: any) => error.status === 503);
  }
  assert.equal(calls, 0);
});

test('counting and generation share one pinned model and limits; thoughts are metered as output', async () => {
  const events: UsageEvent[] = [];
  const calls: string[] = [];
  const client = {
    countTokens: async (args: any) => { calls.push(`count:${args.model}`); assert.equal(args.config.httpOptions.retryOptions.attempts, 1); return { totalTokens: 100 }; },
    generateContent: async (args: any) => {
      calls.push(`generate:${args.model}`);
      assert.equal(events.at(-1)?.outcome, 'unknown');
      assert.equal(args.config.maxOutputTokens, execution.max_output_tokens);
      assert.equal(args.config.thinkingConfig.thinkingBudget, 0);
      assert.equal(args.config.httpOptions.retryOptions.attempts, 1);
      return { text: findingBody, modelVersion: model, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 } };
    },
  };
  const result = await new GeminiPlanReader(client, [model]).read({ ...baseInput, onUsage: event => events.push(event) });
  assert.equal(result.findings.length, 1);
  assert.deepEqual(calls, [`count:${model}`, `generate:${model}`]);
  assert.deepEqual(events.at(-1), { outcome: 'measured', usage: { model, model_version: model, input_tokens: 100, output_tokens: 75 } });
});

test('missing or contradictory metadata leaves the dispatched attempt unknown without retry', async () => {
  for (const reported of [undefined, { promptTokenCount: 100 }, { ...usageMetadata, totalTokenCount: 151 }, { ...usageMetadata, toolUsePromptTokenCount: 1 }]) {
    let generated = 0;
    const events: UsageEvent[] = [];
    const client = { countTokens: async () => ({ totalTokens: 100 }), generateContent: async () => { generated++; return { text: findingBody, usageMetadata: reported }; } };
    await assert.rejects(new GeminiPlanReader(client, [model]).read({ ...baseInput, onUsage: event => events.push(event) }), /No quantities were generated/);
    assert.equal(generated, 1);
    assert.equal(events.at(-1)?.outcome, 'unknown');
  }
});

test('empty findings and measured over-budget output fail after exactly one inference', async () => {
  for (const response of [
    { text: JSON.stringify({ summary: {}, findings: [] }), usageMetadata },
    { text: findingBody, usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 990, thoughtsTokenCount: 11, totalTokenCount: 1101 } },
  ]) {
    let generated = 0;
    const events: UsageEvent[] = [];
    const client = { countTokens: async () => ({ totalTokens: 100 }), generateContent: async () => { generated++; return response; } };
    await assert.rejects(new GeminiPlanReader(client, [model]).read({ ...baseInput, onUsage: event => events.push(event) }), /No quantities were generated/);
    assert.equal(generated, 1);
    assert.equal(events.at(-1)?.outcome, 'measured');
  }
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
