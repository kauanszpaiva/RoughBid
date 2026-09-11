import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema private;

    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key);
    create table public.projects(id uuid primary key, workspace_id uuid not null references public.workspaces(id));
    create table public.project_files(
      id uuid primary key,
      workspace_id uuid not null references public.workspaces(id),
      project_id uuid not null references public.projects(id)
    );
    create table public.plan_reading_jobs(
      id uuid primary key,
      workspace_id uuid not null references public.workspaces(id),
      project_id uuid not null references public.projects(id),
      file_id uuid not null references public.project_files(id),
      model text not null
    );
    create table public.plan_reading_findings(
      id uuid primary key,
      job_id uuid not null references public.plan_reading_jobs(id),
      workspace_id uuid not null references public.workspaces(id),
      project_id uuid not null references public.projects(id),
      file_id uuid not null references public.project_files(id),
      page_number integer not null,
      finding_type text not null,
      label text not null,
      value_text text,
      quantity numeric,
      unit text,
      confidence numeric not null,
      geometry jsonb not null default '{}'::jsonb,
      source_excerpt text,
      status text not null default 'needs_review'
    );

    create or replace function auth.uid() returns uuid
    language sql stable as $$ select '${id(1)}'::uuid $$;
    create or replace function private.has_workspace_access(target uuid) returns boolean
    language sql stable as $$ select target = '${id(10)}'::uuid $$;
    create or replace function private.has_workspace_role(target uuid, roles text[]) returns boolean
    language sql stable as $$ select target = '${id(10)}'::uuid and ('admin' = any(roles) or 'estimator' = any(roles)) $$;
    create or replace function private.has_product_access() returns boolean
    language sql stable as $$ select true $$;

    insert into auth.users values ('${id(1)}');
    insert into public.workspaces values ('${id(10)}'), ('${id(20)}');
    insert into public.projects values ('${id(11)}','${id(10)}'), ('${id(21)}','${id(20)}');
    insert into public.project_files values ('${id(12)}','${id(10)}','${id(11)}'), ('${id(22)}','${id(20)}','${id(21)}');
    insert into public.plan_reading_jobs values ('${id(13)}','${id(10)}','${id(11)}','${id(12)}','gemini-test');
    insert into public.plan_reading_findings values
      ('${id(14)}','${id(13)}','${id(10)}','${id(11)}','${id(12)}',1,'measurement','Wall',null,10,'LF',0.8,'{}','10 LF wall','needs_review'),
      ('${id(15)}','${id(13)}','${id(10)}','${id(11)}','${id(12)}',1,'material','Decking',null,100,'SF',0.9,'{}','100 SF decking','needs_review'),
      ('${id(16)}','${id(13)}','${id(10)}','${id(11)}','${id(12)}',2,'symbol','Door A',null,1,'EA',0.7,'{}','Door A','needs_review');
  `);
  await db.exec(readFileSync(new URL('../migrations/20260911173000_plan_reading_ground_truth_reviews.sql', import.meta.url), 'utf8'));
  return db;
}

test('migration executes and corrected review preserves original prediction separately from canonical target', async () => {
  const db = await boot();
  try {
    const reviewed = await db.query(
      `select action, original_prediction, canonical_target, model, training_eligible
       from public.review_plan_reading_finding($1,'corrected',$2::jsonb)`,
      [id(14), JSON.stringify({ quantity: 12, unit: 'LF' })],
    );
    assert.equal(reviewed.rows.length, 1);
    assert.equal(reviewed.rows[0].action, 'corrected');
    assert.equal(Number(reviewed.rows[0].original_prediction.quantity), 10);
    assert.equal(Number(reviewed.rows[0].canonical_target.quantity), 12);
    assert.equal(reviewed.rows[0].canonical_target.label, 'Wall');
    assert.equal(reviewed.rows[0].model, 'gemini-test');
    assert.equal(reviewed.rows[0].training_eligible, false);

    const finding = await db.query('select quantity, status from public.plan_reading_findings where id=$1', [id(14)]);
    assert.equal(Number(finding.rows[0].quantity), 10, 'model prediction must remain immutable');
    assert.equal(finding.rows[0].status, 'accepted');
  } finally {
    await db.close();
  }
});

test('legacy accept/reject RPC records review events while preserving its finding return contract', async () => {
  const db = await boot();
  try {
    const accepted = await db.query(`select id,status from public.set_plan_reading_finding_status($1,'accepted')`, [id(15)]);
    assert.deepEqual(accepted.rows, [{ id: id(15), status: 'accepted' }]);
    const rejected = await db.query(`select id,status from public.set_plan_reading_finding_status($1,'rejected')`, [id(16)]);
    assert.deepEqual(rejected.rows, [{ id: id(16), status: 'rejected' }]);

    const reviews = await db.query(
      `select finding_id, action, canonical_target, training_eligible
       from public.plan_reading_finding_reviews
       where finding_id in ($1,$2)
       order by finding_id`,
      [id(15), id(16)],
    );
    assert.equal(reviews.rows.length, 2);
    assert.equal(reviews.rows[0].action, 'accepted');
    assert.equal(Number(reviews.rows[0].canonical_target.quantity), 100);
    assert.equal(reviews.rows[0].training_eligible, false);
    assert.equal(reviews.rows[1].action, 'rejected');
    assert.equal(reviews.rows[1].canonical_target, null);
    assert.equal(reviews.rows[1].training_eligible, false);
  } finally {
    await db.close();
  }
});

test('invalid correction fields and cross-workspace reviews fail closed', async () => {
  const db = await boot();
  try {
    await assert.rejects(
      () => db.query(`select * from public.review_plan_reading_finding($1,'corrected',$2::jsonb)`, [id(14), JSON.stringify({ confidence: 1 })]),
      /unsupported fields/i,
    );

    await db.query(`insert into public.plan_reading_jobs values ($1,$2,$3,$4,'gemini-test')`, [id(23), id(20), id(21), id(22)]);
    await db.query(
      `insert into public.plan_reading_findings values ($1,$2,$3,$4,$5,1,'measurement','Foreign wall',null,5,'LF',0.5,'{}','5 LF','needs_review')`,
      [id(24), id(23), id(20), id(21), id(22)],
    );
    await assert.rejects(
      () => db.query(`select * from public.review_plan_reading_finding($1,'accepted',null)`, [id(24)]),
      /insufficient workspace role/i,
    );
  } finally {
    await db.close();
  }
});
