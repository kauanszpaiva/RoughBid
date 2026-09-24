import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { GeminiPlanReader, geminiSweepOptionsFromEnv, type GeminiSweepOptions } from '../src/ai-plan/gemini.ts';
import { AiProviderError } from '../src/ai-plan/provider-errors.ts';

async function planPages(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 1; index <= count; index += 1) doc.addPage([200 + index, 400]);
  return doc.save();
}

const sweep = (overrides: Partial<GeminiSweepOptions> = {}): GeminiSweepOptions => ({
  batchPages: 2, maxBatches: 25, maxTotalFindings: 400, timeoutMs: 60_000, ...overrides,
});

const base = { mimeType: 'application/pdf', sheetName: 'Permit set.pdf', requestedTrades: ['Framing'], scope: 'Full takeoff' };

/** Reports how many pages each request actually carried, and the prompt it was given. */
function windowClient(
  onCall: (attachedPages: number, prompt: string) => void,
  findingsFor: (attachedPages: number) => unknown[],
) {
  return {
    generateContent: async ({ contents }: { contents: any[] }) => {
      const inline = contents.find((part: any) => part?.inlineData) as any;
      const bytes = new Uint8Array(Buffer.from(inline.inlineData.data, 'base64'));
      const attachedPages = (await PDFDocument.load(bytes)).getPageCount();
      onCall(attachedPages, String(contents[0]?.text ?? ''));
      return {
        text: JSON.stringify({
          summary: { sheet_count: attachedPages, detected_trade_scope: ['Framing'], scale_status: 'detected' },
          findings: findingsFor(attachedPages),
        }),
      };
    },
  };
}

const roomOn = (pageNumber: number, label = 'Room') => ({
  page_number: pageNumber, finding_type: 'room', label, source_excerpt: `${label} 100 SF`, quantity: 100, unit: 'SF',
});

test('a large set is read one window at a time and its findings are renumbered to physical pages', async () => {
  const attached: number[] = [];
  const prompts: string[] = [];
  const reader = new GeminiPlanReader(
    windowClient((pages, prompt) => { attached.push(pages); prompts.push(prompt); }, () => [roomOn(1)]),
    ['test-model'],
    sweep(),
  );

  const result = await reader.read({ ...base, fileBytes: await planPages(5), pageCount: 5 });

  // 5 pages in windows of 2: one request per window, carrying only its own pages.
  assert.deepEqual(attached, [2, 2, 1]);
  // Local page 1 of each window becomes the real physical page.
  assert.deepEqual(result.findings.map(finding => finding.page_number), [1, 3, 5]);
  assert.equal(result.summary.sheet_count, 5);
  assert.equal(result.summary.scale_status, 'detected');
  assert.ok(result.summary.limitations.some(note => /read as 3 separate provider request\(s\)/.test(note)));
  // A window is told its pages are local, so the model cannot cite a sheet it was not given.
  assert.ok(prompts.every(prompt => /first page of this request is page 1/.test(prompt)));
  assert.ok(prompts[0]!.includes('Report page_number 1-2'));
  assert.ok(prompts[2]!.includes('Report page_number 1-1'));
});

test('a set that fits one request is still a single request over the untouched PDF', async () => {
  const attached: number[] = [];
  const reader = new GeminiPlanReader(
    windowClient((pages, prompt) => { attached.push(pages); assert.doesNotMatch(prompt, /physical PDF pages/); }, () => [roomOn(2)]),
    ['test-model'],
    sweep({ batchPages: 8 }),
  );
  const result = await reader.read({ ...base, fileBytes: await planPages(5), pageCount: 5 });

  assert.deepEqual(attached, [5]);
  assert.equal(result.findings[0]!.page_number, 2);
  assert.equal(reader.sweeps(5), false);
  assert.equal(reader.sweeps(9), true);
  assert.equal(reader.sweeps(undefined), false);
  // No page count from preflight means no reliable sweep, so it stays one request.
  const unknown = new GeminiPlanReader(windowClient(() => {}, () => [roomOn(1)]), ['test-model'], sweep());
  await unknown.read({ ...base, fileBytes: await planPages(5) });
  assert.equal(unknown.sweeps(undefined), false);
});

test('a finding that cites a page outside its own window is dropped and counted', async () => {
  let call = 0;
  const reader = new GeminiPlanReader({
    generateContent: async () => {
      call += 1;
      const findings = call === 1
        ? [
            { page_number: 1, finding_type: 'scope_note', label: 'In window', source_excerpt: 'NOTE' },
            { page_number: 4, finding_type: 'scope_note', label: 'Outside window', source_excerpt: 'NOTE' },
          ]
        : [{ page_number: 1, finding_type: 'scope_note', label: 'In window', source_excerpt: 'NOTE' }];
      return { text: JSON.stringify({ summary: { sheet_count: 2 }, findings }) };
    },
  }, ['test-model'], sweep());
  const result = await reader.read({ ...base, fileBytes: await planPages(4), pageCount: 4 });

  assert.deepEqual(result.findings.map(finding => finding.label), ['In window', 'In window']);
  assert.deepEqual(result.findings.map(finding => finding.page_number), [1, 3]);
  assert.ok(result.summary.limitations.some(note => /cited a page outside that batch and were dropped/.test(note)));
});

test('a failed window is disclosed and the rest of the set is still read', async () => {
  let call = 0;
  const reader = new GeminiPlanReader({
    generateContent: async () => {
      call += 1;
      if (call === 2) throw Object.assign(new Error('provider unavailable'), { status: 500 });
      return { text: JSON.stringify({ summary: { sheet_count: 2 }, findings: [roomOn(1)] }) };
    },
  }, ['test-model'], sweep());

  const result = await reader.read({ ...base, fileBytes: await planPages(6), pageCount: 6 });

  assert.deepEqual(result.findings.map(finding => finding.page_number), [1, 5]);
  assert.ok(result.summary.limitations.some(note => /1 of 3 batch\(es\) failed/.test(note)));
  assert.ok(result.summary.limitations.some(note => /Physical pages 3-4 could not be read/.test(note)));
  // The classified reason only: no provider message, no private text.
  assert.ok(!result.summary.limitations.some(note => /provider unavailable/.test(note)));
});

test('a sweep that produces no findings at all rethrows so another reader can run', async () => {
  const reader = new GeminiPlanReader({
    generateContent: async () => { throw Object.assign(new Error('nope'), { status: 500 }); },
  }, ['test-model'], sweep());

  await assert.rejects(
    reader.read({ ...base, fileBytes: await planPages(4), pageCount: 4 }),
    (error: unknown) => error instanceof AiProviderError,
  );
});

test('the batch cap names the pages that were never read', async () => {
  const reader = new GeminiPlanReader(
    windowClient(() => {}, () => [roomOn(1)]),
    ['test-model'],
    sweep({ batchPages: 2, maxBatches: 1 }),
  );
  const result = await reader.read({ ...base, fileBytes: await planPages(6), pageCount: 6 });

  assert.deepEqual(result.findings.map(finding => finding.page_number), [1]);
  assert.ok(result.summary.limitations.some(note => /Physical pages 3-6 were never read/.test(note)));
});

test('merged findings are capped and the cap is disclosed', async () => {
  const reader = new GeminiPlanReader(
    windowClient(() => {}, () => [roomOn(1)]),
    ['test-model'],
    sweep({ batchPages: 2, maxTotalFindings: 1 }),
  );
  const result = await reader.read({ ...base, fileBytes: await planPages(4), pageCount: 4 });

  assert.equal(result.findings.length, 1);
  assert.ok(result.summary.limitations.some(note => /Findings capped at 1 for this set \(2 were reported across all batches\)/.test(note)));
});

test('the sweep is configurable and can be switched off', () => {
  assert.deepEqual(geminiSweepOptionsFromEnv({}), { batchPages: 8, maxBatches: 25, maxTotalFindings: 400, timeoutMs: 120_000 });
  assert.deepEqual(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_BATCH_PAGES: '4', AI_PLAN_GEMINI_MAX_BATCHES: '3', AI_PLAN_GEMINI_TIMEOUT_MS: '60000' }), {
    batchPages: 4, maxBatches: 3, maxTotalFindings: 400, timeoutMs: 60_000,
  });
  assert.deepEqual(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_SWEEP: 'false' }).batchPages, 0);
  // Bounded, never unbounded, and nonsense falls back instead of widening.
  assert.equal(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_BATCH_PAGES: '9999' }).batchPages, 50);
  assert.equal(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_MAX_BATCHES: '9999' }).maxBatches, 60);
  assert.equal(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_TIMEOUT_MS: '9999999' }).timeoutMs, 300_000);
  assert.equal(geminiSweepOptionsFromEnv({ AI_PLAN_GEMINI_BATCH_PAGES: 'abc' }).batchPages, 8);
});
