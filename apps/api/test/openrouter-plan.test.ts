import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { OpenRouterFreePdfReader, OPENROUTER_FREE_MODEL } from '../src/ai-plan/openrouter.ts';
import { GeminiPlanService } from '../src/ai-plan/gemini-service.ts';

async function pdf() { const document = await PDFDocument.create(); document.addPage(); return document.save(); }
const output = () => ({ summary: { sheet_count: 1, detected_trade_scope: ['architectural'], scale_status: 'missing', human_review_required: true, coverage: { pages_analyzed: 1, missing_or_unreadable_pages: [], limitations: [], completeness_status: 'complete' } }, findings: [{ page_number: 1, finding_type: 'measurement', label: 'Doors', quantity: 2, unit: 'EA', value_text: null, source_excerpt: 'Doors: 2 EA', confidence: 0.9, geometry: {} }] });
const completion = (extra = {}) => ({ model: 'example/model:free', usage: { cost: 0 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output()) } }], ...extra });

test('OpenRouter pins zero-price inference and free PDF parser with the private PDF inline', async () => {
  const bytes = await pdf();
  const reader = new OpenRouterFreePdfReader('server-test-key', async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((init?.headers as any).authorization, 'Bearer server-test-key');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, OPENROUTER_FREE_MODEL);
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
    assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    assert.equal(body.messages[1].content[1].file.file_data, `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`);
    assert.equal(body.models, undefined);
    return Response.json(completion());
  });
  const result = await reader.readPdf(bytes, { requestedAreas: ['Lobby'], scopeMode: 'selected_scope' });
  assert.equal(result.findings[0]?.quantity, 2);
  assert.equal(result.summary.coverage.completeness_status, 'partial');
  assert.match(result.summary.coverage.limitations.at(-1)!, /not fully inspected/);
  assert.equal((result.summary as any).reported_cost, 0);
  assert.equal((result.summary as any).provider, 'openrouter');
});

test('missing OpenRouter credentials and invalid PDFs make no provider calls', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json(completion()); };
  await assert.rejects(new OpenRouterFreePdfReader('', fetcher).readPdf(await pdf(), {}), /server API key/);
  await assert.rejects(new OpenRouterFreePdfReader('key', fetcher).readPdf(new TextEncoder().encode('not PDF'), {}), /valid PDF/);
  assert.equal(calls, 0);
});

test('free quota and payment errors stop without retry, paid OCR or another provider', async () => {
  for (const status of [401, 402, 429, 503]) {
    let calls = 0;
    const reader = new OpenRouterFreePdfReader('key', async () => { calls++; return Response.json({ error: 'sensitive-provider-error' }, { status }); });
    await assert.rejects(reader.readPdf(await pdf(), {}), (e: any) => e.status >= 400 && !e.message.includes('sensitive-provider-error'));
    assert.equal(calls, 1);
  }
});

test('incomplete or invalid free-model output is rejected before findings are stored', async () => {
  for (const data of [completion({ choices: [{ finish_reason: 'length' }] }), completion({ choices: [{ finish_reason: 'stop', message: { content: '{broken' } }] }), completion({ usage: { cost: 0.01 } })]) {
    const reader = new OpenRouterFreePdfReader('key', async () => Response.json(data));
    await assert.rejects(reader.readPdf(await pdf(), {}));
  }
});

function database(provider: 'openrouter' | 'gemini' = 'openrouter') {
  const writes: any[] = [];
  const queriedModels: string[] = [];
  const db: any = {
    from(table: string) {
      let changes: any;
      const q: any = {
        select() { return q; }, order() { return q; }, gte() { return q; },
        eq(key: string, value: string) { if (key === 'model') queriedModels.push(value); return q; },
        insert(value: any) { changes = value; writes.push({ table, value }); return q; },
        update(value: any) { changes = value; writes.push({ table, value }); return q; },
        limit: async () => ({ data: [], error: null }),
        single: async () => ({ data: { id: 'job', ...changes }, error: null }),
        maybeSingle: async () => ({ error: null, data: table === 'workspace_members' ? { role: 'estimator' }
          : table === 'project_files' ? { id: 'file', processing_status: 'ready', storage_path: 'private/test.pdf' }
          : table === 'plan_reading_jobs' ? changes ? { id: 'job' } : { id: 'job', project_id: 'project', file_id: 'file', status: 'queued', model: provider === 'openrouter' ? OPENROUTER_FREE_MODEL : 'gemini-3.5-flash-lite', input_summary: { provider }, plan_reading_findings: [] }
          : { id: 'project' } }),
        then(resolve: any) { return Promise.resolve({ data: changes, count: 0, error: null }).then(resolve); },
      };
      return q;
    },
  };
  return { db, writes, queriedModels };
}

test('free reading creation uses a separate model cache and stores provider choice', async () => {
  const { db, queriedModels } = database();
  const reader: any = { configured: true, readPdf: async () => output() };
  const service = new GeminiPlanService(db, db, {} as any, reader, 'workspace', 'user', { openrouter: reader });
  const job = await service.create('project', { file_id: 'file', provider: 'openrouter' });
  assert.equal(job.model, OPENROUTER_FREE_MODEL);
  assert.equal(job.input_summary.provider, 'openrouter');
  assert.deepEqual(queriedModels, [OPENROUTER_FREE_MODEL]);
  await assert.rejects(service.create('project', { file_id: 'file', provider: 'paid-model' }), /Choose/);
});

test('missing free provider configuration does not create a job or use Gemini', async () => {
  const { db, writes } = database();
  const service = new GeminiPlanService(db, db, {} as any, { readPdf: async () => { throw Error('Gemini must not run'); } }, 'workspace', 'user');
  await assert.rejects(service.create('project', { file_id: 'file', provider: 'openrouter' }), /server API key/);
  assert.equal(writes.length, 0);
});

test('processing dispatches the stored OpenRouter job without calling Gemini', async () => {
  const { db, writes } = database();
  let freeCalls = 0;
  const previousFetch = globalThis.fetch;
  const bytes = await pdf();
  globalThis.fetch = async () => new Response(bytes as any);
  try {
    const service = new GeminiPlanService(db, db, { presign: async () => ({ url: 'https://private.test/pdf' }) } as any,
      { readPdf: async () => { throw Error('Gemini must not run'); } }, 'workspace', 'user',
      { openrouter: { readPdf: async () => { freeCalls++; return output() as any; } } });
    assert.equal((await service.process('job')).status, 'needs_review');
    assert.equal(freeCalls, 1);
    assert.ok(writes.some(w => w.table === 'plan_reading_findings'));
  } finally { globalThis.fetch = previousFetch; }
});
