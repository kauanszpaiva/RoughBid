import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService, type PlanReader } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { GeminiPlanReader } from '../src/ai-plan/gemini.ts';
import { PDF_DIGEST } from '../src/billing/project-preflight.ts';

const model = 'gemini-2.5-flash';
const testEnvironment = { GEMINI_MODEL: model, GEMINI_API_KEY: 'unit-provider-credential', PAID_PLAN_READINGS_ENABLED: 'true', PAID_PLAN_READINGS_STAGE: 'test', STRIPE_MODE: 'test', VERCEL_ENV: 'preview', APP_ENV: 'test' };
const priorEnvironment = Object.fromEntries(Object.keys(testEnvironment).map(key => [key, process.env[key]]));
before(() => { Object.assign(process.env, testEnvironment); });
after(() => { for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const measuredUsage = { model, model_version: model, input_tokens: 100, output_tokens: 50 };
const activationState = { enabled: true, model, stripe_livemode: false, budget_usd: 1, exposure_usd: 0.2, reserved_usd_per_attempt: 0.05 };
const evidenceFinding = { page_number: 1, finding_type: 'material' as const, label: 'Decking', value_text: null, quantity: 100, unit: 'SF', confidence: 0.9, geometry: {}, source_excerpt: 'A1: 100 SF decking' };

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
    if (table === 'projects') return { data: { id: 'project-1' }, error: null };
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

const noopReader: PlanReader = { read: async input => {
  input.onUsage?.({ outcome: 'measured', usage: measuredUsage });
  return { summary: { sheet_count: 1, detected_trade_scope: [], scale_status: 'detected', human_review_required: true, limitations: [] }, findings: [] };
} };
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

function directWriter(onInsert: (rows: any[])=>void = () => {}, options: {
  activation?: unknown;
  usageError?: boolean;
  finishError?: boolean;
  reused?: boolean;
  calls?: Array<{ fn: string; args: any }>;
} = {}) {
  return { from: () => { throw new Error('Reading writes must be atomic'); }, rpc: async (fn: string, args: any) => {
    options.calls?.push({ fn, args });
    if (fn === 'assert_plan_reading_activation') return { data: options.activation === undefined ? activationState : options.activation, error: null };
    if (fn === 'reserve_project_reading') return { data: { job: { id: 'job-1' }, quote: { trades: ['Framing'], scope: '', file_sha256: PDF_DIGEST(new Uint8Array([1,2,3])), page_count: 1, attempts: 1, status: options.reused ? 'complete' : 'processing' }, pilot: { attempt: 1, model, max_input_tokens: 5000, max_output_tokens: 1000, reserved_usd: 0.05 }, reused: options.reused ?? false }, error: null };
    if (fn === 'record_plan_reading_usage') return { data: { outcome: args.p_outcome }, error: options.usageError ? { message: 'ledger unavailable' } : null };
    assert.equal(fn, 'finish_project_reading');
    if (options.finishError) return { data: null, error: { message: 'write unavailable' } };
    if (!args.p_error) onInsert(args.p_findings);
    return { data: { id: 'job-1', status: args.p_error ? 'failed' : 'needs_review', output_summary: args.p_summary, plan_reading_findings: args.p_findings }, error: null };
  } };
}

test('paid reading persists evidence without generating construction prices', async () => {
  let inserted: any[] = [];
  const finding={page_number:1,finding_type:'material' as const,label:'Decking',value_text:null,quantity:100,unit:'SF',confidence:0.9,geometry:{},source_excerpt:'A1: 100 SF decking'};
  const reader: PlanReader={read:async input=>({...await noopReader.read(input),findings:[finding]})};
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
  const reader: PlanReader={read:async input=>{const result=await noopReader.read(input);result.summary.synthetic=true;return result;}};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,directWriter(()=>inserted=true),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'quote-1'}),/No usable findings/);
  assert.equal(inserted,false);
});

for (const changed of [false, true]) {
  test(changed
    ? 'a completed reused quote rejects an altered PDF without provider invocation or new cost settlement'
    : 'a completed reused quote returns its stored findings only after the paid PDF hash matches', async () => {
    const calls: Array<{ fn: string; args: any }> = [];
    let providerCalls = 0;
    let downloads = 0;
    let storedReads = 0;
    const stored = { id: 'job-1', workspace_id: 'workspace-1', status: 'needs_review', output_summary: { human_review_required: true }, plan_reading_findings: [evidenceFinding] };
    const resolve = baseResolver();
    const db = fakeDb((table, queryCalls) => {
      if (table === 'plan_reading_jobs' && queryCalls.some(([method, args]) => method === 'select' && args[0] === '*, plan_reading_findings(*)')) {
        storedReads++;
        assert.ok(queryCalls.some(([method, args]) => method === 'eq' && args[0] === 'workspace_id' && args[1] === 'workspace-1'));
        return { data: stored, error: null };
      }
      return resolve(table, queryCalls);
    });
    const reader: PlanReader = { read: async () => { providerCalls++; throw new Error('Completed readings must not invoke a provider'); } };
    const fetcher = (async () => { downloads++; return new Response(new Uint8Array(changed ? [9] : [1, 2, 3])); }) as typeof fetch;
    const service = new AiPlanReadingService(db as never, directWriter(() => { throw new Error('Reused readings must not persist again'); }, { reused: true, calls }), noopStorage, reader, 'user-1', 'workspace-1', fetcher);
    const request = service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' });
    if (changed) await assert.rejects(request, (error: any) => error.status === 409 && /changed after payment/.test(error.message));
    else assert.deepEqual(await request, stored);
    assert.equal(downloads, 1);
    assert.equal(providerCalls, 0);
    assert.equal(storedReads, changed ? 0 : 1);
    assert.deepEqual(calls.map(call => call.fn), ['assert_plan_reading_activation', 'reserve_project_reading']);
  });
}

test('workspace activation denial prevents reservation, download and provider invocation', async () => {
  for (const activation of [null, { ...activationState, enabled: false }, { ...activationState, model: 'gemini-2.5-pro' }, { ...activationState, stripe_livemode: true }, { ...activationState, exposure_usd: 0.96 }, { ...activationState, budget_usd: 0 }, { ...activationState, exposure_usd: undefined }]) {
    const calls: Array<{ fn: string; args: any }> = [];
    let downloaded = false;
    let invoked = false;
    const reader: PlanReader = { read: async input => { invoked = true; return noopReader.read(input); } };
    const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(() => {}, { activation, calls }), noopStorage, reader, 'user-1', 'workspace-1',
      (async () => { downloaded = true; return new Response(new Uint8Array([1, 2, 3])); }) as never);
    await assert.rejects(service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }), (error: any) => error.status === 503);
    assert.equal(downloaded, false);
    assert.equal(invoked, false);
    assert.deepEqual(calls.map(call => call.fn), ['assert_plan_reading_activation']);
  }
});

test('measured cost is settled for the reserved attempt before findings can be saved', async () => {
  const calls: Array<{ fn: string; args: any }> = [];
  const reader: PlanReader = { read: async input => {
    assert.equal(input.execution?.attempt, 1);
    assert.equal(input.execution?.model, model);
    return { ...await noopReader.read(input), findings: [evidenceFinding] };
  } };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(() => {}, { calls }), noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  const result = await service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' });
  assert.equal(result.status, 'needs_review');
  assert.deepEqual(calls.map(call => call.fn), ['assert_plan_reading_activation', 'reserve_project_reading', 'record_plan_reading_usage', 'finish_project_reading']);
  assert.deepEqual(calls[2]?.args, { p_job_id: 'job-1', p_attempt: 1, p_usage: measuredUsage, p_outcome: 'measured' });
});

test('cost settlement failure cannot finish a reading successfully', async () => {
  const calls: Array<{ fn: string; args: any }> = [];
  let inserted = false;
  const reader: PlanReader = { read: async input => ({ ...await noopReader.read(input), findings: [evidenceFinding] }) };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(() => { inserted = true; }, { calls, usageError: true }), noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }), (error: any) => error.status === 503 && /cost could not be reconciled/.test(error.message));
  assert.equal(inserted, false);
  assert.ok(calls.some(call => call.fn === 'record_plan_reading_usage'));
  assert.ok(!calls.some(call => call.fn === 'finish_project_reading' && call.args.p_error === null));
});

test('findings without measured provider usage remain unknown and cannot be saved', async () => {
  const calls: Array<{ fn: string; args: any }> = [];
  let inserted = false;
  const reader: PlanReader = { read: async () => ({ ...await noopReader.read({} as never), findings: [evidenceFinding] }) };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(() => { inserted = true; }, { calls }), noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }), /usage could not be verified/);
  assert.equal(inserted, false);
  assert.deepEqual(calls.find(call => call.fn === 'record_plan_reading_usage')?.args, { p_job_id: 'job-1', p_attempt: 1, p_usage: {}, p_outcome: 'unknown' });
  assert.ok(calls.filter(call => call.fn === 'finish_project_reading').every(call => call.args.p_error && call.args.p_findings.length === 0));
});

test('failed atomic finish surfaces reconciliation errors instead of reporting success', async () => {
  const reader: PlanReader = { read: async input => ({ ...await noopReader.read(input), findings: [evidenceFinding] }) };
  const service = new AiPlanReadingService(fakeDb(baseResolver()) as never, directWriter(() => {}, { finishError: true }), noopStorage, reader, 'user-1', 'workspace-1', noopFetcher as never);
  await assert.rejects(service.create('project-1', { file_id: 'file-1', quote_id: 'quote-1' }), (error: any) => error.status === 503 && /state needs reconciliation/.test(error.message));
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
