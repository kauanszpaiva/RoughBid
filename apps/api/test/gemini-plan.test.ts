import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { GeminiPdfReader, inspectPdf, fetchPrivatePdf, validateGeminiResult } from '../src/ai-plan/gemini.ts';
import { GeminiPlanService, handleGeminiPlanRequest } from '../src/ai-plan/gemini-service.ts';
import { DocumentService } from '../src/documents/service.ts';
import { normalizePlanReadingScope } from '../src/ai-plan/openai.ts';

async function pdf(pages = 1) { const doc = await PDFDocument.create(); for (let i = 0; i < pages; i++) doc.addPage(); return doc.save(); }
const output = () => ({ summary: { sheet_count: 1, detected_trade_scope: ['architectural'], scale_status: 'missing', human_review_required: false, coverage: { pages_analyzed: 1, missing_or_unreadable_pages: [], limitations: [], completeness_status: 'complete' } }, findings: [{ page_number: 1, finding_type: 'measurement', label: 'Floor', quantity: 120, unit: 'SF', value_text: '120 SF', source_excerpt: 'Floor area 120 SF', confidence: 0.9, geometry: {} }] });

test('Gemini reads PDF inline, uses server header and restores requested scope', async () => {
  const bytes = await pdf();
  const reader = new GeminiPdfReader('test-secret', async (url, init) => {
    assert.match(String(url), /gemini-3\.5-flash-lite:generateContent$/);
    assert.ok(!String(url).includes('test-secret'));
    assert.equal((init?.headers as any)['x-goog-api-key'], 'test-secret');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'application/pdf');
    assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from(bytes).toString('base64'));
    assert.match(body.contents[0].parts[0].text, /Lobby/);
    return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(output()) }] } }] });
  });
  const result = await reader.readPdf(bytes, { scope_mode: 'selected_scope', requested_areas: ['Lobby'], requested_trades: ['architectural'] });
  assert.equal(result.summary.human_review_required, true);
  assert.deepEqual(result.summary.coverage.requested_areas, ['Lobby']);
});

test('invalid and oversized PDFs never reach Gemini', async () => {
  let calls = 0;
  const reader = new GeminiPdfReader('test', async () => { calls++; throw Error(); });
  await assert.rejects(reader.readPdf(new TextEncoder().encode('not a pdf'), {}), /valid PDF/);
  await assert.rejects(reader.readPdf(await pdf(61), {}), /1 to 60/);
  assert.equal(calls, 0);
});

test('private PDF downloads enforce byte cap even when Content-Length is missing', async () => {
  await assert.rejects(fetchPrivatePdf('https://storage.test/pdf', {}, async () => new Response(new Uint8Array(12 * 1024 * 1024 + 1))), /12 MB/);
});

test('Gemini quota errors are clear and never retry with a paid provider', async () => {
  let calls = 0;
  const reader = new GeminiPdfReader('test-secret', async () => { calls++; return Response.json({ error: 'provider-secret-error' }, { status: 429 }); });
  await assert.rejects(reader.readPdf(await pdf(), {}), (e: any) => e.status === 429 && !e.message.includes('provider-secret-error'));
  assert.equal(calls, 1);
});

test('truncated output and unsupported evidence fail before persistence', async () => {
  const reader = new GeminiPdfReader('test', async () => Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] }));
  await assert.rejects(reader.readPdf(await pdf(), {}), /smaller plan set/);
  const bad = output(); bad.findings[0]!.page_number = 2;
  assert.throws(() => validateGeminiResult(bad, 1, {}), /invalid/);
  const noEvidence = output(); noEvidence.findings[0]!.source_excerpt = '';
  assert.throws(() => validateGeminiResult(noEvidence, 1, {}), /invalid/);
});

test('partial page coverage cannot be represented as complete', () => {
  const data = output(); data.summary.coverage.pages_analyzed = 0;
  assert.equal(validateGeminiResult(data, 1, {}).summary.coverage.completeness_status, 'partial');
  assert.equal(normalizePlanReadingScope({ scope_mode: 'selected_scope', requested_areas: ['Lobby'] }).mode, 'selected_scope');
});

function fakeDb(role = 'estimator', visible = true, claim = true) {
  const writes: any[] = [];
  const file = { id: 'file', workspace_id: 'workspace', project_id: 'project', processing_status: 'uploading', storage_path: 'workspace/project/file/source.pdf', byte_size: 0 };
  const db: any = {
    auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
    from(table: string) {
      let changes: any;
      const filters: any[] = [];
      const query: any = {
        select() { return query; }, eq(k: string, v: any) { filters.push([k, v]); return query; }, in() { return query; },
        update(c: any) { changes = c; writes.push({ table, changes: c, filters }); return query; },
        async maybeSingle() {
          if (table === 'workspace_members') return { data: { role }, error: null };
          if (table === 'plan_reading_jobs') return { data: changes ? (claim ? { id: 'job' } : null) : visible ? { id: 'job', workspace_id: 'workspace', project_id: 'project', file_id: 'file', model: 'gemini-3.5-flash-lite', status: 'queued', plan_reading_findings: [] } : null, error: null };
          if (table === 'project_files') return { data: { ...file, ...changes }, error: null };
          return { data: visible ? { id: 'project' } : null, error: null };
        },
      };
      return query;
    },
  };
  return { db, writes, file };
}
const unusedStorage = { presign: async () => { throw Error('Storage must not be accessed'); } };
const unusedReader = { readPdf: async () => { throw Error('Provider must not be accessed'); } };

test('viewer and cross-workspace processing stop before privileged writes or provider access', async () => {
  for (const [role, visible, status] of [['viewer', true, 403], ['estimator', false, 404]] as const) {
    const { db, writes } = fakeDb(role, visible);
    const response = await handleGeminiPlanRequest(new Request('https://test/api/ai-plan-readings/job/process', { method: 'POST', headers: { 'x-workspace-id': 'workspace' } }), db, db, unusedStorage, unusedReader);
    assert.equal(response.status, status);
    assert.equal(writes.length, 0);
  }
});

test('concurrent processing loses the conditional job claim without calling Gemini', async () => {
  const { db, file } = fakeDb('estimator', true, false);
  file.processing_status = 'ready';
  await assert.rejects(new GeminiPlanService(db, db, unusedStorage, unusedReader, 'workspace', 'user').process('job'), /already processing/);
});

test('PDF completion validates actual bytes and marks ready without Redis', async () => {
  const bytes = await pdf(2);
  const { db, writes, file } = fakeDb(); file.byte_size = bytes.length;
  const storage = { presign: async (method: any) => ({ url: 'https://storage.test/pdf', method, headers: { 'x-proof': 'signed' }, expiresAt: '2026-09-06' }) };
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal((init?.headers as any)['x-proof'], 'signed');
    return init?.method === 'HEAD' ? new Response(null, { headers: { 'content-length': String(bytes.length), 'content-type': 'application/pdf' } }) : new Response(Buffer.from(bytes));
  };
  const completed = await new DocumentService(db, storage, null, 'user', 'workspace', fetcher, db).completeUpload('file');
  assert.equal(completed.processing_status, 'ready'); assert.equal(completed.page_count, 2);
  assert.equal(writes.length, 1); assert.deepEqual(writes[0].filters, [['workspace_id', 'workspace'], ['id', 'file']]);
  assert.equal(await inspectPdf(bytes), 2);
});
