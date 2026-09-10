import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { handleAiPlanRequest } from '../src/ai-plan/routes.ts';
import {
  FullTakeoffV2Service,
  type FullTakeoffV2Persistence,
} from '../src/takeoff-v2/service.ts';
import type { DeepPassRequest, DeepPassResult, PlanSetManifest } from '../src/takeoff-v2/types.ts';
import type { DeepRunSummary } from '../src/takeoff-v2/orchestrator.ts';

function query(data: unknown) {
  const builder: any = {};
  for (const method of ['select', 'eq', 'maybeSingle']) builder[method] = () => builder;
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
  return builder;
}

function requestDb(pageCount = 2, platformAdmin = true) {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    storage: { from: () => ({}) },
    from(table: string) {
      if (table === 'profiles') return query({ is_platform_admin: platformAdmin });
      if (table === 'workspaces') return query({ ai_processing_consented_at: '2026-09-10T00:00:00Z' });
      if (table === 'workspace_members') return query({ role: 'estimator' });
      if (table === 'projects') return query({ id: 'project-1' });
      if (table === 'project_files') return query({
        id: 'file-1', storage_path: 'workspace-1/project-1/file-1/source.pdf', processing_status: 'ready', page_count: pageCount,
      });
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

class MemoryPersistence implements FullTakeoffV2Persistence {
  runId = 'run-1';
  prepared = 0;
  manifest: PlanSetManifest | null = null;
  finished: Array<{ runId: string; summary: DeepRunSummary }> = [];
  checkpoints = new Map<string, { request: DeepPassRequest; result: DeepPassResult }>();

  async prepare(input: { manifest: PlanSetManifest }) {
    this.prepared += 1;
    this.manifest = input.manifest;
    return {
      runId: this.runId,
      resumed: this.prepared > 1,
      checkpoints: {
        begin: async (request: DeepPassRequest) => {
          const saved = this.checkpoints.get(request.idempotencyKey);
          return !saved ? 'run' as const : saved.result.status === 'blocked' ? 'already_blocked' as const : 'already_succeeded' as const;
        },
        succeed: async (request: DeepPassRequest, result: DeepPassResult) => { this.checkpoints.set(request.idempotencyKey, { request, result }); },
        fail: async () => {},
      },
    };
  }

  async finish(runId: string, summary: DeepRunSummary) {
    this.finished.push({ runId, summary });
    return summary.failed ? 'failed' as const : 'needs_review' as const;
  }
}

async function twoPagePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.addPage([792, 612]);
  return new Uint8Array(await pdf.save());
}

test('full_v2 preflights every page, checkpoints each sheet/pass, and resumes without repeat provider calls', async () => {
  const bytes = await twoPagePdf();
  const persistence = new MemoryPersistence();
  let providerCalls = 0;
  const service = new FullTakeoffV2Service(
    requestDb() as never,
    { presign: async () => ({ url: 'https://storage.test/plan.pdf' }) },
    persistence,
    { create: ({ fileBytes, manifest }) => {
      assert.equal(fileBytes.byteLength, bytes.byteLength);
      assert.equal(manifest.physicalPageCount, 2);
      return { runPass: async () => {
        providerCalls += 1;
        return { status: 'succeeded', checkpoint: { evidence: 'bounded' }, model: 'deep-model' };
      } };
    } },
    'user-1',
    'workspace-1',
    (async () => new Response(bytes)) as typeof fetch,
  );

  const first = await service.create('project-1', { file_id: 'file-1', mode: 'full_v2' });
  assert.equal(providerCalls, 20);
  assert.equal(first.output_summary.takeoff_v2.releaseStatus, 'review_ready');
  assert.deepEqual(first.output_summary.takeoff_v2.sheets.map(sheet => [sheet.physicalPageNumber, sheet.passesCompleted]), [[1, 10], [2, 10]]);
  assert.equal(persistence.manifest?.sheets.length, 2);

  const second = await service.create('project-1', { file_id: 'file-1', mode: 'full_v2' });
  assert.equal(second.resumed, true);
  assert.equal(providerCalls, 20, 'completed idempotency keys must not spend again');
  assert.equal(second.output_summary.takeoff_v2.releaseStatus, 'review_ready');
});

test('full_v2 fails closed when stored page count disagrees with deterministic preflight', async () => {
  const bytes = await twoPagePdf();
  const persistence = new MemoryPersistence();
  let providerCreated = false;
  const service = new FullTakeoffV2Service(
    requestDb(3) as never,
    { presign: async () => ({ url: 'https://storage.test/plan.pdf' }) },
    persistence,
    { create: () => { providerCreated = true; return { runPass: async () => ({ status: 'succeeded', checkpoint: {} }) }; } },
    'user-1', 'workspace-1', (async () => new Response(bytes)) as typeof fetch,
  );
  await assert.rejects(service.create('project-1', { file_id: 'file-1', mode: 'full_v2' }), (error: any) => error.status === 409);
  assert.equal(persistence.prepared, 0);
  assert.equal(providerCreated, false);
});

test('a blocked pass remains blocked on resume and is not sent to the provider twice', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const bytes = new Uint8Array(await pdf.save());
  const persistence = new MemoryPersistence();
  let providerCalls = 0;
  const service = new FullTakeoffV2Service(
    requestDb(1) as never,
    { presign: async () => ({ url: 'https://storage.test/plan.pdf' }) },
    persistence,
    { create: () => ({ runPass: async (request) => {
      providerCalls += 1;
      return request.passType === 'geometry'
        ? { status: 'blocked', checkpoint: { reason: 'conflicting scale' } }
        : { status: 'succeeded', checkpoint: {} };
    } }) },
    'user-1', 'workspace-1', (async () => new Response(bytes)) as typeof fetch,
  );
  const first = await service.create('project-1', { file_id: 'file-1', mode: 'full_v2' });
  assert.equal(first.output_summary.takeoff_v2.releaseStatus, 'blocked');
  assert.match(first.output_summary.takeoff_v2.sheets[0]!.blockers[0]!, /geometry/);
  await service.create('project-1', { file_id: 'file-1', mode: 'full_v2' });
  assert.equal(providerCalls, 10);
  assert.equal(persistence.finished.at(-1)!.summary.blocked, 1);
});

test('the explicit full_v2 route cannot fall through to Quick/Pilot or start without authorization and a provider', async () => {
  let quickCalls = 0;
  const dependencies = {
    findingsWriter: { from: () => ({}) },
    storage: { presign: async () => ({ url: 'https://storage.test/plan.pdf' }) },
    reader: { read: async () => { quickCalls += 1; throw new Error('Quick must not run'); } },
    paidReaderAvailable: true,
  };
  const makeRequest = () => new Request('https://roughbid.test/api/projects/project-1/ai-plan-readings', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'workspace-1' },
    body: JSON.stringify({ file_id: 'file-1', mode: 'full_v2' }),
  });
  const denied = await handleAiPlanRequest(makeRequest(), requestDb(2, false) as never, dependencies as never);
  assert.equal(denied.status, 403);
  const unconfigured = await handleAiPlanRequest(makeRequest(), requestDb(2, true) as never, dependencies as never);
  assert.equal(unconfigured.status, 503);
  assert.equal(quickCalls, 0);
});
