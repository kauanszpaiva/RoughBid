import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseDeepCheckpointRepository } from '../src/takeoff-v2/service.ts';
import { runDeepTakeoff } from '../src/takeoff-v2/orchestrator.ts';
import type { DeepPassRequest, PlanSetManifest } from '../src/takeoff-v2/types.ts';

type Row = Record<string, any>;
const sensitive = 'SYNTHETIC_PRIVATE_DETAIL_DO_NOT_EXPOSE';
const manifest: PlanSetManifest = {
  fileSha256: 'a'.repeat(64), physicalPageCount: 1,
  sheets: [{ physicalPageNumber: 1, pageSha256: 'b'.repeat(64), widthPoints: 612,
    heightPoints: 792, orientation: 'portrait', rotationDegrees: 0,
    contentKind: 'unknown', textQuality: 'unknown', status: 'review_required', statusReason: 'Pending review.' }],
};
const request: DeepPassRequest = {
  runId: 'run-1', sheet: manifest.sheets[0]!, passType: 'classification',
  attempt: 1, idempotencyKey: 'c'.repeat(64), reasoningEffort: 'high',
};
const savedRow = (status: string, extra: Row = {}): Row => ({
  id: 'pass-1', takeoff_run_id: 'run-1', workspace_id: 'workspace-1', project_id: 'project-1',
  plan_sheet_id: 'sheet-1', pass_type: 'classification', attempt: 1,
  idempotency_key: request.idempotencyKey, status, checkpoint: { evidence: 'preserved' }, ...extra,
});

/** Models both unique keys and stale concurrent reads; no network or provider calls. */
class MemoryWriter {
  rows: Row[] = [];
  writes = 0;
  queries = 0;
  readError = false;
  insertError = false;
  beforeInsert: (() => void) | undefined;

  from(table: string) {
    assert.equal(table, 'takeoff_passes');
    this.queries += 1;
    const filters: Row = {};
    let action = 'read';
    let payload: Row = {};
    let returning = false;
    let single = false;
    const query: any = {};
    query.select = () => { returning = action !== 'read'; return query; };
    query.eq = (key: string, value: unknown) => { filters[key] = value; return query; };
    query.maybeSingle = () => { single = true; return query; };
    for (const method of ['insert', 'upsert', 'update']) {
      query[method] = (value: Row) => { action = method; payload = value; return query; };
    }
    query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      const response = (() => {
        if (action === 'read') {
          if (this.readError) return { data: null, error: { message: sensitive } };
          const rows = this.rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value));
          return { data: single ? rows[0] ? { ...rows[0] } : null : rows.map(row => ({ ...row })), error: null };
        }
        this.writes += 1;
        if (action === 'insert' || action === 'upsert') {
          this.beforeInsert?.();
          this.beforeInsert = undefined;
          if (this.insertError) return { data: null, error: { code: '08006', message: sensitive } };
          const existing = this.rows.find(row => row.takeoff_run_id === payload.takeoff_run_id && (
            row.idempotency_key === payload.idempotency_key || (
              row.plan_sheet_id === payload.plan_sheet_id && row.pass_type === payload.pass_type && row.attempt === payload.attempt)));
          if (existing && action === 'insert') return { data: null, error: { code: '23505', message: sensitive } };
          if (existing) Object.assign(existing, payload);
          else this.rows.push({ id: `pass-${this.rows.length + 1}`, ...payload });
          return { data: null, error: null };
        }
        const rows = this.rows.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value));
        for (const row of rows) Object.assign(row, payload);
        return { data: returning ? single ? rows[0] ?? null : rows : null, error: null };
      })();
      return Promise.resolve(response).then(resolve, reject);
    };
    return query;
  }
}

const repository = (writer: MemoryWriter) => new SupabaseDeepCheckpointRepository(
  writer as never, 'run-1', 'workspace-1', 'project-1', new Map([[1, 'sheet-1']]),
);
const isConflict = (error: unknown) => error instanceof Error && (error as Error & { status: number }).status === 409;

test('simultaneous starts grant exactly one checkpoint claim, never duplicate provider permission', async () => {
  const writer = new MemoryWriter();
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => repository(writer).begin(request)));
  assert.equal(attempts.filter(value => value.status === 'fulfilled' && value.value === 'run').length, 1);
  assert.equal(attempts.filter(value => value.status === 'rejected' && isConflict(value.reason)).length, 19);
  assert.equal(writer.rows.length, 1);
  assert.equal(writer.rows[0]!.status, 'processing');
});

for (const status of ['succeeded', 'blocked'] as const) {
  test(`${status} checkpoint is reused without writes or provider permission`, async () => {
    const writer = new MemoryWriter(); writer.rows.push(savedRow(status));
    assert.equal(await repository(writer).begin(request), `already_${status}`);
    assert.equal(writer.writes, 0);
  });
}

for (const status of ['processing', 'failed', 'queued', 'unknown']) {
  test(`${status} checkpoint cannot be blindly replayed under the same attempt`, async () => {
    const writer = new MemoryWriter(); writer.rows.push(savedRow(status));
    await assert.rejects(repository(writer).begin(request), isConflict);
    assert.equal(writer.writes, 0);
    assert.deepEqual(writer.rows[0], savedRow(status));
  });
}

test('same pass with a different idempotency identity fails closed', async () => {
  const writer = new MemoryWriter(); writer.rows.push(savedRow('succeeded', { idempotency_key: 'different' }));
  await assert.rejects(repository(writer).begin(request), isConflict);
  assert.equal(writer.writes, 0);
});

test('cross-run requests fail before any checkpoint query', async () => {
  const writer = new MemoryWriter();
  await assert.rejects(repository(writer).begin({ ...request, runId: 'other-run' }), isConflict);
  assert.equal(writer.queries, 0);
});

test('a unique-conflict loser reuses a result completed by the winner', async () => {
  const writer = new MemoryWriter();
  writer.beforeInsert = () => { writer.rows.push(savedRow('succeeded')); };
  assert.equal(await repository(writer).begin(request), 'already_succeeded');
  assert.equal(writer.rows[0]!.status, 'succeeded');
  assert.deepEqual(writer.rows[0]!.checkpoint, { evidence: 'preserved' });
});

for (const failureMode of ['readError', 'insertError'] as const) {
  test(`${failureMode} does not expose database detail or dispatch permission`, async () => {
    const writer = new MemoryWriter(); writer[failureMode] = true;
    await assert.rejects(repository(writer).begin(request), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(sensitive));
      assert.equal((error as Error & { status: number }).status, 500);
      return true;
    });
  });
}

test('successful completion updates only the claimed, processing checkpoint', async () => {
  const writer = new MemoryWriter(); const repo = repository(writer);
  assert.equal(await repo.begin(request), 'run');
  await repo.succeed(request, { status: 'succeeded', checkpoint: { evidence: 'new' } });
  assert.equal(writer.rows[0]!.status, 'succeeded');
  assert.deepEqual(writer.rows[0]!.checkpoint, { evidence: 'new' });
  await assert.rejects(repo.succeed(request, { status: 'blocked', checkpoint: { overwrite: true } }), isConflict);
  assert.equal(writer.rows[0]!.status, 'succeeded');
});

test('late failure cannot destroy an already persisted successful checkpoint', async () => {
  const writer = new MemoryWriter(); writer.rows.push(savedRow('succeeded'));
  await assert.rejects(repository(writer).fail(request, { classification: 'provider_or_pipeline_failure', message: 'Failed.' }), isConflict);
  assert.deepEqual(writer.rows[0], savedRow('succeeded'));
});

test('cross-run completion and failure cannot mutate checkpoints', async () => {
  const writer = new MemoryWriter(); writer.rows.push(savedRow('processing'));
  const repo = repository(writer); const other = { ...request, runId: 'other-run' };
  await assert.rejects(repo.succeed(other, { status: 'succeeded', checkpoint: {} }), isConflict);
  await assert.rejects(repo.fail(other, { classification: 'provider_or_pipeline_failure', message: 'Failed.' }), isConflict);
  assert.equal(writer.queries, 0);
  assert.equal(writer.writes, 0);
});

for (const [label, thrown, classification] of [
  ['provider error', new Error(sensitive), 'provider_or_pipeline_failure'],
  ['syntax error', new SyntaxError(sensitive), 'invalid_output'],
  ['non-Error rejection', sensitive, 'provider_or_pipeline_failure'],
] as const) {
  test(`${label} is classified without leaking content to summaries or checkpoints`, async () => {
    const failures: Array<{ classification: string; message: string }> = [];
    const summary = await runDeepTakeoff('run-1', manifest,
      { runPass: async () => { throw thrown; } },
      { begin: async () => 'run', succeed: async () => {}, fail: async (_request, failure) => { failures.push(failure); } });
    assert.equal(summary.failed, 1);
    assert.equal(summary.sheets[0]!.status, 'blocked');
    assert.equal(summary.sheets[0]!.passesCompleted, 0);
    assert.equal(failures[0]!.classification, classification);
    assert.doesNotMatch(JSON.stringify({ summary, failures }), new RegExp(sensitive));
    assert.match(summary.sheets[0]!.blockers[0]!, /classification/);
  });
}

test('an in-flight checkpoint rejects orchestration before the provider is called', async () => {
  const writer = new MemoryWriter();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('run-1:1:classification:1'));
  const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  writer.rows.push(savedRow('processing', { idempotency_key: key }));
  let calls = 0;
  await assert.rejects(runDeepTakeoff('run-1', manifest,
    { runPass: async () => { calls += 1; return { status: 'succeeded', checkpoint: {} }; } }, repository(writer)), isConflict);
  assert.equal(calls, 0);
});

test('the Claude provider identity is accepted and persisted with its completed pass', async () => {
  const writer = new MemoryWriter(); const repo = repository(writer);
  const pass = { status: 'succeeded' as const, checkpoint: { evidence: 'synthetic' }, provider: 'claude', model: 'verified-test-model' };
  const summary = await runDeepTakeoff('run-1', manifest, { runPass: async () => pass }, repo);
  assert.equal(summary.succeeded, 10);
  assert.equal(writer.rows.length, 10);
  assert.ok(writer.rows.every(row => row.provider === 'claude' && row.model === 'verified-test-model'));
});

for (const provider of ['', ' '.repeat(2), 'x'.repeat(161), 123]) {
  test(`invalid provider metadata (${typeof provider}, length ${String(provider).length}) fails before persistence`, async () => {
    let saved = 0; const failures: string[] = [];
    const summary = await runDeepTakeoff('run-1', manifest,
      { runPass: async () => ({ status: 'succeeded', checkpoint: {}, provider }) as never },
      { begin: async () => 'run', succeed: async () => { saved += 1; }, fail: async (_request, failure) => { failures.push(failure.classification); } });
    assert.equal(summary.failed, 1);
    assert.equal(saved, 0);
    assert.deepEqual(failures, ['invalid_output']);
  });
}
