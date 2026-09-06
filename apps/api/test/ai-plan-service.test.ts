import { PDF_DIGEST } from '../src/billing/project-preflight.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService, type PlanReader } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

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

function paidWriter(onFinish: (args: any)=>void = () => {}) {
  return { from: () => ({}), rpc: async (name: string,args: any) => {
    if(name === 'reserve_project_reading') return {data:{job:{id:'job-1'},quote:{trades:['Framing'],scope:'',page_count:1,file_sha256:PDF_DIGEST(new Uint8Array([1,2,3]))}},error:null};
    onFinish(args);
    return {data:{id:'job-1',status:args.p_error?'failed':'needs_review',plan_reading_findings:args.p_findings},error:null};
  }};
}
test('unpaid project does not call a provider or save findings', async () => {
  let called=false;
  const reader={read:async()=>{called=true;return noopReader.read({} as never)}};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,paidWriter(),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1'}),(e: any)=>e.status===402);
  assert.equal(called,false);
});
test('paid reading persists only real findings in one finalization RPC', async () => {
  let finished: any;
  const finding={page_number:1,finding_type:'material' as const,label:'Decking',value_text:null,quantity:100,unit:'SF',confidence:0.9,geometry:{},source_excerpt:'A1: 100 SF decking'};
  const reader={read:async()=>({...await noopReader.read({} as never),findings:[finding]})};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,paidWriter(args=>finished=args),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  const result=await service.create('project-1',{file_id:'file-1',quote_id:'quote-1',trades:['attacker scope']});
  assert.equal(result.status,'needs_review');
  assert.equal(finished.p_findings.length,1);
  assert.equal(finished.p_quote_id,'quote-1');
});
test('changed file after payment fails without calling the provider', async () => {
  let called=false;let failure:any;
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,paidWriter(args=>failure=args),noopStorage,{read:async()=>{called=true;return noopReader.read({} as never)}},'user-1','workspace-1',(async()=>new Response('different file')) as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'quote-1'}),/changed after payment/);
  assert.equal(called,false);assert.ok(failure.p_error);assert.deepEqual(failure.p_findings,[]);
});
test('synthetic provider output cannot be saved or priced', async () => {
  let failure:any;
  const reader={read:async()=>{const result=await noopReader.read({} as never);result.summary.synthetic=true;return result;}};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,paidWriter(args=>failure=args),noopStorage,reader,'user-1','workspace-1',noopFetcher as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'quote-1'}),/No usable findings/);
  assert.deepEqual(failure.p_findings,[]);
});
test('payment reservation rejects before downloading or invoking AI', async () => {
  const writer={from:()=>({}),rpc:async()=>({data:null,error:{message:'Paid quote required'}})};
  const service=new AiPlanReadingService(fakeDb(baseResolver()) as never,writer,{presign:async()=>{throw new Error('must not download')}},noopReader,'user-1','workspace-1',noopFetcher as never);
  await assert.rejects(service.create('project-1',{file_id:'file-1',quote_id:'quote-1'}),(e:any)=>e.status===402);
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
