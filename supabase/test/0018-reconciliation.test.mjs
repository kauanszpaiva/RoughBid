import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const recovery = name => readFileSync(new URL(`../recovery/${name}`, import.meta.url), 'utf8');
const repair = sql('0018_reconcile_paid_reading_schema.sql');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const functionSql = (source, name) => {
  const start = source.indexOf(`create or replace function ${name}(`);
  assert.notEqual(start, -1, `Missing source function ${name}`);
  const end = source.indexOf('$$;', start);
  assert.notEqual(end, -1, `Missing function terminator for ${name}`);
  return source.slice(start, end + 3);
};

// Infrastructure fixtures replace GoTrue/JWT and unrelated foundation columns only.
// Workspace access/role helper bodies and migrations 0007, 0017 and 0018 run as
// repository SQL. Access checks are never mocked as constant true/false.
async function fixture(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant usage on schema private to authenticated;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key);
    create table public.workspace_members(workspace_id uuid, user_id uuid, role text);
    create table public.projects(id uuid primary key, workspace_id uuid, unique(id, workspace_id));
    create table public.project_files(id uuid primary key, workspace_id uuid, project_id uuid, processing_status text);
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  await db.exec(functionSql(sql('0001_foundation.sql'), 'public.has_workspace_access'));
  await db.exec(`alter function public.has_workspace_access(uuid) set schema private;
    revoke all on function private.has_workspace_access(uuid) from public, anon;
    grant execute on function private.has_workspace_access(uuid) to authenticated;`);
  await db.exec(functionSql(sql('0004_auth_rbac_access_grants.sql'), 'private.has_workspace_role'));
  await db.exec(`revoke all on function private.has_workspace_role(uuid,text[]) from public, anon;
    grant execute on function private.has_workspace_role(uuid,text[]) to authenticated;`);
  // 0017 replaces this exact helper; create it before 0007 resolves its policy.
  await db.exec(functionSql(sql('0017_paid_project_readings.sql'), 'private.has_product_access'));
  await db.exec(`revoke all on function private.has_product_access() from public, anon;
    grant execute on function private.has_product_access() to authenticated;`);
  await db.exec(sql('0007_plan_ai_pipeline.sql'));
  await db.exec(sql('0017_paid_project_readings.sql'));
  await db.exec(`
    insert into auth.users values ('${id(1)}'),('${id(2)}'),('${id(3)}'),('${id(4)}');
    insert into workspaces values ('${id(10)}'),('${id(20)}');
    insert into workspace_members values
      ('${id(10)}','${id(1)}','admin'), ('${id(10)}','${id(2)}','estimator'),
      ('${id(10)}','${id(3)}','viewer'), ('${id(20)}','${id(4)}','admin');
    insert into projects values ('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
    insert into project_files values
      ('${id(12)}','${id(10)}','${id(11)}','ready'), ('${id(22)}','${id(20)}','${id(21)}','ready');
    insert into project_reading_quotes(id,workspace_id,project_id,file_id,user_id,file_sha256,
      page_count,trades,scope,amount_cents,cost_cents,pricing_version,membership,livemode)
      values('${id(13)}','${id(10)}','${id(11)}','${id(12)}','${id(1)}','${'a'.repeat(64)}',
        1,'["Framing"]','',2000,1000,'isolated-test','standard',false);
    insert into plan_reading_jobs(id,workspace_id,project_id,file_id,requested_by,model,output_summary)
      values('${id(30)}','${id(10)}','${id(11)}','${id(12)}','${id(1)}','historical-test','{"synthetic":true}'),
        ('${id(40)}','${id(20)}','${id(21)}','${id(22)}','${id(4)}','historical-test','{}');
    insert into plan_reading_findings(id,job_id,workspace_id,project_id,file_id,finding_type,label,confidence)
      values('${id(31)}','${id(30)}','${id(10)}','${id(11)}','${id(12)}','material','Historical fixture',0.9),
        ('${id(41)}','${id(40)}','${id(20)}','${id(21)}','${id(22)}','material','Other tenant fixture',0.9);
  `);
}

async function actor(db, role, user, fn) {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? '']);
  await db.exec(`set role ${role}`);
  try { return await fn(); }
  finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

async function dataSnapshot(db, excludeConsent = false) {
  const result = {};
  for (const table of ['workspaces', 'workspace_members', 'projects', 'project_files',
    'project_reading_quotes', 'project_payment_events', 'plan_reading_jobs', 'plan_reading_findings']) {
    // Exclude the newly added consent column when comparing pre/post repair data.
    const row = excludeConsent ? "to_jsonb(t) - 'ai_processing_consented_at'" : 'to_jsonb(t)';
    result[table] = (await db.query(`select ${row} as data
      from public.${table} t order by (${row})::text`)).rows;
  }
  return result;
}

async function schemaSnapshot(db) {
  return {
    columns: (await db.query(`select attname, format_type(atttypid,atttypmod) as type
      from pg_attribute where attrelid='public.workspaces'::regclass and attnum>0 and not attisdropped
      order by attname`)).rows,
    constraint: (await db.query(`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid='public.plan_reading_findings'::regclass
      and conname='plan_reading_findings_finding_type_check'`)).rows,
    rpc: (await db.query(`select pg_get_functiondef(oid) as definition, proacl::text as acl from pg_proc
      where oid in ('public.set_plan_reading_finding_status(uuid,text)'::regprocedure,
        'public.finish_project_reading(uuid,uuid,jsonb,jsonb,text)'::regprocedure) order by proname`)).rows,
  };
}

test('0018 isolated PostgreSQL reconciliation, authorization and recovery gate', async t => {
  const db = new PGlite();
  let realFinding;
  const reserve = (workspace = id(10), user = id(1), project = id(11), file = id(12)) =>
    db.query('select public.reserve_project_reading($1,$2,$3,$4,$5,$6) as result',
      [id(13), user, workspace, project, file, 'gemini-isolated-test']);
  const review = (finding, status) => db.query(
    'select * from public.set_plan_reading_finding_status($1,$2)', [finding, status]);
  const pay = () => db.query('select public.confirm_project_reading_payment($1,$2,$3,$4,$5,$6,$7)',
    ['evt_isolated_0018', id(13), 'cs_test_0018', 'pi_test_0018', 2000, 'usd', false]);
  try {
    await fixture(db);

    await t.test('reproduces missing consent, rejected labor and stale review semantics', async () => {
      await assert.rejects(actor(db, 'service_role', null, reserve), /ai_processing_consented_at.*does not exist/);
      await assert.rejects(db.query(`update plan_reading_findings set finding_type='labor' where id=$1`, [id(31)]),
        /plan_reading_findings_finding_type_check/);
      await assert.rejects(actor(db, 'authenticated', id(1), () => review(id(31), 'accepted')), /Simulated findings/);
      // Reproduce an environment with the older 0015 RPC after 0017 was deployed.
      await db.exec(functionSql(sql('0015_plan_reading_review_and_ai_consent.sql'), 'public.set_plan_reading_finding_status'));
      assert.equal((await actor(db, 'authenticated', id(1), () => review(id(31), 'accepted'))).rows[0].status, 'accepted');
      await db.query("update plan_reading_findings set status='needs_review' where id=$1", [id(31)]);
    });

    await t.test('transaction rollback restores schema, grants, RPC and existing data', async () => {
      const beforeSchema = await schemaSnapshot(db);
      const beforeData = await dataSnapshot(db);
      await db.exec('begin');
      await db.exec(repair);
      await db.query("update plan_reading_findings set finding_type='labor' where id=$1", [id(31)]);
      await assert.rejects(db.query("update plan_reading_findings set finding_type='invalid' where id=$1", [id(31)]),
        /plan_reading_findings_finding_type_check/);
      await assert.rejects(db.query('select 1'), /current transaction is aborted/);
      await db.exec('rollback');
      assert.deepEqual(await schemaSnapshot(db), beforeSchema);
      assert.deepEqual(await dataSnapshot(db), beforeData);
    });

    await t.test('repair applies twice with identical schema and preserves fixture data', async () => {
      const before = await dataSnapshot(db, true);
      await db.exec(repair);
      const firstSchema = await schemaSnapshot(db);
      await db.exec(repair);
      assert.deepEqual(await schemaSnapshot(db), firstSchema);
      assert.deepEqual(await dataSnapshot(db, true), before);
      assert.deepEqual((await db.query('select ai_processing_consented_at from workspaces')).rows,
        [{ ai_processing_consented_at: null }, { ai_processing_consented_at: null }]);
    });

    await t.test('consent OFF blocks even paid; ON unpaid blocks; ON paid reserves and labor persists', async () => {
      await assert.rejects(actor(db, 'service_role', null, reserve), /AI processing consent required/);
      await db.query('update workspaces set ai_processing_consented_at=now() where id=$1', [id(10)]);
      await assert.rejects(actor(db, 'service_role', null, reserve), /Paid quote required/);
      await actor(db, 'service_role', null, pay);
      await db.query('update workspaces set ai_processing_consented_at=null where id=$1', [id(10)]);
      await assert.rejects(actor(db, 'service_role', null, reserve), /AI processing consent required/);
      assert.equal((await db.query('select attempts from project_reading_quotes')).rows[0].attempts, 0);
      await db.query('update workspaces set ai_processing_consented_at=now() where id=$1', [id(10)]);
      const result = (await actor(db, 'service_role', null, reserve)).rows[0].result;
      assert.equal(result.quote.attempts, 1);
      assert.equal(result.job.status, 'processing');
      const labor = [{
          page_number: 1, finding_type: 'labor', label: 'Framing labor', quantity: 4,
          unit: 'HR', confidence: 0.9, geometry: {}, source_excerpt: '4 labor hours on page 1',
        }];
      const finish = (summary, findings = JSON.stringify(labor)) => db.query(
        'select public.finish_project_reading($1,$2,$3,$4,$5) as result',
        [id(13), result.job.id, JSON.stringify(summary), findings, null]);
      const beforeInvalidResult = await dataSnapshot(db);
      for (const invalid of [null, 'null', '{}', '[]', '"invalid"']) {
        await assert.rejects(actor(db, 'service_role', null, () => finish({ synthetic: false }, invalid)), /Real findings required/);
        assert.deepEqual(await dataSnapshot(db), beforeInvalidResult, 'Invalid results must not complete or write findings');
      }
      await assert.rejects(actor(db, 'service_role', null, () => finish({ synthetic: true })), /Real findings required/);
      const completed = (await actor(db, 'service_role', null, () => finish({ synthetic: false }))).rows[0].result;
      realFinding = completed.plan_reading_findings[0].id;
      assert.equal(completed.status, 'needs_review');
      const persisted = (await db.query('select finding_type, quantity, unit, status from plan_reading_findings where id=$1', [realFinding])).rows[0];
      assert.deepEqual(persisted, { finding_type: 'labor', quantity: '4.0000', unit: 'HR', status: 'needs_review' });
    });

    await t.test('only tenant admin/estimator can review; synthetic output cannot become accepted', async () => {
      const before = (await db.query('select * from plan_reading_findings where id=$1', [realFinding])).rows[0];
      await assert.rejects(actor(db, 'authenticated', id(3), () => review(realFinding, 'accepted')), /Insufficient workspace role/);
      await assert.rejects(actor(db, 'authenticated', id(4), () => review(realFinding, 'accepted')), /Insufficient workspace role/);
      await assert.rejects(actor(db, 'authenticated', null, () => review(realFinding, 'accepted')), /Insufficient workspace role/);
      await assert.rejects(actor(db, 'anon', null, () => review(realFinding, 'accepted')), /permission denied/);
      await assert.rejects(actor(db, 'authenticated', id(1), () => review(realFinding, 'ready')), /new_status must/);
      assert.equal((await actor(db, 'authenticated', id(1), () => review(realFinding, 'accepted'))).rows[0].status, 'accepted');
      assert.equal((await actor(db, 'authenticated', id(2), () => review(realFinding, 'rejected'))).rows[0].status, 'rejected');
      const after = (await db.query('select * from plan_reading_findings where id=$1', [realFinding])).rows[0];
      assert.deepEqual({ ...after, status: before.status }, before, 'Review may only mutate status');
      for (const user of [id(1), id(2)]) {
        await assert.rejects(actor(db, 'authenticated', user, () => review(id(31), 'accepted')), /Simulated findings/);
      }
      // Authorization precedes the synthetic-data check: the other tenant cannot probe job metadata.
      await assert.rejects(actor(db, 'authenticated', id(4), () => review(id(31), 'accepted')), /Insufficient workspace role/);
      assert.equal((await db.query('select status from plan_reading_findings where id=$1', [id(31)])).rows[0].status, 'needs_review');
    });

    await t.test('RLS and SECURITY DEFINER grants prevent direct mutation and cross-tenant access', async () => {
      const rls = (await db.query(`select relname, relrowsecurity from pg_class
        where oid in ('plan_reading_jobs'::regclass,'plan_reading_findings'::regclass,
          'project_reading_quotes'::regclass,'project_payment_events'::regclass)`)).rows;
      assert.equal(rls.length, 4);
      assert.ok(rls.every(row => row.relrowsecurity));
      const functionMetadata = (await db.query(`select proname, prosecdef, proconfig from pg_proc
        where oid in ('set_plan_reading_finding_status(uuid,text)'::regprocedure,
          'reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
          'finish_project_reading(uuid,uuid,jsonb,jsonb,text)'::regprocedure)`)).rows;
      assert.equal(functionMetadata.length, 3);
      assert.ok(functionMetadata.every(row => row.prosecdef && row.proconfig.includes('search_path=public, pg_temp')));
      const serverFunctions = ['confirm_project_reading_payment(text,uuid,text,text,integer,text,boolean)',
        'reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)', 'finish_project_reading(uuid,uuid,jsonb,jsonb,text)',
        'revoke_project_reading_payment(text,uuid,text,boolean)', 'create_project_reading_quote(jsonb)'];
      for (const signature of serverFunctions) {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          const permission = (await db.query("select has_function_privilege($1,$2,'execute') as allowed", [role, `public.${signature}`])).rows[0];
          assert.equal(permission.allowed, role === 'service_role', `${role}: ${signature}`);
        }
      }
      for (const user of [id(1), id(2), id(3)]) {
        const visible = (await actor(db, 'authenticated', user,
          () => db.query('select distinct workspace_id from plan_reading_findings'))).rows;
        assert.deepEqual(visible, [{ workspace_id: id(10) }]);
        await assert.rejects(actor(db, 'authenticated', user,
          () => db.query("update plan_reading_findings set status='accepted' where id=$1", [realFinding])), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, reserve), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, pay), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, () => db.query('select * from project_reading_quotes')), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, () => db.query("update project_reading_quotes set status='paid'")), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, () => db.query("update plan_reading_jobs set status='ready'")), /permission denied/);
        await assert.rejects(actor(db, 'authenticated', user, () => db.query('insert into plan_reading_findings default values')), /permission denied/);
      }
      const otherTenant = (await actor(db, 'authenticated', id(4),
        () => db.query('select distinct workspace_id from plan_reading_jobs'))).rows;
      assert.deepEqual(otherTenant, [{ workspace_id: id(20) }]);
      await assert.rejects(actor(db, 'service_role', null, () => reserve(id(10), id(4))), /Workspace access denied/);
      await assert.rejects(actor(db, 'service_role', null, () => reserve(id(10), id(3))), /Workspace access denied/);
      await assert.rejects(actor(db, 'service_role', null, () => reserve(id(20), id(4), id(21), id(22))), /AI processing consent required/);
      await db.query('update workspaces set ai_processing_consented_at=now() where id=$1', [id(20)]);
      await assert.rejects(actor(db, 'service_role', null, () => reserve(id(20), id(4), id(21), id(22))), /Paid quote required/);
      await assert.rejects(actor(db, 'anon', null, reserve), /permission denied/);
      assert.deepEqual((await actor(db, 'anon', null, () => db.query('select * from plan_reading_findings'))).rows, []);
      // A caller-controlled search_path/temp relation cannot redirect the qualified RPC.
      await actor(db, 'authenticated', id(3), async () => {
        await db.exec(`create temporary table plan_reading_findings(id uuid, workspace_id uuid, status text);
          set search_path=pg_temp,public;`);
        try { await assert.rejects(review(realFinding, 'accepted'), /Insufficient workspace role/); }
        finally { await db.exec('reset search_path; drop table pg_temp.plan_reading_findings'); }
      });
    });

    await t.test('post-commit pause and controlled resume preserve all data and safety checks', async () => {
      const before = await dataSnapshot(db);
      await db.exec(recovery('0018_pause_ai_and_review.sql'));
      await assert.rejects(actor(db, 'service_role', null, reserve), /permission denied/);
      await assert.rejects(actor(db, 'authenticated', id(1), () => review(realFinding, 'accepted')), /permission denied/);
      assert.deepEqual(await dataSnapshot(db), before);
      await db.exec(recovery('0018_resume_ai_and_review.sql'));
      const resumed = (await actor(db, 'service_role', null, reserve)).rows[0].result;
      assert.equal(resumed.reused, true);
      assert.equal(resumed.quote.attempts, 1);
      assert.deepEqual(await dataSnapshot(db), before);
      await assert.rejects(actor(db, 'authenticated', id(3), () => review(realFinding, 'accepted')), /Insufficient workspace role/);
      await assert.rejects(actor(db, 'authenticated', id(1), () => review(id(31), 'accepted')), /Simulated findings/);
      await assert.rejects(actor(db, 'authenticated', id(1), reserve), /permission denied/);
      await assert.rejects(actor(db, 'anon', null, () => review(realFinding, 'accepted')), /permission denied/);
    });

    await t.test('recovery also closes pilot reservation paths after 0019 without enabling the pilot', async () => {
      await db.exec(sql('0019_pilot_activation_controls.sql'));
      const before = await dataSnapshot(db);
      const configBefore = (await db.query('select * from private.plan_reading_pilot_config')).rows;
      assert.equal(configBefore[0].enabled, false);
      await assert.rejects(actor(db, 'service_role', null, reserve), /pilot is disabled/);
      const signatures = ['public.reserve_project_reading(uuid,uuid,uuid,uuid,uuid,text)'];
      const optional = 'public.reserve_pilot_project_reading(uuid,uuid,uuid,uuid,uuid,text)';
      if ((await db.query('select to_regprocedure($1) as signature', [optional])).rows[0].signature) {
        signatures.push(optional);
      }
      await db.exec(recovery('0018_pause_ai_and_review.sql'));
      for (const signature of signatures) {
        assert.equal((await db.query("select has_function_privilege('service_role',$1,'execute') as allowed", [signature])).rows[0].allowed, false);
      }
      await assert.rejects(actor(db, 'service_role', null, reserve), /permission denied/);
      await db.exec(recovery('0018_resume_ai_and_review.sql'));
      await assert.rejects(actor(db, 'service_role', null, reserve), /pilot is disabled/);
      assert.deepEqual((await db.query('select * from private.plan_reading_pilot_config')).rows, configBefore);
      assert.deepEqual(await dataSnapshot(db), before);
    });
  } finally { await db.close(); }
});
