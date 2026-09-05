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

test('create() reads the uploaded PDF synchronously, prices findings, and persists results without a queue', async () => {
  const db = fakeDb(baseResolver());
  let downloadedUrl: string | undefined;
  let readInput: Record<string, unknown> | undefined;
  const storage = { presign: async (_method: 'GET', key: string) => { return { url: `https://signed.example/${key}` }; } };
  const fetcher = async (url: string) => { downloadedUrl = url; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  const reader: PlanReader = {
    read: async (input) => {
      readInput = input as unknown as Record<string, unknown>;
      return {
        summary: { sheet_count: 1, detected_trade_scope: ['Framing'], scale_status: 'detected', human_review_required: true, limitations: [] },
        findings: [
          { page_number: 1, finding_type: 'material', label: 'Composite Decking', value_text: null, quantity: 100, unit: 'SF', confidence: 0.9, geometry: {}, source_excerpt: 'Sheet A1' },
        ],
      };
    },
  };
  let insertedRows: Array<Record<string, unknown>> | undefined;
  const findingsWriter = {
    from: (table: string) => {
      assert.equal(table, 'plan_reading_findings');
      return {
        insert: (rows: Array<Record<string, unknown>>) => {
          insertedRows = rows;
          return { select: async () => ({ data: rows.map((row, i) => ({ id: `finding-${i}`, ...row })), error: null }) };
        },
      };
    },
  };

  const service = new AiPlanReadingService(db as never, findingsWriter, storage, reader, 'user-1', 'workspace-1', fetcher as never);
  const result = await service.create('project-1', { file_id: 'file-1' });

  assert.equal(downloadedUrl, 'https://signed.example/workspace-1/project-1/file-1/source.pdf');
  assert.equal(readInput?.sheetName, 'plan.pdf');
  assert.equal(insertedRows?.length, 1);
  assert.equal((insertedRows![0]!.geometry as { pricing: unknown[] }).pricing.length, 2); // material + companion labor
  assert.equal(result.status, 'needs_review');
  assert.equal(result.plan_reading_findings.length, 1);
  assert.equal(result.plan_reading_findings[0].id, 'finding-0');
});

test('create() marks the job failed when the uploaded file cannot be downloaded, without inserting findings', async () => {
  const db = fakeDb(baseResolver());
  let insertCalled = false;
  const findingsWriter = { from: () => ({ insert: () => { insertCalled = true; return { select: async () => ({ data: [], error: null }) }; } }) };
  const failingFetcher = async () => new Response('not found', { status: 404 });

  const service = new AiPlanReadingService(db as never, findingsWriter, noopStorage, noopReader, 'user-1', 'workspace-1', failingFetcher as never);
  await assert.rejects(service.create('project-1', { file_id: 'file-1' }), (error: unknown) => error instanceof ProjectApiError && error.status === 502);
  assert.equal(insertCalled, false);
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
