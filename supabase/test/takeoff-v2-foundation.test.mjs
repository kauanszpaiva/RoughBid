import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = readFileSync(new URL('../migrations/20260910225937_takeoff_v2_foundation.sql', import.meta.url), 'utf8');

test('takeoff v2 schema is additive, tenant scoped, and indexed', () => {
  for (const table of ['takeoff_runs','plan_sheets','takeoff_passes','scale_calibrations','takeoff_items','takeoff_evidence','takeoff_geometry','assemblies','assembly_versions','assembly_components','price_sources','price_snapshots','estimate_versions_v2','estimate_line_items_v2','estimate_adjustments_v2','estimate_recommendations_v2','estimate_rfis_v2']) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`));
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(sql, /foreign key \(project_id, workspace_id\)/);
  assert.match(sql, /takeoff_items_run_trade_status_idx/);
});

test('acceptance and release gates fail closed', () => {
  assert.match(sql, /Accepted takeoff items require source evidence/);
  assert.match(sql, /Measured takeoff items require verified calibration and geometry/);
  assert.match(sql, /Estimate has unpriced, provisional, expired, or review-required line items/);
  assert.match(sql, /Estimate has unresolved blocking RFIs/);
  assert.match(sql, /revoke all on function public\.set_takeoff_item_review_status\(uuid, text\) from public, anon/);
});

test('migration executes on PostgreSQL and leaves browser roles read-only', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
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
    const tables = await db.query(`select tablename, rowsecurity from pg_tables where schemaname='public' and tablename in ('takeoff_runs','takeoff_items','estimate_versions_v2') order by tablename`);
    assert.deepEqual(tables.rows, [
      { tablename: 'estimate_versions_v2', rowsecurity: true },
      { tablename: 'takeoff_items', rowsecurity: true },
      { tablename: 'takeoff_runs', rowsecurity: true },
    ]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query(`insert into public.takeoff_runs(workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'deep',repeat('a',64),'v1',gen_random_uuid())`), /permission denied/i);
  } finally {
    await db.close();
  }
});
