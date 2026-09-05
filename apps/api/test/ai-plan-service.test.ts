import test from 'node:test';
import assert from 'node:assert/strict';
import { AiPlanReadingService } from '../src/ai-plan/service.ts';
import { ProjectApiError } from '../src/projects/service.ts';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';

type Resolver = (table: string, calls: Array<[string, unknown[]]>) => { data?: unknown; error?: unknown };

function fakeDb(resolve: Resolver, extra: Record<string, unknown> = {}) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table: string) {
      const calls: Array<[string, unknown[]]> = [];
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'gte', 'order', 'insert', 'update', 'maybeSingle', 'single']) {
        builder[method] = (...args: unknown[]) => { calls.push([method, args]); return builder; };
      }
      builder.then = (onFulfilled: (v: unknown) => unknown, onRejected: (v: unknown) => unknown) =>
        Promise.resolve(resolve(table, calls)).then(onFulfilled, onRejected);
      return builder;
    },
    ...extra,
  };
}

const noopQueue = { add: async () => undefined };

function baseResolver(overrides: Partial<Record<string, unknown>> = {}) {
  return (table: string, calls: Array<[string, unknown[]]>): { data?: unknown; error?: unknown } => {
    if (table === 'workspaces') {
      const consentedAt = 'consentedAt' in overrides ? overrides.consentedAt : '2026-09-01T00:00:00Z';
      return { data: { ai_processing_consented_at: consentedAt }, error: null };
    }
    if (table === 'projects') return { data: { id: 'project-1' }, error: null };
    if (table === 'project_files') return { data: { id: 'file-1', processing_status: overrides.fileStatus ?? 'ready' }, error: null };
    if (table === 'plan_reading_jobs') {
      const isInsert = calls.some(([method]) => method === 'insert');
      if (isInsert) return { data: { id: 'job-1', status: 'queued' }, error: null };
      return { data: overrides.recentJobs ?? [], error: null };
    }
    throw new Error(`unexpected table ${table}`);
  };
}

test('create() rejects when the workspace has not accepted AI processing', async () => {
  const db = fakeDb(baseResolver({ consentedAt: null }));
  const service = new AiPlanReadingService(db as never, noopQueue, 'user-1', 'workspace-1');
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
    const service = new AiPlanReadingService(db as never, noopQueue, 'user-1', 'workspace-1');
    await assert.rejects(
      service.create('project-1', { file_id: 'file-1' }),
      (error: unknown) => error instanceof ProjectApiError && error.status === 429,
    );
  } finally {
    if (previous === undefined) delete process.env.AI_PLAN_DAILY_JOB_LIMIT;
    else process.env.AI_PLAN_DAILY_JOB_LIMIT = previous;
  }
});

test('create() queues a job once consent exists, the file is ready, and the workspace is under its cap', async () => {
  let queued: unknown;
  const db = fakeDb(baseResolver());
  const queue = { add: async (_name: string, data: unknown) => { queued = data; } };
  const service = new AiPlanReadingService(db as never, queue, 'user-1', 'workspace-1');
  const job = await service.create('project-1', { file_id: 'file-1' });
  assert.equal(job.id, 'job-1');
  assert.deepEqual(queued, { jobId: 'job-1', workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1' });
});

test('create() still blocks on a file that has not finished processing', async () => {
  const db = fakeDb(baseResolver({ fileStatus: 'processing' }));
  const service = new AiPlanReadingService(db as never, noopQueue, 'user-1', 'workspace-1');
  await assert.rejects(
    service.create('project-1', { file_id: 'file-1' }),
    (error: unknown) => error instanceof ProjectApiError && error.status === 409,
  );
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
  const service = new AiPlanReadingService(db as never, noopQueue, 'user-1', 'workspace-1');
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
  const service = new AiPlanReadingService(db as never, noopQueue, 'user-1', 'workspace-1');
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
    noopQueue,
  );
  assert.equal(response.status, 400);
});
