import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../migrations/20260910225937_takeoff_v2_foundation.sql', import.meta.url), 'utf8');
const fkIndexSql = readFileSync(new URL('../migrations/20260910233003_takeoff_v2_fk_indexes.sql', import.meta.url), 'utf8');

test('takeoff v2 schema is additive, tenant scoped, and indexed', () => {
  for (const table of ['takeoff_runs','plan_sheets','takeoff_passes','scale_calibrations','takeoff_items','takeoff_evidence','takeoff_geometry','assemblies','assembly_versions','assembly_components','price_sources','price_snapshots','estimate_versions_v2','estimate_line_items_v2','estimate_adjustments_v2','estimate_recommendations_v2','estimate_rfis_v2']) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /foreign key \(project_id, workspace_id\)/);
  assert.match(sql, /takeoff_items_run_trade_status_idx/);
  for (const index of [
    'takeoff_runs_file_scope_idx',
    'takeoff_passes_sheet_scope_idx',
    'takeoff_evidence_item_scope_idx',
    'estimate_versions_v2_project_scope_idx',
    'estimate_line_items_v2_estimate_scope_idx',
    'estimate_rfis_v2_estimate_scope_idx',
  ]) assert.match(fkIndexSql, new RegExp(`create index ${index}`));
});

test('acceptance and release gates fail closed', () => {
  assert.match(sql, /Accepted takeoff items require source evidence/);
  assert.match(sql, /Measured takeoff items require verified calibration and geometry/);
  assert.match(sql, /Estimate has unpriced, provisional, expired, or review-required line items/);
  assert.match(sql, /Estimate cannot be released without line items/);
  assert.match(sql, /estimate_line_items_v2_math_gate/);
  assert.match(sql, /new\.direct_total := new\.material_total \+ new\.labor_total/);
  assert.match(sql, /Released estimate adjustments are immutable/);
  assert.match(sql, /new\.totals := jsonb_build_object/);
  assert.match(sql, /Estimate has unresolved blocking RFIs/);
  assert.match(sql, /revoke all on function public\.set_takeoff_item_review_status\(uuid, text\) from public, anon/);
});

test('migration executes on PostgreSQL and leaves browser roles read-only', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema private;
      create table auth.users(id uuid primary key default gen_random_uuid());
      create table public.workspaces(id uuid primary key default gen_random_uuid());
      create table public.projects(id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id), unique(id, workspace_id));
      create table public.project_files(id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null, unique(id, workspace_id, project_id));
      create function auth.uid() returns uuid language sql stable as 'select null::uuid';
      create function private.has_workspace_role(uuid, text[]) returns boolean language sql stable as 'select true';
      create function private.has_product_access() returns boolean language sql stable as 'select true';
    `);
    await db.exec(sql);
    await db.exec(fkIndexSql);
    const tables = await db.query(`select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('takeoff_runs','takeoff_items','estimate_versions_v2') order by tablename`);
    assert.deepEqual(tables.rows, [
      { tablename: 'estimate_versions_v2', rowsecurity: true },
      { tablename: 'takeoff_items', rowsecurity: true },
      { tablename: 'takeoff_runs', rowsecurity: true },
    ]);
    await db.exec(`
      insert into auth.users(id) values ('00000000-0000-0000-0000-000000000001');
      insert into public.workspaces(id) values ('10000000-0000-0000-0000-000000000001');
      insert into public.projects(id,workspace_id) values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001');
      insert into public.project_files(id,workspace_id,project_id) values ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
      insert into public.takeoff_runs(id,workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by)
      values ('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','deep',repeat('a',64),'v1','00000000-0000-0000-0000-000000000001');
      insert into public.estimate_versions_v2(id,workspace_id,project_id,takeoff_run_id,version,calculation_version,created_by)
      values
        ('50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',1,'test','00000000-0000-0000-0000-000000000001'),
        ('50000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',2,'test','00000000-0000-0000-0000-000000000001');
    `);
    await db.exec('set role service_role');
    await db.exec(`
      insert into public.estimate_line_items_v2(
        estimate_id,workspace_id,project_id,description,unit,raw_quantity,waste_percent,waste_quantity,
        purchasing_quantity,package_size,rounding_rule,material_rate,material_total,labor_hours,
        labor_hourly_cost,labor_total,direct_total,pricing_status
      ) values (
        '50000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000001','Drywall','SF',10,10,999,999,4,'round_up_package',
        2,999,2,5,999,999,'priced'
      )
    `);
    const calculated = await db.query(`
      select waste_quantity::text, purchasing_quantity::text, material_total::text, labor_total::text, direct_total::text
      from public.estimate_line_items_v2 where estimate_id='50000000-0000-0000-0000-000000000001'
    `);
    assert.deepEqual(calculated.rows, [{
      waste_quantity: '1.000000',
      purchasing_quantity: '12.000000',
      material_total: '24.000000',
      labor_total: '10.000000',
      direct_total: '34.000000',
    }]);
    await assert.rejects(
      db.exec(`update public.estimate_versions_v2 set status='estimate_ready' where id='50000000-0000-0000-0000-000000000002'`),
      /without line items/i,
    );
    await db.exec(`update public.estimate_versions_v2 set status='estimate_ready', totals='{"final_bid":"999"}' where id='50000000-0000-0000-0000-000000000001'`);
    const released = await db.query(`select totals->>'direct_cost' as direct_cost, totals->>'final_bid' as final_bid from public.estimate_versions_v2 where id='50000000-0000-0000-0000-000000000001'`);
    assert.deepEqual(released.rows, [{ direct_cost: '34.000000', final_bid: '34.000000' }]);
    await assert.rejects(
      db.exec(`update public.estimate_line_items_v2 set material_rate=3 where estimate_id='50000000-0000-0000-0000-000000000001'`),
      /immutable/i,
    );
    await db.exec('reset role');
    await db.exec('set role authenticated');
    await assert.rejects(db.query(`insert into public.takeoff_runs(workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'deep',repeat('a',64),'v1',gen_random_uuid())`), /permission denied/i);
  } finally {
    await db.close();
  }
});
