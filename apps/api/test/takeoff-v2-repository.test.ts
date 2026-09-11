import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SupabaseTakeoffV2Repository,
  TakeoffV2PersistenceError,
  calculateEstimateLine,
} from '../src/takeoff-v2/repository.ts';

test('line persistence recomputes waste, purchasing and all totals without floating point', () => {
  const row = calculateEstimateLine({
    description: 'Roof shingles', unit: 'SQ', rawQuantity: '10.125', wastePercent: '12.5',
    packageSize: '1', roundingRule: 'round_up_package', materialRate: '137.255',
    materialFreight: '25.50', materialTax: '48.25', laborHours: '17.75',
    laborHourlyCost: '68.375', equipmentTotal: '40', subcontractTotal: '0',
    otherDirectTotal: '5.25', pricingStatus: 'priced',
  });
  assert.equal(row.waste_quantity, '1.265625');
  assert.equal(row.purchasing_quantity, '12.000000');
  assert.equal(row.material_total, '1720.810000');
  assert.equal(row.labor_total, '1213.656250');
  assert.equal(row.direct_total, '2979.716250');
});

test('line persistence rejects malformed and out-of-range decimal inputs', () => {
  const base = { description: 'Wall', unit: 'SF', rawQuantity: '1', pricingStatus: 'priced' as const };
  assert.throws(() => calculateEstimateLine({ ...base, rawQuantity: '-1' }), /non-negative decimal/);
  assert.throws(() => calculateEstimateLine({ ...base, rawQuantity: '1.0000001' }), /at most 6/);
  assert.throws(() => calculateEstimateLine({ ...base, wastePercent: '100.000001' }), /between 0 and 100/);
  assert.throws(() => calculateEstimateLine({ ...base, packageSize: '0' }), /greater than zero/);
  assert.throws(() => calculateEstimateLine({ ...base, unit: 'square-ish' }), /canonical/);
});

type FixtureRow = Record<string, any>;

class Query {
  private filters: [string, unknown][] = [];
  private operation: 'read' | 'insert' | 'update' = 'read';
  private inserted: unknown;
  private readonly db: FakeDb;
  private readonly table: string;
  constructor(db: FakeDb, table: string) { this.db = db; this.table = table; }
  select() { return this; }
  eq(column: string, value: unknown) { this.filters.push([column, value]); return this; }
  insert(value: unknown) { this.operation = 'insert'; this.inserted = value; return this; }
  update(value: unknown) { this.operation = 'update'; this.inserted = value; return this; }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  single() { return Promise.resolve(this.execute(true)); }
  then(resolve: (value: unknown) => unknown) { return Promise.resolve(this.execute(false)).then(resolve); }
  private execute(single: boolean) {
    if (this.operation === 'insert') {
      this.db.writes.push({ table: this.table, value: this.inserted });
      const data = Array.isArray(this.inserted) ? this.inserted : { id: 'new-id', ...(this.inserted as object) };
      return { data: single && Array.isArray(data) ? data[0] : data, error: null };
    }
    const rows = (this.db.tables[this.table] ?? []).filter(row => this.filters.every(([key, value]) => row[key] === value));
    if (this.operation === 'update') {
      this.db.writes.push({ table: this.table, value: this.inserted });
      const updated = rows.map(row => Object.assign(row, this.inserted));
      return { data: single ? updated[0] ?? null : updated, error: null };
    }
    return { data: single ? rows[0] ?? null : rows, error: null };
  }
}

class FakeDb {
  writes: { table: string; value: unknown }[] = [];
  rpcCalls: { name: string; args?: Record<string, unknown> }[] = [];
  readonly tables: Record<string, FixtureRow[]>;
  constructor(tables: Record<string, FixtureRow[]>, userId?: string) {
    this.tables = tables;
    if (userId) this.auth = { getUser: async () => ({ data: { user: { id: userId } }, error: null }) };
  }
  auth?: { getUser(): Promise<{ data: { user: { id: string } }; error: null }> };
  from(table: string) { return new Query(this, table); }
  rpc(name: string, args?: Record<string, unknown>) {
    this.rpcCalls.push({ name, args });
    return Promise.resolve({ data: {}, error: null });
  }
}

const workspaceId = 'workspace-1';
const projectId = 'project-1';

function actorFixture(role = 'estimator') {
  return new FakeDb({
    workspace_members: [{ workspace_id: workspaceId, user_id: 'user-1', role }],
    projects: [{ id: projectId, workspace_id: workspaceId }],
    project_files: [{ id: 'file-1', workspace_id: workspaceId, project_id: projectId }],
    estimate_versions_v2: [{ id: 'estimate-1', workspace_id: workspaceId, project_id: projectId, status: 'draft' }],
    estimate_line_items_v2: [],
    estimate_adjustments_v2: [],
    takeoff_items: [{ id: 'item-1', workspace_id: workspaceId, project_id: projectId, review_status: 'accepted' }],
  }, 'user-1');
}

test('run creation authorizes through the actor client and writes derived actor identity with service client', async () => {
  const actor = actorFixture(); const service = new FakeDb({});
  const repository = new SupabaseTakeoffV2Repository(actor, service);
  await repository.createRun({ workspaceId, projectId, fileId: 'file-1', mode: 'full', fileSha256: 'a'.repeat(64), orchestratorVersion: 'v2' });
  assert.deepEqual(service.writes[0], { table: 'takeoff_runs', value: {
    workspace_id: workspaceId, project_id: projectId, file_id: 'file-1', mode: 'full',
    file_sha256: 'a'.repeat(64), orchestrator_version: 'v2', requested_by: 'user-1',
  } });
});

test('viewer cannot cross the service-role write boundary', async () => {
  const repository = new SupabaseTakeoffV2Repository(actorFixture('viewer'), new FakeDb({}));
  await assert.rejects(repository.createRun({ workspaceId, projectId, fileId: 'file-1', mode: 'deep', fileSha256: 'b'.repeat(64), orchestratorVersion: 'v2' }),
    (error: unknown) => error instanceof TakeoffV2PersistenceError && error.status === 403);
});

test('worker persistence derives every tenant key from the stored run', async () => {
  const service = new FakeDb({ takeoff_runs: [{ id: 'run-1', workspace_id: workspaceId, project_id: projectId, file_id: 'file-1' }] });
  const repository = new SupabaseTakeoffV2Repository(actorFixture(), service);
  await repository.persistPlanSheets('run-1', [{
    physicalPageNumber: 1, pageSha256: 'c'.repeat(64), widthPoints: 612, heightPoints: 792,
    orientation: 'portrait', rotationDegrees: 0, contentKind: 'unknown', textQuality: 'unknown',
    status: 'review_required', statusReason: 'Awaiting review',
    ...({ workspace_id: 'attacker-workspace', project_id: 'attacker-project' } as any),
  }]);
  const written = service.writes[0]!.value as FixtureRow[];
  assert.equal(written[0]!.workspace_id, workspaceId);
  assert.equal(written[0]!.project_id, projectId);
  assert.equal(written[0]!.file_id, 'file-1');
});

test('estimate lines ignore caller totals and released estimates reject child writes', async () => {
  const actor = actorFixture(); const service = new FakeDb({});
  const repository = new SupabaseTakeoffV2Repository(actor, service);
  await repository.addEstimateLine(workspaceId, projectId, 'estimate-1', {
    description: 'Concrete', unit: 'CY', rawQuantity: '2', materialRate: '100',
    pricingStatus: 'priced', ...({ directTotal: '0.01', materialTotal: '0.01' } as any),
  });
  const inserted = service.writes[0]!.value as FixtureRow;
  assert.equal(inserted.direct_total, '200.000000');
  assert.equal(inserted.material_total, '200.000000');

  actor.tables.estimate_versions_v2[0]!.status = 'final';
  await assert.rejects(repository.addEstimateLine(workspaceId, projectId, 'estimate-1', {
    description: 'Concrete', unit: 'CY', rawQuantity: '2', pricingStatus: 'priced',
  }), /immutable/);
});

test('human review uses only the authenticated narrow RPC and re-reads tenant-scoped state', async () => {
  const actor = actorFixture(); const service = new FakeDb({});
  const repository = new SupabaseTakeoffV2Repository(actor, service);
  const item = await repository.reviewTakeoffItem(workspaceId, projectId, 'item-1', 'accepted');
  assert.equal(item.id, 'item-1');
  assert.deepEqual(actor.rpcCalls, [{ name: 'set_takeoff_item_review_status', args: {
    p_takeoff_item_id: 'item-1', p_status: 'accepted',
  } }]);
  assert.equal(service.writes.length, 0);
});

test('estimate reconciliation overwrites forged persisted totals before final release', async () => {
  const actor = actorFixture();
  actor.tables.estimate_line_items_v2.push({
    id: 'line-1', estimate_id: 'estimate-1', workspace_id: workspaceId, project_id: projectId,
    description: 'Framing', unit: 'LF', raw_quantity: '10', waste_percent: '10', package_size: '1',
    rounding_rule: 'none', material_rate: '5', material_freight: '2', material_tax: '1',
    material_total: '0.01', labor_hours: '2', labor_hourly_cost: '50', labor_total: '0.01',
    equipment_total: '0', subcontract_total: '0', other_direct_total: '0', direct_total: '0.02',
    pricing_status: 'priced',
  });
  actor.tables.estimate_adjustments_v2.push({
    estimate_id: 'estimate-1', workspace_id: workspaceId, project_id: projectId,
    adjustment_type: 'overhead', amount: '15',
  });
  const service = new FakeDb({
    estimate_versions_v2: actor.tables.estimate_versions_v2,
    estimate_line_items_v2: actor.tables.estimate_line_items_v2,
  });
  const repository = new SupabaseTakeoffV2Repository(actor, service);
  const saved = await repository.recalculateEstimate(workspaceId, projectId, 'estimate-1', 'final');
  assert.equal((saved.totals as FixtureRow).direct_cost, '158.000000');
  assert.equal((saved.totals as FixtureRow).final_bid, '173.000000');
  assert.equal(saved.finalized_by, 'user-1');
  assert.equal(actor.tables.estimate_line_items_v2[0]!.material_total, '58.000000');
  assert.equal(actor.tables.estimate_line_items_v2[0]!.labor_total, '100.000000');
});

test('an empty estimate cannot exploit the database release gate', async () => {
  const repository = new SupabaseTakeoffV2Repository(actorFixture(), new FakeDb({}));
  await assert.rejects(repository.recalculateEstimate(workspaceId, projectId, 'estimate-1', 'final'), /without line items/);
});
