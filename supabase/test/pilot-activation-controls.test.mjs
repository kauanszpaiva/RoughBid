import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const model = 'pilot-model-pinned-for-test';
const sql = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const pilotSql = sql('0019_pilot_activation_controls.sql');

async function fixture({ pilot = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key, ai_processing_consented_at timestamptz);
    create table public.workspace_members(workspace_id uuid, user_id uuid, role text);
    create table public.projects(id uuid primary key, workspace_id uuid, unique(id,workspace_id));
    create table public.project_files(id uuid primary key, workspace_id uuid, project_id uuid, processing_status text);
    create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function private.has_workspace_role(w uuid, roles text[]) returns boolean
      language sql security definer set search_path=pg_catalog as
      $$ select exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid() and role=any(roles)) $$;
    create function private.has_workspace_access(w uuid) returns boolean
      language sql security definer set search_path=pg_catalog as
      $$ select exists(select 1 from public.workspace_members where workspace_id=w and user_id=auth.uid()) $$;
    create function private.has_product_access() returns boolean language sql as $$ select auth.uid() is not null $$;
    grant usage on schema public, auth, private to anon, authenticated, service_role;
  `);
  await db.exec(sql('0007_plan_ai_pipeline.sql'));
  await db.exec(sql('0017_paid_project_readings.sql'));
  await db.exec(sql('0018_reconcile_paid_reading_schema.sql'));
  if (pilot) await db.exec(pilotSql);
  await db.exec(`
    insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}'),('${id(4)}');
    insert into workspaces values('${id(10)}',now()),('${id(20)}',now());
    insert into workspace_members values
      ('${id(10)}','${id(1)}','admin'),('${id(10)}','${id(2)}','estimator'),
      ('${id(10)}','${id(3)}','viewer'),('${id(20)}','${id(4)}','admin');
    insert into projects values('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
    insert into project_files values('${id(12)}','${id(10)}','${id(11)}','ready'),('${id(22)}','${id(20)}','${id(21)}','ready');
    insert into project_reading_quotes(id,workspace_id,project_id,file_id,user_id,file_sha256,page_count,
      trades,scope,amount_cents,cost_cents,pricing_version,membership,livemode)
    values('${id(13)}','${id(10)}','${id(11)}','${id(12)}','${id(1)}','${'a'.repeat(64)}',1,
      '["Framing"]','',2000,1000,'test','standard',false),
      ('${id(23)}','${id(20)}','${id(21)}','${id(22)}','${id(4)}','${'b'.repeat(64)}',1,
      '["Framing"]','',2000,1000,'test','standard',false);
  `);
  const value = async (query, args = []) => (await db.query(query, args)).rows[0]?.value;
  const activate = async (budget = 0.02) => {
    await db.query(`update private.plan_reading_pilot_config set enabled=true,model=$1,budget_usd=$2,
      input_usd_per_million=2,output_usd_per_million=6,max_input_tokens=1000,max_output_tokens=1000 where id=1`, [model, budget]);
    await db.exec(`insert into private.plan_reading_pilot_workspaces(workspace_id,enabled)
      values('${id(10)}',true),('${id(20)}',true) on conflict(workspace_id) do update set enabled=true`);
  };
  const pay = async (quote = 13) => value('select public.confirm_project_reading_payment($1,$2,$3,$4,2000,$5,false) as value',
    [`evt_${quote}`, id(quote), `cs_${quote}`, `pi_${quote}`, 'usd']);
  const reserve = async ({ quote = 13, user = 1, workspace = 10, project = 11, file = 12, requestedModel = model } = {}) =>
    value('select public.reserve_project_reading($1,$2,$3,$4,$5,$6) as value',
      [id(quote), id(user), id(workspace), id(project), id(file), requestedModel]);
  const settle = async (reservation, outcome, usage = null) => value('select public.record_plan_reading_usage($1,$2,$3,$4) as value',
    [reservation.job.id, reservation.pilot.attempt, usage == null ? null : JSON.stringify(usage), outcome]);
  const fail = async reservation => value('select public.finish_project_reading($1,$2,$3,$4,$5) as value',
    [reservation.quote.id, reservation.job.id, '{}', '[]', 'isolated test failure']);
  const counts = async () => (await db.query(`select (select count(*)::int from plan_reading_jobs) jobs,
    (select count(*)::int from private.plan_reading_pilot_usage) holds,
    (select coalesce(sum(attempts),0)::int from project_reading_quotes) attempts`)).rows[0];
  return { db, value, activate, pay, reserve, settle, fail, counts };
}

test('pilot installs closed, has no allowlist/model defaults and only service RPC access', async () => {
  const f = await fixture();
  try {
    const c = (await f.db.query('select * from private.plan_reading_pilot_config')).rows[0];
    assert.equal(c.enabled, false); assert.equal(c.model, null); assert.equal(c.stripe_livemode, false);
    assert.equal((await f.db.query('select * from private.plan_reading_pilot_workspaces')).rows.length, 0);
    await assert.rejects(f.value('select public.assert_plan_reading_activation($1,$2) as value', [id(10), model]), /disabled/);
    await assert.rejects(f.db.exec('update private.plan_reading_pilot_config set enabled=true'), /check constraint/);
    const functions = [
      'public.assert_plan_reading_activation(uuid,text)',
      'public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)',
      'public.record_plan_reading_usage(uuid,integer,jsonb,text)',
    ];
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of functions) assert.equal(await f.value('select has_function_privilege($1,$2,$3) as value', [role, fn, 'EXECUTE']), role === 'service_role');
      assert.equal(await f.value('select has_function_privilege($1,$2,$3) as value',
        [role, 'private.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)', 'EXECUTE']), false);
      for (const table of ['plan_reading_pilot_config', 'plan_reading_pilot_workspaces', 'plan_reading_pilot_usage']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          assert.equal(await f.value('select has_table_privilege($1,$2,$3) as value', [role, `private.${table}`, privilege]), false);
        }
      }
    }
    assert.equal(await f.value(`select bool_and(relrowsecurity) as value from pg_class where oid in
      ('private.plan_reading_pilot_config'::regclass,'private.plan_reading_pilot_workspaces'::regclass,'private.plan_reading_pilot_usage'::regclass)`), true);
    for (const fn of functions) {
      const metadata = (await f.db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [fn])).rows[0];
      assert.equal(metadata.prosecdef, true); assert.deepEqual(metadata.proconfig, ['search_path=pg_catalog']);
    }
    await f.db.exec('set role authenticated');
    await assert.rejects(f.reserve(), /permission denied/);
    await f.db.exec('reset role');
    await f.db.exec('set role service_role');
    await assert.rejects(f.db.query('select private.reserve_project_reading($1,$2,$3,$4,$5,$6)', [id(13),id(1),id(10),id(11),id(12),model]), /permission denied/);
    await f.db.exec('reset role');
  } finally { await f.db.close(); }
});

test('pilot validates model, allowlist, token/rate bounds and TEST-only mode', async () => {
  const f = await fixture();
  try {
    await f.activate();
    const config = await f.value('select public.assert_plan_reading_activation($1,$2) as value', [id(10), model]);
    assert.equal(config.reserved_usd_per_attempt, 0.008);
    assert.equal(config.exposure_usd, 0);
    await assert.rejects(f.value('select public.assert_plan_reading_activation($1,$2) as value', [id(10), 'other-model']), /configuration or model/);
    await f.db.exec(`update private.plan_reading_pilot_workspaces set enabled=false where workspace_id='${id(10)}'`);
    await assert.rejects(f.reserve(), /not enabled/);
    for (const update of ['stripe_livemode=true', 'max_output_tokens=8001', 'max_input_tokens=0', 'input_usd_per_million=0', "budget_usd='NaN'", "output_usd_per_million='Infinity'"]) {
      await assert.rejects(f.db.exec(`update private.plan_reading_pilot_config set ${update}`), /check constraint/);
    }
    assert.deepEqual(await f.counts(), { jobs: 0, holds: 0, attempts: 0 });
  } finally { await f.db.close(); }
});

test('unpaid, consent OFF, wrong tenant, viewer and live payment never reserve budget', async () => {
  const f = await fixture();
  try {
    await f.activate();
    await assert.rejects(f.reserve(), /Paid quote required/);
    await f.pay();
    await f.db.exec(`update workspaces set ai_processing_consented_at=null where id='${id(10)}'`);
    await assert.rejects(f.reserve(), /consent required/);
    await f.db.exec(`update workspaces set ai_processing_consented_at=now() where id='${id(10)}'`);
    await assert.rejects(f.reserve({ user: 4 }), /access denied/);
    await assert.rejects(f.reserve({ user: 3 }), /access denied/);
    await assert.rejects(f.reserve({ project: 21, file: 22 }), /Paid quote required/);
    await f.db.exec(`update project_reading_quotes set livemode=true where id='${id(13)}'`);
    await assert.rejects(f.reserve(), /TEST payments only/);
    assert.deepEqual(await f.counts(), { jobs: 0, holds: 0, attempts: 0 });
  } finally { await f.db.close(); }
});

test('one global lifetime budget bounds competing workspaces and rolls back rejected attempts', async () => {
  const f = await fixture();
  try {
    await f.activate(0.008); await f.pay(); await f.pay(23);
    const results = await Promise.allSettled([f.reserve(), f.reserve({ quote: 23, user: 4, workspace: 20, project: 21, file: 22 })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.match(results.find(r => r.status === 'rejected').reason.message, /lifetime budget exhausted/);
    assert.deepEqual(await f.counts(), { jobs: 1, holds: 1, attempts: 1 });
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0.008);
    assert.match(pilotSql, /where id = 1 for update/);
  } finally { await f.db.close(); }
});

test('no-provider settlement releases only its hold, is idempotent and permits bounded retry', async () => {
  const f = await fixture();
  try {
    await f.activate(0.008); await f.pay();
    const first = await f.reserve({ user: 2 });
    assert.equal(first.pilot.attempt, 1); assert.equal(first.pilot.reserved_usd, 0.008);
    assert.equal(first.pilot.max_output_tokens, 1000);
    const released = await f.settle(first, 'no_provider');
    assert.equal(released.state, 'released');
    assert.deepEqual(await f.settle(first, 'no_provider'), released);
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0);
    await f.fail(first);
    const retry = await f.reserve();
    assert.equal(retry.job.id, first.job.id); assert.equal(retry.pilot.attempt, 2);
    await f.settle(retry, 'no_provider'); await f.fail(retry);
    await assert.rejects(f.reserve(), /Attempt limit reached/);
  } finally { await f.db.close(); }
});

test('measured usage uses pinned rates, settles exactly once and complete reuse adds no hold', async () => {
  const f = await fixture();
  try {
    await f.activate(); await f.pay();
    const reserved = await f.reserve();
    await f.db.exec('update private.plan_reading_pilot_config set input_usd_per_million=4,output_usd_per_million=8');
    const usage = { input_tokens: 1000, output_tokens: 500, model, model_version: 'observed-test-version' };
    const measured = await f.settle(reserved, 'measured', usage);
    assert.equal(measured.state, 'measured'); assert.equal(measured.measured_usd, 0.005);
    assert.deepEqual(await f.settle(reserved, 'measured', usage), measured);
    await assert.rejects(f.settle(reserved, 'measured', { ...usage, output_tokens: 600 }), /already settled/);
    const finding = { page_number: 1, finding_type: 'labor', label: 'Documented labor', quantity: 2, unit: 'HR', confidence: 0.9, geometry: {}, source_excerpt: '2 HR labor' };
    const job = await f.value('select public.finish_project_reading($1,$2,$3,$4,null) as value',
      [reserved.quote.id, reserved.job.id, '{"sheet_count":1}', JSON.stringify([finding])]);
    assert.equal(job.status, 'needs_review'); assert.equal(job.plan_reading_findings[0].finding_type, 'labor');
    const reused = await f.reserve();
    assert.equal(reused.reused, true);
    assert.deepEqual(await f.counts(), { jobs: 1, holds: 1, attempts: 1 });
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0.005);
  } finally { await f.db.close(); }
});

test('pending or unknown usage blocks retries; unknown retains the full reservation', async () => {
  const f = await fixture();
  try {
    await f.activate(); await f.pay();
    const reserved = await f.reserve();
    await f.fail(reserved);
    await assert.rejects(f.reserve(), /pending or unknown/);
    const unknown = await f.settle(reserved, 'unknown');
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.measured_usd, null);
    assert.deepEqual(await f.settle(reserved, 'unknown'), unknown);
    await assert.rejects(f.reserve(), /operator reconciliation/);
    await assert.rejects(f.settle(reserved, 'no_provider'), /already settled/);
    await assert.rejects(f.settle(reserved, 'measured', { input_tokens: 10, output_tokens: 0, model, model_version: 'unreported' }), /already settled/);
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0.008);
    assert.deepEqual(await f.counts(), { jobs: 1, holds: 1, attempts: 1 });
  } finally { await f.db.close(); }
});

test('usage rejects malformed evidence, accepts zero output and never undercounts an overrun', async () => {
  const f = await fixture();
  try {
    await f.activate(); await f.pay(); await f.pay(23);
    const reserved = await f.reserve();
    const usage = { input_tokens: 1000, output_tokens: 0, model, model_version: 'unreported' };
    for (const invalid of [null, {}, { ...usage, input_tokens: '1000' }, { ...usage, input_tokens: 0 },
      { ...usage, input_tokens: 1.2 }, { ...usage, output_tokens: -1 }, { ...usage, model: 'unapproved' }, { ...usage, model_version: '' }]) {
      await assert.rejects(f.settle(reserved, 'measured', invalid), /required|integer/);
    }
    assert.equal((await f.settle(reserved, 'measured', usage)).measured_usd, 0.002);
    const other = await f.reserve({ quote: 23, user: 4, workspace: 20, project: 21, file: 22 });
    const overrun = await f.settle(other, 'measured', { ...usage, input_tokens: 10000, output_tokens: 10000 });
    assert.equal(overrun.measured_usd, 0.08);
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0.082);
    assert.equal(await f.value('select enabled as value from private.plan_reading_pilot_config'), false);
    await assert.rejects(f.reserve(), /disabled/);
  } finally { await f.db.close(); }
});

test('pilot migration rerun preserves configured state and spend; transaction rollback restores original RPC', async () => {
  const f = await fixture({ pilot: false });
  try {
    await f.db.exec('begin'); await f.db.exec(pilotSql); await f.db.exec('rollback');
    assert.equal(await f.value("select to_regclass('private.plan_reading_pilot_config') as value"), null);
    assert.equal(await f.value("select to_regprocedure('private.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)') as value"), null);
    assert.ok(await f.value("select to_regprocedure('public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)') as value"));
    await f.db.exec(pilotSql); await f.activate(); await f.pay();
    await f.reserve();
    await f.db.exec(pilotSql);
    assert.equal(await f.value('select enabled as value from private.plan_reading_pilot_config'), true);
    assert.equal(Number(await f.value('select private.plan_reading_pilot_exposure() as value')), 0.008);
    assert.deepEqual(await f.counts(), { jobs: 1, holds: 1, attempts: 1 });
    await assert.rejects(f.reserve(), /pending or unknown/);
  } finally { await f.db.close(); }
});
