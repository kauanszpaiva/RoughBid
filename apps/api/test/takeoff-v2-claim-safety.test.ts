import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import {
  DEEP_PASS_ORDER,
  DeepPassOutputError,
  REDACTED_PROVIDER_FAILURE,
  redactDeepPassFailure,
  runDeepTakeoff,
} from '../src/takeoff-v2/orchestrator.ts';
import {
  FULL_TAKEOFF_V2_IN_PROGRESS,
  FULL_TAKEOFF_V2_LEASE_MS,
  FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION,
  SupabaseFullTakeoffV2Persistence,
} from '../src/takeoff-v2/service.ts';
import type { DeepPassRequest, PlanSetManifest } from '../src/takeoff-v2/types.ts';

type Row = Record<string, any>;

/** Minimal PostgREST double with the uniqueness the V2 migration declares. */
class FakeWriter {
  readonly tables: Record<string, Row[]>;
  readonly uniqueKeys: Record<string, string[]> = {
    takeoff_runs: ['workspace_id', 'project_id', 'file_id', 'file_sha256', 'mode', 'orchestrator_version'],
    takeoff_passes: ['takeoff_run_id', 'plan_sheet_id', 'pass_type', 'attempt'],
    plan_sheets: ['takeoff_run_id', 'physical_page_number'],
  };
  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = { takeoff_runs: [], plan_sheets: [], takeoff_passes: [], ...tables };
  }
  from(table: string) { return new FakeQuery(this, table); }
  rows(table: string) { return this.tables[table] ?? (this.tables[table] = []); }
  conflict(table: string, candidate: Row): Row | undefined {
    const keys = this.uniqueKeys[table] ?? [];
    return this.rows(table).find(row => keys.every(key => row[key] === candidate[key]));
  }
}

class FakeQuery {
  private filters: [string, unknown][] = [];
  private operation: 'read' | 'insert' | 'update' | 'upsert' = 'read';
  private payload: any;
  private readonly writer: FakeWriter;
  private readonly table: string;
  constructor(writer: FakeWriter, table: string) { this.writer = writer; this.table = table; }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  insert(value: any) { this.operation = 'insert'; this.payload = value; return this; }
  update(value: any) { this.operation = 'update'; this.payload = value; return this; }
  upsert(value: any) { this.operation = 'upsert'; this.payload = value; return this; }
  maybeSingle() { return Promise.resolve(this.run(true)); }
  single() { return Promise.resolve(this.run(true)); }
  then(resolve: (value: unknown) => unknown) { return Promise.resolve(this.run(false)).then(resolve); }
  private matches(row: Row) { return this.filters.every(([key, value]) => row[key] === value); }
  private run(single: boolean) {
    const rows = this.writer.rows(this.table);
    if (this.operation === 'insert') {
      const candidates: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const candidate of candidates) {
        if (this.writer.conflict(this.table, candidate)) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
      }
      const inserted = candidates.map((candidate, index) => ({ id: `${this.table}-${rows.length + index + 1}`, ...candidate }));
      rows.push(...inserted);
      return { data: single ? inserted[0] : inserted, error: null };
    }
    if (this.operation === 'upsert') {
      const candidates: Row[] = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const candidate of candidates) {
        const existing = this.writer.conflict(this.table, candidate);
        if (existing) Object.assign(existing, candidate);
        else rows.push({ id: `${this.table}-${rows.length + 1}`, ...candidate });
      }
      return { data: null, error: null };
    }
    const selected = rows.filter(row => this.matches(row));
    if (this.operation === 'update') {
      const updated = selected.map(row => Object.assign(row, this.payload));
      return { data: single ? updated[0] ?? null : updated, error: null };
    }
    return { data: single ? selected[0] ?? null : selected, error: null };
  }
}

async function manifestOf(pages: number): Promise<PlanSetManifest> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) pdf.addPage([612, 792]);
  return createPlanSetManifest(await pdf.save());
}

function prepareInput(manifest: PlanSetManifest) {
  return { manifest, workspaceId: 'workspace-1', projectId: 'project-1', fileId: 'file-1', requestedBy: 'user-1' };
}

test('a second simultaneous start is refused instead of sharing one live run', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);

  const first = await persistence.prepare(prepareInput(manifest));
  assert.equal(first.resumed, false);
  await assert.rejects(
    () => persistence.prepare(prepareInput(manifest)),
    (error: any) => error.status === 409 && error.message === FULL_TAKEOFF_V2_IN_PROGRESS,
  );
  assert.equal(writer.rows('takeoff_runs').length, 1);
  assert.equal(writer.rows('takeoff_runs')[0]?.orchestrator_version, FULL_TAKEOFF_V2_ORCHESTRATOR_VERSION);
});

test('an abandoned run is resumable once its lease expires', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  await persistence.prepare(prepareInput(manifest));

  const run = writer.rows('takeoff_runs')[0]!;
  run.updated_at = new Date(Date.now() - FULL_TAKEOFF_V2_LEASE_MS - 1_000).toISOString();
  const resumed = await persistence.prepare(prepareInput(manifest));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.runId, String(run.id));
  assert.equal(writer.rows('takeoff_runs').length, 1);
});

test('a pass held by a live run is never replayed, and stays unbilled', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  const prepared = await persistence.prepare(prepareInput(manifest));

  const request = {
    runId: prepared.runId,
    sheet: manifest.sheets[0]!,
    passType: 'classification',
    attempt: 1,
    idempotencyKey: 'key-live',
    reasoningEffort: 'high',
  } satisfies DeepPassRequest;

  assert.equal(await prepared.checkpoints.begin(request), 'run');
  assert.equal(await prepared.checkpoints.begin({ ...request, idempotencyKey: 'key-second' }), 'already_claimed');
  assert.equal(writer.rows('takeoff_passes').length, 1);
  assert.equal(writer.rows('takeoff_passes')[0]?.idempotency_key, 'key-live');
});

test('a pass whose outcome was never recorded is reclaimed only after the lease expires', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  const prepared = await persistence.prepare(prepareInput(manifest));
  const request = {
    runId: prepared.runId,
    sheet: manifest.sheets[0]!,
    passType: 'geometry',
    attempt: 1,
    idempotencyKey: 'key-crashed',
    reasoningEffort: 'high',
  } satisfies DeepPassRequest;

  assert.equal(await prepared.checkpoints.begin(request), 'run');
  const pass = writer.rows('takeoff_passes')[0]!;
  pass.started_at = new Date(Date.now() - FULL_TAKEOFF_V2_LEASE_MS - 1_000).toISOString();

  assert.equal(await prepared.checkpoints.begin({ ...request, idempotencyKey: 'key-retry' }), 'run');
  assert.equal(writer.rows('takeoff_passes').length, 1);
  assert.equal(pass.idempotency_key, 'key-retry');
  assert.equal(pass.status, 'processing');
});

test('a settled pass is reported, not re-run, whatever the lease says', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  const prepared = await persistence.prepare(prepareInput(manifest));
  const base = {
    runId: prepared.runId,
    sheet: manifest.sheets[0]!,
    attempt: 1,
    reasoningEffort: 'high',
  } as const;

  await prepared.checkpoints.begin({ ...base, passType: 'classification', idempotencyKey: 'key-a' });
  await prepared.checkpoints.succeed(
    { ...base, passType: 'classification', idempotencyKey: 'key-a' },
    { status: 'succeeded', checkpoint: { evidence: 'bounded' } },
  );
  assert.equal(
    await prepared.checkpoints.begin({ ...base, passType: 'classification', idempotencyKey: 'key-a' }),
    'already_succeeded',
  );

  await prepared.checkpoints.begin({ ...base, passType: 'discipline', idempotencyKey: 'key-b' });
  await prepared.checkpoints.succeed(
    { ...base, passType: 'discipline', idempotencyKey: 'key-b' },
    { status: 'blocked', checkpoint: { blocker: 'missing legend' } },
  );
  assert.equal(
    await prepared.checkpoints.begin({ ...base, passType: 'discipline', idempotencyKey: 'key-b' }),
    'already_blocked',
  );
});

test('a claimed pass stops that sheet without charging a provider call', async () => {
  const manifest = await manifestOf(1);
  let providerCalls = 0;
  const summary = await runDeepTakeoff('run-claimed', manifest, {
    async runPass() {
      providerCalls += 1;
      return { status: 'succeeded', checkpoint: {} };
    },
  }, {
    async begin(request: DeepPassRequest) { return request.passType === 'classification' ? 'run' : 'already_claimed'; },
    async succeed() {},
    async fail() { throw new Error('A claimed pass is not a failure of this run.'); },
  });

  assert.equal(providerCalls, 1);
  assert.equal(summary.claimed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.sheets[0]?.status, 'blocked');
  assert.equal(summary.sheets[0]?.passesCompleted, 1);
  assert.ok(summary.sheets[0]?.passesCompleted !== DEEP_PASS_ORDER.length);
  assert.match(summary.sheets[0]?.blockers[0] ?? '', /claimed by another Full Takeoff run/);
});

test('a run that only lost passes to another claim does not write a terminal status', async () => {
  const manifest = await manifestOf(1);
  const writer = new FakeWriter();
  const persistence = new SupabaseFullTakeoffV2Persistence(writer as never);
  const prepared = await persistence.prepare(prepareInput(manifest));

  const status = await persistence.finish(prepared.runId, {
    attempted: 0, succeeded: 0, blocked: 0, failed: 0, claimed: 3, sheets: [],
  });
  assert.equal(status, 'processing');
  assert.equal(writer.rows('takeoff_runs')[0]?.status, 'processing');
  assert.equal(writer.rows('takeoff_runs')[0]?.completed_at ?? null, null);
});

test('provider exception text never reaches the summary or the persisted checkpoint', async () => {
  const manifest = await manifestOf(1);
  const secret = 'HTTP 400 from provider: {"apiKey":"sk-live-should-never-surface"}';
  const failures: Array<{ classification: string; message: string }> = [];
  const summary = await runDeepTakeoff('run-redacted', manifest, {
    async runPass() { throw new Error(secret); },
  }, {
    async begin() { return 'run'; },
    async succeed() { throw new Error('A thrown pass must not be persisted as success.'); },
    async fail(_request, failure) { failures.push(failure); },
  });

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.classification, 'provider_or_pipeline_failure');
  assert.equal(failures[0]?.message, REDACTED_PROVIDER_FAILURE);
  const serialized = JSON.stringify({ summary, failures });
  assert.ok(!serialized.includes('sk-live-should-never-surface'));
  assert.ok(!serialized.includes('HTTP 400 from provider'));
});

test('redaction keeps our own validation text and drops everything else', () => {
  assert.deepEqual(redactDeepPassFailure(new DeepPassOutputError('Deep pass returned an invalid status.')), {
    classification: 'invalid_output',
    message: 'Deep pass returned an invalid status.',
  });
  for (const error of [new SyntaxError('Unexpected token < in JSON at position 0 of https://provider/internal'), 'plain string', undefined]) {
    const redacted = redactDeepPassFailure(error);
    assert.equal(redacted.classification, 'provider_or_pipeline_failure');
    assert.equal(redacted.message, REDACTED_PROVIDER_FAILURE);
  }
});
