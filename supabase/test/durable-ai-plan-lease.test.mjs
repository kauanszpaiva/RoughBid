import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'd'.repeat(64);
const FP = 'e'.repeat(64);

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key, created_by uuid not null, ai_processing_consented_at timestamptz);
    create table public.workspace_members(workspace_id uuid, user_id uuid, role text, primary key(workspace_id,user_id));
    create table public.projects(id uuid primary key, workspace_id uuid not null);
    create table public.project_files(id uuid primary key, workspace_id uuid, project_id uuid, storage_path text, original_name text, processing_status text);
    create table public.plan_reading_jobs(
      id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
      file_id uuid not null, requested_by uuid not null, status text not null default 'queued',
      mode text not null default 'quick', model text not null, input_summary jsonb not null default '{}'::jsonb,
      output_summary jsonb not null default '{}'::jsonb, processing_error text, started_at timestamptz,
      completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table public.project_reading_quotes(
      id uuid primary key, workspace_id uuid, project_id uuid, file_id uuid, user_id uuid,
      file_sha256 text, page_count integer, trades jsonb, scope text, amount_cents integer, cost_cents integer,
      currency text, pricing_version text, membership text, livemode boolean, status text,
      attempts integer default 0, job_id uuid, paid_at timestamptz
    );
    create table private.free_owner_workspaces(workspace_id uuid primary key);

    insert into auth.users values('${id(1)}');
    insert into workspaces values('${id(10)}','${id(1)}',now());
    insert into workspace_members values('${id(10)}','${id(1)}','admin');
    insert into projects values('${id(11)}','${id(10)}');
    insert into project_files values('${id(12)}','${id(10)}','${id(11)}','${id(10)}/${id(11)}/${id(12)}/source.pdf','plan.pdf','ready');
    insert into private.free_owner_workspaces values('${id(10)}');
  `);
  await db.exec(readFileSync(new URL('../migrations/0023_durable_ai_plan_jobs.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/0024_durable_ai_worker_capabilities.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/0025_durable_ai_lease_alignment.sql', import.meta.url), 'utf8'));
  return db;
}

test('database lease expires well before the 30s BullMQ lock so a stalled job can be reclaimed', async () => {
  const db = await boot();
  try {
    const reserved = (await db.query(
      `select reserve_owner_free_reading_async($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) as result`,
      [id(1),id(10),id(11),id(12),'gemini-2.5-flash',SHA,FP,JSON.stringify(['Framing']),'garage','quick',1],
    )).rows[0].result;
    const first = (await db.query('select claim_ai_plan_reading($1,$2) as result',[reserved.job.id,'worker-a'])).rows[0].result;
    assert.equal(first.skip,false);

    const lease = await db.query(
      'select extract(epoch from (worker_lease_expires_at-now()))::int as seconds from plan_reading_jobs where id=$1',
      [reserved.job.id],
    );
    assert.ok(lease.rows[0].seconds <= 15, `DB lease must be <=15s, got ${lease.rows[0].seconds}s`);

    await assert.rejects(
      () => db.query('select claim_ai_plan_reading($1,$2)',[reserved.job.id,'worker-b']),
      /already leased/,
    );
    await db.query(`update plan_reading_jobs set worker_lease_expires_at=now()-interval '1 second' where id=$1`,[reserved.job.id]);
    const reclaimed = (await db.query('select claim_ai_plan_reading($1,$2) as result',[reserved.job.id,'worker-b'])).rows[0].result;
    assert.equal(reclaimed.skip,false);
    assert.notEqual(reclaimed.lease_id,first.lease_id);
  } finally { await db.close(); }
});
