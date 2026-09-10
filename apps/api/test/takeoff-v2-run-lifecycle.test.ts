import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SupabaseFullTakeoffV2Persistence } from '../src/takeoff-v2/service.ts';
import type { DeepPassRequest, PlanSetManifest } from '../src/takeoff-v2/types.ts';

type Row = Record<string, any>;
class Writer {
  tables: Record<string, Row[]> = { takeoff_runs: [], plan_sheets: [], takeoff_passes: [] };
  writes: string[] = [];
  failTable: string | null = null;
  from(table: string) { return new Query(this, table); }
}
class Query {
  filters: Array<[string, unknown]> = [];
  operation = 'read';
  payload: any;
  options: any;
  constructor(privateWriter: Writer, privateTable: string) { this.writer = privateWriter; this.table = privateTable; }
  writer: Writer;
  table: string;
  select() { return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  insert(payload: any) { this.operation = 'insert'; this.payload = payload; return this; }
  update(payload: any) { this.operation = 'update'; this.payload = payload; return this; }
  upsert(payload: any, options: any) { this.operation = 'upsert'; this.payload = payload; this.options = options; return this; }
  maybeSingle() { return Promise.resolve(this.run(true)); }
  single() { return Promise.resolve(this.run(true)); }
  then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) { return Promise.resolve(this.run(false)).then(resolve, reject); }
  run(single: boolean): { data: any; error: { code: string; message: string } | null } {
    if (this.writer.failTable === this.table) return { data: null, error: { code: 'XX000', message: 'PRIVATE_DATABASE_DETAIL' } };
    const rows = this.writer.tables[this.table]!;
    const keys = this.table === 'takeoff_runs'
      ? ['workspace_id', 'project_id', 'file_id', 'file_sha256', 'mode', 'orchestrator_version']
      : this.table === 'plan_sheets' ? ['takeoff_run_id', 'physical_page_number']
      : ['takeoff_run_id', 'plan_sheet_id', 'pass_type', 'attempt'];
    if (this.operation === 'insert' || this.operation === 'upsert') {
      const values: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      const changed: Row[] = [];
      for (const value of values) {
        const match = rows.find(row => keys.every(key => row[key] === value[key]));
        if (match && this.operation === 'insert') return { data: null, error: { code: '23505', message: 'Duplicate' } };
        if (match) {
          if (!this.options?.ignoreDuplicates) { Object.assign(match, value); changed.push(match); this.writer.writes.push(this.table); }
        } else {
          const row = { id: `${this.table}-${rows.length + 1}`, updated_at: '2026-09-10T00:00:00Z', ...value };
          rows.push(row); changed.push(row); this.writer.writes.push(this.table);
        }
      }
      return { data: structuredClone(single ? changed[0] ?? null : changed), error: null };
    }
    const selected = rows.filter(row => this.filters.every(([key, value]) => row[key] === value));
    if (this.operation === 'update') {
      for (const row of selected) { Object.assign(row, this.payload); this.writer.writes.push(this.table); }
    }
    return { data: structuredClone(single ? selected[0] ?? null : selected), error: null };
  }
}
const manifest: PlanSetManifest = {
  fileSha256: 'a'.repeat(64), physicalPageCount: 1,
  sheets: [{ physicalPageNumber: 1, pageSha256: 'b'.repeat(64), widthPoints: 612, heightPoints: 792,
    orientation: 'portrait', rotationDegrees: 0, contentKind: 'unknown', textQuality: 'unknown',
    status: 'review_required', statusReason: 'Physical page accounted for.' }],
};
const input = { manifest, workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1', requestedBy: 'user-1' };
const summary = { attempted: 10, succeeded: 10, blocked: 0, failed: 0, sheets: [] };
const denied = (error: any) => error.status === 409 && !String(error.message).includes('PRIVATE_DATABASE_DETAIL');
function pass(runId: string, passType: DeepPassRequest['passType'] = 'classification'): DeepPassRequest {
  return { runId, sheet: manifest.sheets[0]!, passType, attempt: 1, reasoningEffort: 'high',
    idempotencyKey: createHash('sha256').update(`${runId}:1:${passType}:1`).digest('hex') };
}
async function setup() {
  const writer = new Writer();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  const prepared = await persistence.prepare(input);
  return { writer, persistence, prepared, run: writer.tables.takeoff_runs![0]! };
}

test('twenty simultaneous starts grant exactly one entire-run owner', async () => {
  const writer = new Writer();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => new SupabaseFullTakeoffV2Persistence(writer as never).prepare(input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && denied(result.reason)).length, 19);
  assert.equal(writer.tables.takeoff_runs!.length, 1);
});

for (const [status, stamp] of [
  ['processing', '2000-01-01T00:00:00Z'], ['processing', null], ['processing', 'invalid'],
  ['failed', '2000-01-01T00:00:00Z'], ['queued', '2000-01-01T00:00:00Z'],
  ['cancelled', '2000-01-01T00:00:00Z'], ['unknown', '2000-01-01T00:00:00Z'],
] as const) {
  test(`existing ${status} run with ${stamp} cannot be restarted by elapsed time`, async () => {
    const { writer, run } = await setup();
    run.status = status; run.updated_at = stamp;
    const before = structuredClone(writer.tables); writer.writes = [];
    await assert.rejects(new SupabaseFullTakeoffV2Persistence(writer as never).prepare(input), denied);
    assert.deepEqual(writer.tables, before); assert.equal(writer.writes.length, 0);
  });
}

for (const status of ['needs_review', 'ready'] as const) {
  test(`completed ${status} run reuses checkpoints read-only and preserves human sheet decisions`, async () => {
    const { writer, prepared, run } = await setup();
    const request = pass(prepared.runId);
    await prepared.checkpoints.begin(request);
    await prepared.checkpoints.succeed(request, { status: 'succeeded', checkpoint: { evidence: 'saved' } });
    run.status = status; run.completed_at = '2026-09-10T01:00:00Z';
    writer.tables.plan_sheets![0]!.status = 'reviewed';
    writer.tables.plan_sheets![0]!.status_reason = 'Human confirmed sheet classification';
    const before = structuredClone(writer.tables); writer.writes = [];
    const reused: any = await new SupabaseFullTakeoffV2Persistence(writer as never).prepare(input);
    assert.equal(reused.completedStatus, status);
    assert.equal(await reused.checkpoints.begin(request), 'already_succeeded');
    await assert.rejects(reused.checkpoints.begin(pass(prepared.runId, 'geometry')), denied);
    await assert.rejects(reused.checkpoints.succeed(request, { status: 'succeeded', checkpoint: {} }), denied);
    await assert.rejects(reused.checkpoints.fail(request, { classification: 'other', message: 'other' }), denied);
    assert.deepEqual(writer.tables, before); assert.equal(writer.writes.length, 0);
  });
}

test('a persistence instance without the run claim cannot finish another run', async () => {
  const { writer, prepared } = await setup();
  writer.writes = [];
  await assert.rejects(new SupabaseFullTakeoffV2Persistence(writer as never).finish(prepared.runId, summary), denied);
  assert.equal(writer.writes.length, 0);
});

test('changed run claim stamp prevents a stale finisher from writing', async () => {
  const { writer, persistence, prepared, run } = await setup();
  run.updated_at = '2099-01-01T00:00:00Z'; writer.writes = [];
  await assert.rejects(persistence.finish(prepared.runId, summary), denied);
  assert.equal(run.status, 'processing'); assert.equal(writer.writes.length, 0);
});

test('cancelled run is not overwritten by a late successful finisher', async () => {
  const { writer, persistence, prepared, run } = await setup();
  run.status = 'cancelled'; writer.writes = [];
  await assert.rejects(persistence.finish(prepared.runId, summary), denied);
  assert.equal(run.status, 'cancelled'); assert.equal(writer.writes.length, 0);
});

test('the owner finishes once and cannot overwrite the terminal run again', async () => {
  const { persistence, prepared, run } = await setup();
  assert.equal(await persistence.finish(prepared.runId, summary), 'needs_review');
  assert.equal(run.status, 'needs_review');
  await assert.rejects(persistence.finish(prepared.runId, { ...summary, failed: 1 }), denied);
  assert.equal(run.status, 'needs_review');
});

test('database failure during run lookup exposes no private detail and does not write', async () => {
  const writer = new Writer(); writer.failTable = 'takeoff_runs';
  await assert.rejects(new SupabaseFullTakeoffV2Persistence(writer as never).prepare(input), (error: any) =>
    error.status === 500 && !String(error.message).includes('PRIVATE_DATABASE_DETAIL'));
  assert.equal(writer.writes.length, 0);
});
