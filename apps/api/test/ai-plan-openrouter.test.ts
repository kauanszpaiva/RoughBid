import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractLocalPdfText, MAX_FREE_TEXT_PDF_BYTES, OPENROUTER_FREE_MODEL, OpenRouterFreePlanReader } from '../src/ai-plan/openrouter.ts';
import type { GeminiPlanReadInput } from '../src/ai-plan/gemini.ts';
import type { PlanReader } from '../src/ai-plan/service.ts';

async function inputWithPages(texts: string[] = ['Doors: 2 EA. Drywall: 120 SF.']): Promise<GeminiPlanReadInput> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of texts) {
    const page = document.addPage();
    if (text) page.drawText(text, { font, size: 12 });
  }
  return { fileBytes: await document.save(), mimeType: 'application/pdf', sheetName: 'Synthetic adapter fixture', requestedTrades: ['Drywall'], scope: null };
}

function output(pages = 1) {
  return {
    summary: { sheet_count: pages, detected_trade_scope: ['Drywall'], scale_status: 'missing', limitations: [] },
    findings: [{ page_number: 1, finding_type: 'material', label: 'Doors', value_text: null, quantity: 2, unit: 'EA', confidence: 0.9, source_excerpt: 'Doors: 2 EA.' }],
  };
}

function completion(raw: unknown = output()) {
  return { model: 'example/model:free', usage: { cost: 0 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] };
}

test('PDF.js extracts local text with original page numbers and preserves caller bytes', async () => {
  const input = await inputWithPages(['Doors: 2 EA.', '', 'Drywall: 120 SF.']);
  const original = input.fileBytes.slice();
  const extracted = await extractLocalPdfText(input);
  assert.deepEqual(extracted.pages.map(page => page.pageNumber), [1, 2, 3]);
  assert.match(extracted.pages[0]!.text, /Doors: 2 EA/);
  assert.match(extracted.pages[2]!.text, /Drywall: 120 SF/);
  assert.deepEqual(extracted.emptyPages, [2]);
  assert.deepEqual(input.fileBytes, original);
});

test('PlanReader adapter sends only locally extracted text to a fixed zero-price endpoint', async () => {
  const input = await inputWithPages(['Doors: 2 EA.', '']);
  let calls = 0;
  const reader: PlanReader = new OpenRouterFreePlanReader('server-test-key', async (url, init) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer server-test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, OPENROUTER_FREE_MODEL);
    assert.deepEqual(body.provider, { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, require_parameters: true, allow_fallbacks: false });
    assert.equal(body.plugins, undefined);
    assert.equal(body.models, undefined);
    assert.equal(body.tools, undefined);
    assert.equal(body.files, undefined);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 8000);
    assert.ok(body.messages.every((message: any) => typeof message.content === 'string'));
    assert.doesNotMatch(String(init?.body), /data:application\/pdf|file_data|inlineData|image_url|server-test-key/);
    const evidence = JSON.parse(body.messages[1].content);
    assert.equal(evidence.physical_page_count, 2);
    assert.equal(evidence.pages[0].pageNumber, 1);
    assert.match(evidence.pages[0].text, /Doors: 2 EA/);
    return Response.json(completion(output(2)));
  });
  const result = await reader.read({ ...input, model: 'openrouter/auto', provider: 'paid' } as GeminiPlanReadInput);
  assert.equal(calls, 1);
  assert.equal(result.findings[0]?.quantity, 2);
  assert.deepEqual(result.findings[0]?.geometry, {});
  assert.equal(result.summary.human_review_required, true);
  assert.equal(result.summary.synthetic, undefined);
  assert.ok(result.summary.limitations.some(value => /Partial text-only/.test(value)));
  assert.ok(result.summary.limitations.some(value => /page\(s\): 2/.test(value)));
});

test('missing credentials, invalid PDFs, scans and oversized documents make zero inference requests', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(completion()); };
  const input = await inputWithPages();
  for (const key of ['', '[REDACTED]', 'your-api-key']) {
    await assert.rejects(new OpenRouterFreePlanReader(key, fetcher).read(input), (error: any) => error.status === 503);
  }
  const reader = new OpenRouterFreePlanReader('server-test-key', fetcher);
  await assert.rejects(reader.read({ ...input, mimeType: 'image/png' }), (error: any) => error.status === 415);
  await assert.rejects(reader.read({ ...input, fileBytes: new TextEncoder().encode('not pdf') }), (error: any) => error.status === 415);
  await assert.rejects(reader.read({ ...input, fileBytes: new TextEncoder().encode('%PDF-broken') }), (error: any) => error.status === 422);
  await assert.rejects(reader.read(await inputWithPages([''])), /no selectable text.*no paid OCR/);
  const oversized = new Uint8Array(MAX_FREE_TEXT_PDF_BYTES + 1);
  oversized.set(new TextEncoder().encode('%PDF-'));
  await assert.rejects(reader.read({ ...input, fileBytes: oversized }), (error: any) => error.status === 413);
  await assert.rejects(reader.read(await inputWithPages(Array.from({ length: 101 }, () => ''))), (error: any) => error.status === 413);
  assert.equal(calls, 0);
});

test('dense text is rejected locally instead of silently truncating plan coverage', async () => {
  let calls = 0;
  const reader = new OpenRouterFreePlanReader('server-test-key', async () => { calls++; return Response.json(completion()); });
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage([612, 14400]).drawText(('Long source text '.repeat(3) + '\n').repeat(500), { font, size: 12, x: 10, y: 14380, lineHeight: 20 });
  await assert.rejects(reader.read({ ...(await inputWithPages()), fileBytes: await document.save() }), /too much text/);
  assert.equal(calls, 0);
});

test('provider quota, payment, authorization, server and network errors never retry or fall back', async () => {
  const input = await inputWithPages();
  for (const status of [400, 401, 402, 403, 429, 500, 503]) {
    let calls = 0;
    const reader = new OpenRouterFreePlanReader('server-test-key', async () => {
      calls++;
      return Response.json({ error: { message: 'private-provider-detail' } }, { status });
    });
    await assert.rejects(reader.read(input), (error: any) => error.status >= 400 && !error.message.includes('private-provider-detail'));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const reader = new OpenRouterFreePlanReader('server-test-key', async () => { calls++; throw new Error('private-network-detail'); });
  await assert.rejects(reader.read(input), (error: any) => error.status === 504 && !error.message.includes('private-network-detail'));
  assert.equal(calls, 1);
});

test('malformed, truncated, refused, oversized and nonzero-cost responses cannot produce findings', async () => {
  const input = await inputWithPages();
  const cases = [
    { ...completion(), choices: [{ finish_reason: 'length' }] },
    { ...completion(), choices: [{ finish_reason: 'stop', message: { content: '{broken' } }] },
    { ...completion(), choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()), refusal: 'refused' } }] },
    { ...completion(), usage: { cost: 0.01 } },
    { ...completion(), usage: { cost: '0.01' } },
    { ...completion(), error: { message: 'failed' } },
    { ...completion(), padding: 'x'.repeat(1024 * 1024) },
  ];
  for (const payload of cases) {
    let calls = 0;
    const reader = new OpenRouterFreePlanReader('server-test-key', async () => { calls++; return Response.json(payload); });
    await assert.rejects(reader.read(input), (error: any) => error.status === 502);
    assert.equal(calls, 1);
  }
});

test('valid JSON fences are accepted; mixed prose and invented source/page/quantity evidence are rejected', async () => {
  const input = await inputWithPages();
  const fenced = completion();
  fenced.choices[0]!.message.content = '```json\n' + JSON.stringify(output()) + '\n```';
  assert.equal((await new OpenRouterFreePlanReader('key', async () => Response.json(fenced)).read(input)).findings.length, 1);
  const mutations: Array<(raw: any) => void> = [
    raw => { raw.summary.sheet_count = 2; },
    raw => { raw.summary.synthetic = true; },
    raw => { raw.findings[0].page_number = 2; },
    raw => { raw.findings[0].source_excerpt = 'Doors: 99 EA.'; },
    raw => { raw.findings[0].quantity = 20; },
    raw => { raw.findings[0].quantity = -2; },
    raw => { raw.findings[0].unit = 'M2'; },
    raw => { raw.findings[0].unit = 'SF'; },
    raw => { raw.findings[0].label = 'Drywall'; },
    raw => { raw.findings[0].source_excerpt = ''; },
    raw => { raw.findings[0].confidence = 2; },
    raw => { raw.findings = []; },
  ];
  for (const mutate of mutations) {
    const raw = output();
    mutate(raw);
    await assert.rejects(new OpenRouterFreePlanReader('key', async () => Response.json(completion(raw))).read(input), /evidence that does not match/);
  }
  const mixed = completion();
  mixed.choices[0]!.message.content = 'Explanation\n' + JSON.stringify(output());
  await assert.rejects(new OpenRouterFreePlanReader('key', async () => Response.json(mixed)).read(input), /evidence that does not match/);
});

test('drawing numbers and excerpts containing multiple quantities cannot be promoted into takeoff quantities', async () => {
  const cases = [
    { text: 'Drawing number 2', label: 'Drawing', quantity: 2, unit: 'EA' },
    { text: 'Doors: 2 EA. Windows: 4 EA.', label: 'Doors', quantity: 4, unit: 'EA' },
    { text: 'Drywall: 0.125 SF.', label: 'Drywall', quantity: 0.125, unit: 'SF' },
  ];
  for (const example of cases) {
    const input = await inputWithPages([example.text]);
    const raw = output();
    raw.findings[0] = { ...raw.findings[0]!, label: example.label, quantity: example.quantity, unit: example.unit, source_excerpt: example.text };
    await assert.rejects(new OpenRouterFreePlanReader('key', async () => Response.json(completion(raw))).read(input), /evidence that does not match/);
  }
});

test('explicit source quantities with thousands separators are supported without invented prices', async () => {
  const input = await inputWithPages(['Drywall: 1,200 SF.']);
  const raw = output();
  raw.findings[0] = { ...raw.findings[0]!, label: 'Drywall', quantity: 1200, unit: 'SF', source_excerpt: 'Drywall: 1,200 SF.' };
  const result = await new OpenRouterFreePlanReader('key', async () => Response.json(completion(raw))).read(input);
  assert.equal(result.findings[0]?.quantity, 1200);
  assert.equal('pricing' in result.findings[0]!.geometry, false);
});
