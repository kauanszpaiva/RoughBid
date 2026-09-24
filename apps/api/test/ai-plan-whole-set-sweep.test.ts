import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { OpenAiCompatibleVisionPlanReader, requireOpenAiVisionConfig } from '../src/ai-plan/openai-vision.ts';
import { withUsageMeter } from '../src/owner-usage/meter.ts';

async function planBytes(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 1; index <= pages; index += 1) doc.addPage([612, 792]).drawText(`SHEET ${index}`, { x: 40, y: 700, size: 12 });
  return doc.save();
}

const openAiConfig = (env: Record<string, string | undefined> = {}) => requireOpenAiVisionConfig({
  OPENAI_PLAN_READING_ENABLED: 'true',
  OPENAI_API_KEY: 'sk-plan-reading-key',
  OPENAI_MODEL: 'gpt-4.1',
  // Small windows keep these fixtures readable; the default is asserted separately.
  AI_PLAN_OPENAI_BATCH_PAGES: '5',
  ...env,
});

/** A finding for `page`, with a quantity so the sanitizer validates its page. */
const finding = (page: number, label: string) => ({
  page_number: page, finding_type: 'measurement', label, value_text: '12 LF',
  quantity: 12, unit: 'LF', confidence: 0.8, source_excerpt: '12 LF partition',
});

const answer = (sheetCount: number, findings: unknown[], extra: Record<string, unknown> = {}) => ({
  summary: { sheet_count: sheetCount, detected_trade_scope: ['Framing'], scale_status: 'detected', limitations: [], ...extra },
  findings,
});

/** Wraps a plan-reading answer the way the provider actually returns it. */
const envelope = (payload: unknown) => ({
  id: 'chatcmpl-plan',
  usage: { prompt_tokens: 100, completion_tokens: 50 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }],
});

/** A quantity-free note survives the sanitizer with its page intact, so the caller must reject a bad page itself. */
const note = (page: number, label: string) => ({
  page_number: page, finding_type: 'scope_note', label, value_text: 'note only',
  quantity: null, unit: null, confidence: 0.6, source_excerpt: 'PROVIDE FIRE RATED ASSEMBLY',
});

/** Fake OpenAI endpoint: records each request's body and answered window size. */
function recorder(responses: Array<(body: any, call: number) => { status?: number; json?: unknown }>) {
  const calls: Array<{ body: any; pages: number }> = [];
  const fetcher = (async (_url: string, init: any) => {
    const body = JSON.parse(String(init?.body));
    const file = body.messages?.[1]?.content?.find((part: any) => part?.type === 'file');
    const dataUrl: string = file?.file?.file_data ?? '';
    const bytes = Uint8Array.from(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64'));
    const attachment = await PDFDocument.load(bytes);
    calls.push({ body, pages: attachment.getPageCount() });
    const scripted = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    const outcome = scripted(body, calls.length);
    if (outcome.status && outcome.status >= 400) return { ok: false, status: outcome.status, json: async () => ({}) } as any;
    return { ok: true, status: 200, json: async () => envelope(outcome.json ?? answer(attachment.getPageCount(), [finding(1, 'Partition')])) } as any;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test('a set larger than one request is swept window by window with physical numbering restored', async () => {
  const bytes = await planBytes(12);
  // Each batch answers for one page per sheet it was given, using local numbering.
  const { fetcher, calls } = recorder([
    () => ({ json: answer(5, [finding(1, 'Batch one page one'), finding(5, 'Batch one page five')]) }),
    () => ({ json: answer(5, [finding(1, 'Batch two page one')]) }),
    () => ({ json: answer(2, [finding(2, 'Batch three page two')]) }),
  ]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });

  assert.equal(calls.length, 3, 'one metered request per window');
  assert.deepEqual(calls.map(call => call.pages), [5, 5, 2], 'each request carries exactly its own window pages');
  assert.match(calls[0]!.body.messages[1].content[0].text, /physical PDF pages 1-5 of a larger set/);
  assert.match(calls[0]!.body.messages[1].content[0].text, /Report page_number 1-5/);
  assert.match(calls[2]!.body.messages[1].content[0].text, /physical PDF pages 11-12/);
  assert.ok(calls[1]!.body.messages[1].content.some((part: any) => part?.type === 'file'));
  assert.equal(calls[1]!.body.model, 'gpt-4.1');

  assert.equal(result.summary.sheet_count, 12);
  assert.deepEqual(result.findings.map(item => [item.page_number, item.label]), [
    [1, 'Batch one page one'], [5, 'Batch one page five'], [6, 'Batch two page one'], [12, 'Batch three page two'],
  ]);
  assert.equal(result.summary.limitations.some(note => /read as 3 separate provider request/.test(note)), true);
  assert.equal(result.summary.human_review_required, true);
});

test('each window is reserved against the company breaker on its own', async () => {
  const bytes = await planBytes(12);
  const { fetcher } = recorder([() => ({ json: answer(5, [finding(1, 'Partition')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  const reservations: Array<Record<string, unknown>> = [];
  const writer = {
    from: () => ({ insert: async () => ({ error: null }), update: () => ({ eq: async () => ({ error: null }) }) }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'reserve_provider_spend') reservations.push(args);
      return { data: {}, error: null };
    },
  };

  await withUsageMeter(
    { writer, userId: 'u', workspaceId: 'w', projectId: 'p', jobId: 'j', billing: 'paid' },
    () => reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 }),
  );

  assert.equal(reservations.length, 3, 'a sweep must reserve once per provider call, not once per set');
  assert.deepEqual(reservations.map(entry => entry.p_provider), ['openai', 'openai', 'openai']);
  assert.equal(new Set(reservations.map(entry => entry.p_event_id)).size, 3, 'each call gets its own reservation identity');
});

test('a set that fits one request is still read in a single request', async () => {
  const bytes = await planBytes(4);
  const { fetcher, calls } = recorder([() => ({ json: answer(4, [finding(1, 'Partition')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'small.pdf', requestedTrades: [], scope: null, pageCount: 4 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pages, 4);
  assert.match(calls[0]!.body.messages[1].content[0].text, /complete construction plan/);
  assert.equal(calls[0]!.body.messages[1].content[1].file.filename, 'construction-plan.pdf');
  assert.equal(result.findings[0]!.page_number, 1);
  assert.equal(result.summary.limitations.some(note => /separate provider request/.test(note)), false);
});

test('sweeping can be switched off, and then the whole set is sent once', async () => {
  const bytes = await planBytes(12);
  const { fetcher, calls } = recorder([() => ({ json: answer(12, [finding(1, 'Partition')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig({ AI_PLAN_OPENAI_SWEEP: 'false' }), fetcher);

  await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.pages, 12);
});

test('a failed batch is disclosed by its unread physical pages and never invents coverage', async () => {
  const bytes = await planBytes(12);
  const { fetcher, calls } = recorder([
    () => ({ status: 500 }),
    () => ({ json: answer(5, [finding(1, 'Surviving evidence')]) }),
    () => ({ json: answer(2, [finding(2, 'Tail evidence')]) }),
  ]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });

  assert.equal(calls.length, 3);
  assert.deepEqual(result.findings.map(item => item.page_number), [6, 12]);
  assert.equal(result.summary.limitations.some(note => /Physical pages 1-5 could not be read/.test(note)), true);
  assert.equal(result.summary.limitations.some(note => /1 of 3 batch\(es\) failed/.test(note)), true);
});

test('a sweep that reads nothing rethrows the provider failure so the next reader can be tried', async () => {
  const bytes = await planBytes(12);
  const { fetcher } = recorder([() => ({ status: 500 })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  await assert.rejects(
    () => reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 }),
    (error: any) => typeof error?.diagnostic?.code === 'string',
  );
});

test('a finding that cites a page outside its own batch is dropped and disclosed', async () => {
  const bytes = await planBytes(12);
  const { fetcher } = recorder([
    () => ({ json: answer(5, [finding(1, 'Real'), note(9, 'Impossible page')]) }),
    () => ({ json: answer(5, [finding(1, 'Second window')]) }),
    () => ({ json: answer(2, [finding(2, 'Third window')]) }),
  ]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig(), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });

  assert.equal(result.findings.some(item => item.label === 'Impossible page'), false);
  assert.deepEqual(result.findings.map(item => item.page_number), [1, 6, 12]);
  assert.equal(result.summary.limitations.some(note => /cited a page outside that batch and were dropped/.test(note)), true);
});

test('the sweep respects its request cap and names the pages it never read', async () => {
  const bytes = await planBytes(12);
  const { fetcher, calls } = recorder([() => ({ json: answer(5, [finding(1, 'Partition')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig({ AI_PLAN_OPENAI_MAX_BATCHES: '2' }), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });

  assert.equal(calls.length, 2);
  assert.equal(result.summary.limitations.some(note => /Physical pages 11-12 were never read/.test(note)), true);
});

test('merged findings are capped for a whole set, and the cap is disclosed', async () => {
  const bytes = await planBytes(12);
  const { fetcher } = recorder([() => ({ json: answer(5, [finding(1, 'A'), finding(2, 'B')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(openAiConfig({ AI_PLAN_MAX_TOTAL_FINDINGS: '3' }), fetcher);

  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 });

  assert.equal(result.findings.length, 3);
  assert.equal(result.summary.limitations.some(note => /Findings capped at 3 for this set \(6 were reported across all batches\)/.test(note)), true);
});

test('the default window and request caps are bounded, and a huge set is capped rather than fanned out', async () => {
  const configured = requireOpenAiVisionConfig({
    OPENAI_PLAN_READING_ENABLED: 'true', OPENAI_API_KEY: 'sk-plan-reading-key', OPENAI_MODEL: 'gpt-4.1',
  });
  assert.equal(configured.batchPages, 8);
  assert.equal(configured.maxBatches, 25);
  assert.equal(configured.maxTotalFindings, 400);

  // Out-of-range or malformed values fall back instead of fanning out unbounded.
  const bounded = requireOpenAiVisionConfig({
    OPENAI_PLAN_READING_ENABLED: 'true', OPENAI_API_KEY: 'sk-plan-reading-key', OPENAI_MODEL: 'gpt-4.1',
    AI_PLAN_OPENAI_BATCH_PAGES: '9999', AI_PLAN_OPENAI_MAX_BATCHES: 'nonsense', AI_PLAN_MAX_TOTAL_FINDINGS: '-3',
  });
  assert.equal(bounded.batchPages, 50);
  assert.equal(bounded.maxBatches, 25);
  assert.equal(bounded.maxTotalFindings, 400);

  const bytes = await planBytes(20);
  const { fetcher, calls } = recorder([() => ({ json: answer(8, [finding(1, 'Partition')]) })]);
  const reader = new OpenAiCompatibleVisionPlanReader(configured, fetcher);
  const result = await reader.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 20 });

  assert.deepEqual(calls.map(call => call.pages), [8, 8, 4], 'the default reads a 20-page set in three requests');
  assert.equal(result.summary.sheet_count, 20);
});

test('the image-native providers never sweep: they read the supplied images only', async () => {
  const { fetcher, calls } = recorder([() => ({ json: answer(1, [finding(1, 'Partition')]) })]);
  const kimi = new OpenAiCompatibleVisionPlanReader({
    provider: 'kimi', apiKey: 'kimi-key', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2.6',
    maxImages: 4, batchPages: 0, maxBatches: 0, maxTotalFindings: 200, timeoutMs: 60_000,
  }, fetcher);
  const bytes = await planBytes(12);

  await assert.rejects(
    () => kimi.read({ fileBytes: bytes, mimeType: 'application/pdf', sheetName: 'set.pdf', requestedTrades: [], scope: null, pageCount: 12 }),
    /requires server-rendered plan page images/,
  );
  assert.equal(calls.length, 0, 'no provider request is sent without rendered pages');
});
