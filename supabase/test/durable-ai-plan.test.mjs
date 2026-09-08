import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = 'a'.repeat(64);
const FP = 'b'.repeat(64);

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema private;

    create table auth.users(id uuid primary key);
    create table public.workspaces(
      id uuid primary key,
      created_by uuid not null,
      ai_processing_consented_at timestamptz
    );
    create table public.workspace_members(
      workspace_id uuid not null,
      user_id uuid not null,
      role text not null,
      primary key(workspace_id,user_id)
    );
    create table public.projects(
      id uuid primary key,
      workspace_id uuid not null
    );
    create table public.project_files(
      id uuid primary key,
      workspace_id uuid not null,
      project_id uuid not null,
      storage_path text not null,
      original_name text not null,
      processing_status text not null
    );
    create table public.plan_reading_jobs(
      id uuid primary key default gen_random_uuid(),
      workspace_id uuid not null,
      project_id uuid not null,
      file_id uuid not null,
      requested_by uuid not null,
      status text not null default 'queued',
      mode text not null default 'quick',
      model text not null,
      input_summary jsonb not null default '{}'::jsonb,
      output_summary jsonb not null default '{}'::jsonb,
      processing_error text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table public.project_reading_quotes(
      id uuid primary key,
      workspace_id uuid not null,
      project_id uuid not null,
      file_id uuid not null,
      user_id uuid not null,
      file_sha256 text not null,
      page_count integer not null,
      trades jsonb not null,
      scope text not null,
      amount_cents integer not null,
      cost_cents integer not null,
      currency text not null default 'usd',
      pricing_version text not null,
      membership text not null,
      livemode boolean not null,
      status text not null,
      attempts integer not null default 0,
      job_id uuid,
      paid_at timestamptz
    );
    create table private.free_owner_workspaces(
      workspace_id uuid primary key
    );

    insert into auth.users values('${id(1)}'),('${id(2)}');
    insert into workspaces values('${id(10)}','${id(1)}',now()),('${id(20)}','${id(2)}',now());
    insert into workspace_members values('${id(10)}','${id(1)}','admin'),('${id(20)}','${id(2)}','admin');
    insert into projects values('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
    insert into project_files values(
      '${id(12)}','${id(10)}','${id(11)}','${id(10)}/${id(11)}/${id(12)}/source.pdf','owner.pdf','ready'),
      ('${id(22)}','${id(20)}','${id(21)}','${id(20)}/${id(21)}/${id(22)}/source.pdf','paid.pdf','ready')
    );
    insert into private.free_owner_workspaces values('${id(10)}');
  `);
  await db.exec(readFileSync(new URL('../migrations/0023_durable_ai_plan_jobs.sql', import.meta.url), 'utf8'));
  return db;
}

async function reserveOwner(db, fingerprint = FP) {
  return (await db.query(
    `select reserve_owner_free_reading_async(
      $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11
    ) as result`,
    [id(1), id(10), id(11), id(12), 'gemini-2.5-flash', SHA, fingerprint, JSON.stringify(['Framing']), 'garage', 'quick', 3],
  )).rows[0].result;
}

async function insertPaidQuote(db, quoteId = id(30)) {
  await db.query(
    `insert into project_reading_quotes(
      id,workspace_id,project_id,file_id,user_id,file_sha256,page_count,trades,scope,
      amount_cents,cost_cents,pricing_version,membership,livemode,status,attempts,paid_at
    ) values($1,$2,$3,$4,$5,$6,3,$7::jsonb,'addition',2500,1000,'v1','standard',false,'paid',0,now())`,
    [quoteId, id(20), id(21), id(22), id(2), SHA, JSON.stringify(['Framing'])],
  );
}

async function reservePaid(db, quoteId = id(30)) {
  return (await db.query(
    'select reserve_project_reading_async($1,$2,$3,$4,$5,$6) as result',
    [quoteId, id(2), id(20), id(21), id(22), 'gemini-test'],
  )).rows[0].result;
}

const realResult = JSON.stringify({
  summary: { synthetic: false, sheet_count: 1 },
  findings: [{ page_number: 1, finding_type: 'measurement', label: 'Wall', quantity: 10, unit: 'LF', confidence: 0.9, geometry: {}, source_excerpt: '10 LF wall' }],
});

test('worker heartbeat is closed by default, service-role only, and becomes available when touched', async () => {
  const db = await boot();
  try {
    let available = await db.query('select ai_plan_worker_available() as value');
    assert.equal(available.rows[0].value, false);
    await db.query('select touch_ai_plan_worker($1)', ['worker-a']);
    available = await db.query('select ai_plan_worker_available() as value');
    assert.equal(available.rows[0].value, true);

    const functions = [
      'public.touch_ai_plan_worker(text)',
      'public.ai_plan_worker_available()',
      'public.reserve_project_reading_async(uuid,uuid,uuid,uuid,uuid,text)',
      'public.reserve_owner_free_reading_async(uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,integer)',
      'public.claim_ai_plan_reading(uuid,text)',
      'public.begin_ai_plan_provider_attempt(uuid,uuid)',
      'public.checkpoint_ai_plan_reading(uuid,uuid,jsonb)',
      'public.request_ai_plan_cancel(uuid,uuid,uuid)',
    ];
    for (const fn of functions) {
      for (const role of ['public', 'anon', 'authenticated']) {
        const privilege = await db.query('select has_function_privilege($1,$2,$3) as allowed', [role, fn, 'EXECUTE']);
        assert.equal(privilege.rows[0].allowed, false, `${role} must not execute ${fn}`);
      }
      const service = await db.query('select has_function_privilege($1,$2,$3) as allowed', ['service_role', fn, 'EXECUTE']);
      assert.equal(service.rows[0].allowed, true, `service_role must execute ${fn}`);
    }
  } finally { await db.close(); }
});

test('owner-free durable reservation is queued, idempotent, leased, and capped at one provider attempt', async () => {
  const db = await boot();
  try {
    const first = await reserveOwner(db);
    assert.equal(first.reused, false);
    assert.equal(first.job.status, 'queued');
    assert.equal(first.job.provider_attempts, 0);

    const duplicate = await reserveOwner(db);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.job.id, first.job.id);

    const claimed = (await db.query('select claim_ai_plan_reading($1,$2) as result', [first.job.id, 'worker-a'])).rows[0].result;
    assert.equal(claimed.skip, false);
    assert.equal(claimed.entitlement, 'owner_free');
    assert.equal(claimed.file_sha256, SHA);
    assert.deepEqual(claimed.requested_trades, ['Framing']);

    const attempt = await db.query('select begin_ai_plan_provider_attempt($1,$2) as value', [first.job.id, claimed.lease_id]);
    assert.equal(attempt.rows[0].value, true);
    await assert.rejects(
      () => db.query('select begin_ai_plan_provider_attempt($1,$2)', [first.job.id, claimed.lease_id]),
      /Free provider attempt limit reached/,
    );
  } finally { await db.close(); }
});

test('paid durable retry preserves checkpoint and does not charge a second provider attempt', async () => {
  const db = await boot();
  try {
    await insertPaidQuote(db);
    const reserved = await reservePaid(db);
    assert.equal(reserved.job.status, 'queued');
    assert.equal(reserved.quote.attempts, 0, 'enqueue reservation does not consume a provider attempt');

    const firstClaim = (await db.query('select claim_ai_plan_reading($1,$2) as result', [reserved.job.id, 'worker-a'])).rows[0].result;
    const attempt = await db.query('select begin_ai_plan_provider_attempt($1,$2) as value', [reserved.job.id, firstClaim.lease_id]);
    assert.equal(attempt.rows[0].value, true);
    await db.query('select checkpoint_ai_plan_reading($1,$2,$3::jsonb)', [reserved.job.id, firstClaim.lease_id, realResult]);
    await db.query('select release_ai_plan_reading_retry($1,$2,$3)', [reserved.job.id, firstClaim.lease_id, 'worker restarted after provider response']);

    const secondClaim = (await db.query('select claim_ai_plan_reading($1,$2) as result', [reserved.job.id, 'worker-b'])).rows[0].result;
    assert.deepEqual(secondClaim.checkpoint.provider_result.findings[0].label, 'Wall');
    const secondAttempt = await db.query('select begin_ai_plan_provider_attempt($1,$2) as value', [reserved.job.id, secondClaim.lease_id]);
    assert.equal(secondAttempt.rows[0].value, false, 'checkpoint prevents another provider call');

    const quote = await db.query('select attempts from project_reading_quotes where id=$1', [id(30)]);
    assert.equal(quote.rows[0].attempts, 1, 'provider authorization is consumed once');
  } finally { await db.close(); }
});

test('queue enqueue failure can release a paid reservation before provider work starts', async () => {
  const db = await boot();
  try {
    await insertPaidQuote(db, id(31));
    const reserved = await reservePaid(db, id(31));
    await db.query('select rollback_ai_plan_enqueue($1,$2)', [reserved.job.id, id(2)]);

    const jobs = await db.query('select count(*)::int as count from plan_reading_jobs where id=$1', [reserved.job.id]);
    assert.equal(jobs.rows[0].count, 0);
    const quote = await db.query('select status,job_id,attempts from project_reading_quotes where id=$1', [id(31)]);
    assert.equal(quote.rows[0].status, 'paid');
    assert.equal(quote.rows[0].job_id, null);
    assert.equal(quote.rows[0].attempts, 0);
  } finally { await db.close(); }
});

test('queued cancellation becomes terminal before a worker can claim the job', async () => {
  const db = await boot();
  try {
    const reserved = await reserveOwner(db, 'c'.repeat(64));
    const canceled = (await db.query('select request_ai_plan_cancel($1,$2,$3) as result', [reserved.job.id, id(1), id(10)])).rows[0].result;
    assert.equal(canceled.status, 'failed');
    assert.equal(canceled.processing_error, 'Canceled by user');

    const claim = (await db.query('select claim_ai_plan_reading($1,$2) as result', [reserved.job.id, 'worker-a'])).rows[0].result;
    assert.equal(claim.skip, true);
    assert.equal(claim.status, 'failed');
  } finally { await db.close(); }
});
