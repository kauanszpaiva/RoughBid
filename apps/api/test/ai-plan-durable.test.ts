import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import { createDurableAiPlanQueue } from '../src/ai-plan/durable.ts';

function makeQuery(resolve: () => { data?: unknown; error?: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'gte', 'order', 'insert', 'update', 'maybeSingle', 'single']) {
    builder[method] = () => builder;
  }
  builder.then = (ok: (value: unknown) => unknown, bad: (reason: unknown) => unknown) =>
    Promise.resolve(resolve()).then(ok, bad);
  return builder;
}

function fakeDb() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table: string) {
      return makeQuery(() => {
        if (table === 'workspaces') return { data: { ai_processing_consented_at: '2026-09-01T00:00:00Z' }, error: null };
        if (table === 'projects') return { data: { id: 'project-1' }, error: null };
        if (table === 'project_files') {
          return { data: { id: 'file-1', original_name: 'plan.pdf', storage_path: 'workspace-1/project-1/file-1/source.pdf', processing_status: 'ready' }, error: null };
        }
        if (table === 'plan_reading_jobs') return { data: [], error: null };
        throw new Error(`unexpected table ${table}`);
      });
    },
  };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('durable queue isolates provider classes and keeps infrastructure retries separate from provider limits', async () => {
  const created: string[] = [];
  const added: Array<{ queue: string; jobId: string; attempts: number }> = [];
  const workers = new Map<string, number>([
    ['ai-plan-reading-paid', 1],
    ['ai-plan-reading-owner-free', 0],
  ]);
  class FakeQueue {
    name: string;
    constructor(name: string) { this.name = name; created.push(name); }
    async add(_name: string, data: any, options: any) { added.push({ queue: this.name, jobId: data.jobId, attempts: options.attempts }); }
    async getWorkers() { return Array.from({ length: workers.get(this.name) ?? 0 }, () => ({})); }
    async close() {}
  }
  const queue = await createDurableAiPlanQueue('redis://test', async () => ({ Queue: FakeQueue as never }));
  assert.deepEqual(created.sort(), ['ai-plan-reading-owner-free', 'ai-plan-reading-paid']);
  assert.equal(await queue.isWorkerAvailable('paid'), true);
  assert.equal(await queue.isWorkerAvailable('owner_free'), false);
  await queue.add('paid-job', 'paid');
  await queue.add('free-job', 'owner_free');
  assert.deepEqual(added, [
    { queue: 'ai-plan-reading-paid', jobId: 'paid-job', attempts: 3 },
    { queue: 'ai-plan-reading-owner-free', jobId: 'free-job', attempts: 2 },
  ]);
});

test('durable paid POST requires a paid-capable worker and returns 202 without invoking the request-local provider', async () => {
  let providerReads = 0;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let queueCapability: string | undefined;
  const findingsWriter = {
    from: () => ({}),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === 'ai_plan_worker_available') {
        assert.deepEqual(args, { p_entitlement: 'paid' });
        return { data: true, error: null };
      }
      if (fn === 'reserve_project_reading_async') {
        return {
          data: {
            reused: false,
            job: { id: 'job-1', workspace_id: 'workspace-1', project_id: 'project-1', file_id: 'file-1', status: 'queued', processing_error: null, output_summary: {} },
            quote: { id: 'quote-1', status: 'processing' },
          },
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  const reader = {
    assertReady() { throw new Error('request-local paid reader must not be touched in durable mode'); },
    async read() { providerReads += 1; throw new Error('request-local paid reader must not run'); },
  };

  await withEnv({ AI_PLAN_DURABLE_ENABLED: 'true' }, async () => {
    const response = await handleAiPlanRequest(
      new Request('https://roughbid.test/api/projects/project-1/ai-plan-readings', {
        method: 'POST',
        headers: { 'x-workspace-id': 'workspace-1', 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: 'file-1', quote_id: 'quote-1', mode: 'quick' }),
      }),
      fakeDb() as never,
      {
        findingsWriter: findingsWriter as never,
        storage: { presign: async () => ({ url: 'https://storage.invalid/source.pdf' }) },
        reader: reader as never,
        durableQueue: {
          isWorkerAvailable: async (entitlement: string) => { queueCapability = entitlement; return true; },
          add: async () => undefined,
          close: async () => undefined,
        },
      } as never,
    );

    assert.equal(response.status, 202);
    const body = await response.json() as { id: string; status: string; plan_reading_findings?: unknown[] };
    assert.equal(body.id, 'job-1');
    assert.equal(body.status, 'queued');
    assert.deepEqual(body.plan_reading_findings, []);
  });

  assert.equal(queueCapability, 'paid');
  assert.equal(providerReads, 0);
  assert.deepEqual(rpcCalls.map((call) => call.fn), ['ai_plan_worker_available', 'reserve_project_reading_async']);
});
