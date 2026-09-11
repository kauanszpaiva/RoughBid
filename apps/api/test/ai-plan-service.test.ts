import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService, type PlanReader } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';

type Resolver = (table: string, calls: Array<[string, unknown[]]>) => { data?: unknown; error?: unknown };

function makeQuery(resolve: () => { data?: unknown; error?: unknown }, onCall?: (method: string, args: unknown[]) => void) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'insert', 'update', 'maybeSingle', 'single']) {
    builder[method] = (...args: unknown[]) => { onCall?.(method, args); return builder; };
  }
  builder.then = (onFulfilled: (v: unknown) => unknown, onRejected: (v: unknown) => unknown) =>
    Promise.resolve(resolve()).then(onFulfilled, onRejected);
  return builder;
}

function fakeDb(resolve: Resolver, extra: Record<string, unknown> = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table: string) {
      const calls: Array<[string, unknown[]]> = [];
      return makeQuery(() => resolve(table, calls), (method, args) => calls.push([method, args]));
    },
    ...extra,
  };
}

function baseResolver(overrides: Partial<Record<string, unknown>> = {}) {
  return (table: string, calls: Array<[string, unknown[]]>): { data?: unknown; error?: unknown } => {
    if (table === 'workspaces') {
      const consentedAt = 'consentedAt' in overrides ? overrides.consentedAt : '2026-09-01T00:00:00Z';
      return { data: { ai_processing_consented_at: consentedAt }, error: null };
    }
    if (table === 'projects') return { data: { id: 'project-1', address_text: overrides.addressText ?? null }, error: null };
    if (table === 'project_files') {
      return {
        data: {
          id: 'file-1',
          original_name: overrides.originalName ?? 'plan.pdf',
          storage_path: 'workspace-1/project-1/file-1/source.pdf',
          processing_status: overrides.fileStatus ?? 'ready',
        },
        error: null,
      };
    }
    if (table === 'plan_reading_jobs') {
      const isInsert = calls.some(([method]) => method === 'insert');
      const isUpdate = calls.some(([method]) => method === 'update');
      if (isInsert) return { data: { id: 'job-1', status: 'processing' }, error: null };
      if (isUpdate) return { data: { id: 'job-1', workspace_id: 'workspace-1', ...(calls.find(([m]) => m === 'update')?.[1][0] as Record<string, unknown>) }, error: null };
      return { data: overrides.recentJobs ?? [], error: null };
    }
    throw new Error(`unexpected table ${table}`);
  };
}

const noopReader: PlanReader = { read: async () => ({ summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected', human_review_required: true, limitations: [] }, findings: [] }) };
const noopStorage = { presign: async () => ({ url: 'https://signed.example/source.pdf' }) };
const noopFetcher = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
const noopFindingsWriter = { from: () => ({ insert: () => ({ select: async () => ({ data: [], error: null }) }) }) };

test('create() rejects when the workspace has not accepted AI processing', async () => {
  const db = fakeDb(baseResolver({ consentedAt: null }));
  const service = new AiPlanReadingService(db as never, noopFindingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(
    service.create('project-1', { file_id: 'file-1' }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 403,
  );
});

test('create() enforces the daily per-workspace job cap', async () => {
  const previous = process.env.AI_PLAN_DAILY_JOB_LIMIT;
  process.env.AI_PLAN_DAILY_JOB_LIMIT = '2';
  try {
    const db = fakeDb(baseResolver({ recentJobs: [{ id: 'a' }, { id: 'b' }] }));
    const service = new AiPlanReadingService(db as never, noopFindingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', noopFetcher as never);
    await assert.rejects(
      service.create('project-1', { file_id: 'file-1' }),
      (error: unknown) => error instanceof ProjectApiError && error.status === 429,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_PLAN_DAILY_JOB_LIMIT;
    else process.env.AI_PLAN_DAILY_JOB_LIMIT = previous;
  }
});

test('create() still blocks a file that has not finished uploading', async () => {
  const db = fakeDb(baseResolver({ fileStatus: 'uploading' }));
  const service = new AiPlanReadingService(db as never, noopFindingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(
    service.create('project-1', { file_id: 'file-1' }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 409,
  );
});

function directWriter(onInsert: (rows: any[])=>void = () => {}) {
  let pricingContext: any = null;
  return { from: (table: string) => {
    if (table !== 'project_pricing_contexts') throw new Error('Reading writes must be atomic');
    const builder: any = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = async () => ({ data: pricingContext, error: null });
    builder.upsert = async (row: any) => { pricingContext = row; return { data: row, error: null }; };
    return builder;
  }, rpc: async (fn: string, args: any) => {
    if (fn === 'reserve_project_reading') return { data: { job: { id: 'job-1' }, quote: { trades: ['Framing'], scope: '', file_sha256: PDF_DIGEST(new Uint8Array([1,2,3])), page_count: 1 }, reused: false }, error: null };
    assert.equal(fn, 'finish_project_reading');
    if (!args.p_error) onInsert(args.p_findings);
    return { data: { id: 'job-1', status: args.p_error ? 'failed' : 'needs_review', output_summary: args.p_summary, plan_reading_findings: args.p_findings }, error: null };
  } };
}

test('paid reading persists evidence without generating construction prices', async () => {
  let inserted: any[] = [];
  const finding={page_number:1,finding_type:'material' as const,label:'Decking',value_text:null,quantity:100,unit:'SF',confidence:0.9,geometry:{},source_excerpt:'A1: 100 SF decking'};
  const reader={read:async()=>({...await noopReader.read({} as never),findings:[finding]})};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,directWriter(rows=>inserted=rows),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  const result=await service.create('project-1',{file_id:'file-1',quote_id:'quote-1',trades:['Framing']});
  assert.equal(result.status,'needs_review');
  assert.equal(inserted.length,1);
  assert.equal(inserted[0].job_id,'job-1');
  assert.equal(inserted[0].geometry.pricing, undefined);
  assert.equal(result.output_summary.pricing, undefined);
});

test('missing payment cannot invoke a provider or reserve an attempt', async () => {
  const writer = { from: () => ({}), rpc: async () => { throw new Error('Unexpected payment reservation'); } };
  const reader = { read: async () => { throw new Error('Unexpected provider call'); } };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, writer, noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(service.create('project-1', {file_id:'file-1'}), (error: any) => error.status === 402);
});

test('a changed PDF after payment cannot invoke a provider', async () => {
  const reader = { read: async () => { throw new Error('Unexpected provider call'); } };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(), noopStorage, reader, 'user-1', 'workspace-1', (async () => new Response(new Uint8Array([9]))) as never);
  await assert.rejects(service.create('project-1', {file_id:'file-1',quote_id:'quote-1'}), (error: any) => error.status === 409);
});

test('an unavailable reader cannot consume a paid attempt or download a plan', async () => {
  let downloaded = false;
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(), noopStorage, new GeminiPlanReader(null), 'user-1', 'workspace-1',
    (async () => { downloaded = true; throw new Error('No network expected'); }) as never);
  await assert.rejects(service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }), (error: any) => error.status === 503);
  assert.equal(downloaded, false);
});

test('synthetic provider output cannot be saved or priced', async () => {
  let inserted = false;
  const reader={read:async()=>{const result=await noopReader.read({} as never);result.summary.synthetic=true;return result;}};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,directWriter(()=>inserted=true),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'quote-1'}),/No usable findings/);
  assert.equal(inserted,false);
});

test('setFindingStatus() calls the review RPC and rejects a finding from a different workspace', async () => {
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({}),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      assert.equal(fn, 'set_plan_reading_finding_status');
      assert.deepEqual(args, { finding_id: 'finding-1', new_status: 'accepted' });
      return { data: [{ id: 'finding-1', workspace_id: 'other-workspace', status: 'accepted' }], error: null };
    },
  };
  const service = new AiPlanReadingService(db as never, noopFindingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(
    service.setFindingStatus('finding-1', 'accepted'),
    (error: unknown) => error instanceof ProjectApiError && error.status === 404,
  );
});

test('setFindingStatus() returns the updated finding for the caller\'s own workspace', async () => {
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from: () => ({}),
    rpc: async () => ({ data: [{ id: 'finding-1', workspace_id: 'workspace-1', status: 'rejected' }], error: null }),
  };
  const service = new AiPlanReadingService(db as never, noopFindingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', noopFetcher as never);
  const finding = await service.setFindingStatus('finding-1', 'rejected');
  assert.deepEqual(finding, { id: 'finding-1', workspace_id: 'workspace-1', status: 'rejected' });
});

test('PATCH /api/ai-plan-readings/findings/:id rejects an invalid status before calling the RPC', async () => {
  const db = fakeDb(baseResolver());
  const response = await handleAiPlanRequest(
    new Request('https://roughbid.test/api/ai-plan-readings/findings/finding-1', {
      method: 'PATCH',
      headers: { 'x-workspace-id': 'workspace-1', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    }),
    db as never,
    { findingsWriter: noopFindingsWriter, storage: noopStorage, reader: noopReader } as never,
  );
  assert.equal(response.status, 400);
});

test('new Quick reading persists physical PDF coverage instead of an empty completeness claim', async () => {
  const finding = { page_number: 1, finding_type: 'room' as const, label: 'Kitchen', value_text: null, quantity: 100, unit: 'SF', confidence: 0.9, geometry: {}, source_excerpt: 'Kitchen 100 SF' };
  const reader = { read: async () => ({ ...await noopReader.read({} as never), findings: [finding] }) };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(), noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  const actual = await service.create('project-1', {file_id: 'file-1', quote_id: 'quote-1'});
  assert.equal(actual.output_summary.physical_page_count, 1);
  assert.equal(actual.output_summary.reading_coverage.completeTakeoffVerified, false);
  assert.ok(actual.output_summary.limitations.some((text: string) => /complete takeoff.*not verified/i.test(text)));
});
