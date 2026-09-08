import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiPlanReader, MAX_INLINE_PLAN_BYTES } from '../src/ai-plan/gemini.ts';
import { sanitizePlanReadingResult } from '../src/ai-plan/types.ts';

const baseInput = {
  fileBytes: new Uint8Array([1, 2, 3]),
  mimeType: 'application/pdf',
  sheetName: 'Sheet A-101',
  requestedTrades: ['Framing', 'Concrete'],
  scope: 'Residential addition',
};

test('large plans use the Files API and remove the temporary provider file after reading', async () => {
  let uploaded = false;
  let deleted = false;
  const client = {
    files: {
      upload: async ({file}: {file: Blob}) => { uploaded = true; assert.equal(file.size,MAX_INLINE_PLAN_BYTES+1); return {name:'files/test',uri:'https://provider.test/test',state:'ACTIVE'}; },
      get: async () => { throw new Error('Active files do not need polling'); },
      delete: async ({name}: {name:string}) => { assert.equal(name,'files/test'); deleted = true; },
    },
    generateContent: async ({contents}: {contents: unknown[]}) => {
      assert.equal(uploaded,true);
      assert.ok(contents.some((c:any) => c.fileData?.fileUri === 'https://provider.test/test'));
      assert.ok(!contents.some((c:any) => c.inlineData));
      return {text:JSON.stringify({summary:{sheet_count:1},findings:[{finding_type:'room',page_number:1,label:'Kitchen',source_excerpt:'KITCHEN',geometry:{bbox:[0.1,0.1,0.2,0.2]}}]})};
    },
  };
  const result = await new GeminiPlanReader(client,['test-model']).read({...baseInput,fileBytes:new Uint8Array(MAX_INLINE_PLAN_BYTES+1)});
  assert.equal(result.findings[0]?.finding_type,'room');
  assert.equal(deleted,true);
});

test('a failed large-file preparation is cleaned up without inference', async () => {
  let deleted = false;
  const client = {
    files: {
      upload: async () => ({name:'files/test',state:'FAILED'}),
      get: async () => ({name:'files/test',state:'FAILED'}),
      delete: async () => {deleted=true;},
    },
    generateContent: async () => {throw new Error('Unexpected inference');},
  };
  await assert.rejects(new GeminiPlanReader(client,['test-model']).read({...baseInput,fileBytes:new Uint8Array(MAX_INLINE_PLAN_BYTES+1)}),/could not be prepared/);
  assert.equal(deleted,true);
});

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

test('Gemini 3 requests use supported thinking settings without legacy sampling parameters', async () => {
  const reader = new GeminiPlanReader({ generateContent: async ({config}) => {
    assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'LOW' });
    assert.equal('temperature' in config, false);
    assert.equal(config.maxOutputTokens, 8000);
    return { text: JSON.stringify({ summary: { sheet_count: 1 }, findings: [{ page_number: 1, finding_type: 'room', label: 'Kitchen', source_excerpt: 'KITCHEN' }] }) };
  } }, ['gemini-3.8-flash']);
  assert.equal((await reader.read(baseInput)).findings.length, 1);
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

test('missing Gemini credentials fail without invented output', async () => {
  await assert.rejects(new GeminiPlanReader(null).read(baseInput), (error: any) => error.status === 503 && /manual quantities/.test(error.message));
});
test('Gemini outage fails without invented output', async () => {
  let calls=0;
  const client = { generateContent: async () => { calls++; throw new Error('rate limited'); } };
  await assert.rejects(new GeminiPlanReader(client, ["model-a"]).read(baseInput), /No quantities were generated/);
  assert.equal(calls,1);
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
