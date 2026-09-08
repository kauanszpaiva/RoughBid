import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const FP_A = 'c'.repeat(64);
const FP_B = 'd'.repeat(64);

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema private;
    create table auth.users(id uuid primary key);
    create table public.workspaces(id uuid primary key, ai_processing_consented_at timestamptz, created_by uuid);
    create table public.workspace_members(workspace_id uuid, user_id uuid, role text);
    create table public.projects(id uuid primary key, workspace_id uuid, unique(id,workspace_id));
    create table public.project_files(id uuid primary key, workspace_id uuid, project_id uuid, processing_status text);
    create function private.has_workspace_access(uuid) returns boolean language sql as 'select false';
    create function private.has_product_access() returns boolean language sql as 'select false';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql as 'select false';
    create function auth.uid() returns uuid language sql as 'select null::uuid';
  `);
  await db.exec(readFileSync(new URL('../migrations/0007_plan_ai_pipeline.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/0020_owner_free_reading.sql', import.meta.url), 'utf8'));
  // owner = user 1 (created_by), member 3 is an admin but NOT the creator.
  await db.exec(`
    insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}');
    insert into workspaces values('${id(10)}',now(),'${id(1)}'),('${id(20)}',now(),'${id(2)}');
    insert into workspace_members values('${id(10)}','${id(1)}','admin'),('${id(10)}','${id(3)}','admin'),('${id(20)}','${id(2)}','admin');
    insert into projects values('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
    insert into project_files values('${id(12)}','${id(10)}','${id(11)}','ready'),('${id(22)}','${id(20)}','${id(21)}','ready');
    insert into private.free_owner_workspaces(workspace_id) values('${id(10)}');
  `);
  return db;
}

const reserve = (db, o = {}) => db.query(
  'select reserve_owner_free_reading($1,$2,$3,$4,$5,$6,$7) as result',
  [o.user ?? id(1), o.ws ?? id(10), o.project ?? id(11), o.file ?? id(12),
   o.model ?? 'gemini-2.5-flash', o.sha ?? SHA_A, o.fp ?? FP_A],
);

test('real SQL: owner-free reservation enforces allowlist, ownership and request identity', async () => {
  const db = await boot();
  try {
    // Workspace not on the allowlist is refused even for its own creator.
    await assert.rejects(() => reserve(db, { user: id(2), ws: id(20), project: id(21), file: id(22) }),
      /not enabled for this workspace/);

    // Allowlisted workspace, but the caller is an admin who is NOT the creator.
    await assert.rejects(() => reserve(db, { user: id(3) }), /restricted to the workspace owner/);

    // Spoofing another tenant's user id against the owner workspace.
    await assert.rejects(() => reserve(db, { user: id(2) }), /restricted to the workspace owner/);

    // Cross-tenant file against the owner workspace.
    await assert.rejects(() => reserve(db, { file: id(22) }), /File unavailable/);

    // Malformed identity is rejected before anything else.
    await assert.rejects(() => reserve(db, { sha: 'nope' }), /Invalid plan reading request identity/);
    await assert.rejects(() => reserve(db, { fp: 'nope' }), /Invalid plan reading request identity/);

    const first = (await reserve(db)).rows[0].result;
    assert.equal(first.reused, false);
    assert.equal(first.job.status, 'processing');
    assert.equal(first.job.input_summary.billed, false);
    assert.equal(first.job.input_summary.entitlement, 'owner_free');

    // Identical request identity re-uses rather than spending quota again.
    const again = (await reserve(db)).rows[0].result;
    assert.equal(again.reused, true);
    assert.equal(again.job.id, first.job.id);

    // A different scope/model fingerprint is a DIFFERENT analysis, not a re-use.
    const otherScope = (await reserve(db, { fp: FP_B })).rows[0].result;
    assert.equal(otherScope.reused, false);
    assert.notEqual(otherScope.job.id, first.job.id);

    // A different file digest is likewise a new analysis.
    const otherFile = (await reserve(db, { sha: SHA_B })).rows[0].result;
    assert.equal(otherFile.reused, false);
    assert.notEqual(otherFile.job.id, first.job.id);
  } finally { await db.close(); }
});

test('real SQL: completion rejects NULL, non-array and empty findings', async () => {
  const db = await boot();
  try {
    const job = (await reserve(db)).rows[0].result.job;
    const finish = (findings, summary = '{"synthetic":false}') => db.query(
      'select finish_owner_free_reading($1,$2,$3::jsonb,$4::jsonb,$5) as result',
      [job.id, id(1), summary, findings, null],
    );

    // SQL NULL must not slip through three-valued logic on jsonb_typeof().
    await assert.rejects(() => finish(null), /Real findings required/);
    await assert.rejects(() => finish('null'), /Real findings required/);
    await assert.rejects(() => finish('{}'), /Real findings required/);
    await assert.rejects(() => finish('"text"'), /Real findings required/);
    await assert.rejects(() => finish('[]'), /Real findings required/);
    // A synthetic summary is refused even with real-looking findings.
    await assert.rejects(
      () => finish('[{"page_number":1,"finding_type":"measurement","label":"S"}]', '{"synthetic":true}'),
      /Real findings required/);

    // The job is still processing: no partial completion happened.
    const still = await db.query('select status from plan_reading_jobs where id=$1', [job.id]);
    assert.equal(still.rows[0].status, 'processing');

    // A real finding completes to needs_review with the finding persisted.
    // A real 'labor' finding must persist, not abort the whole reading. The
    // live CHECK omitted 'labor', so this would have rolled the insert back.
    const ok = (await finish('[{"page_number":1,"finding_type":"measurement","label":"Slab","quantity":10,"unit":"ft","confidence":0.8},'
      + '{"page_number":1,"finding_type":"labor","label":"Crew day","quantity":2,"unit":"day","confidence":0.6}]')).rows[0].result;
    assert.equal(ok.status, 'needs_review');
    const rows = await db.query('select count(*)::int as n from plan_reading_findings where job_id=$1', [job.id]);
    assert.equal(rows.rows[0].n, 2, 'labor findings are kept, never silently dropped');
  } finally { await db.close(); }
});

test('real SQL: completion refuses a job belonging to another caller or workspace', async () => {
  const db = await boot();
  try {
    const job = (await reserve(db)).rows[0].result.job;
    const real = '[{"page_number":1,"finding_type":"measurement","label":"Slab"}]';
    // Wrong caller.
    await assert.rejects(
      () => db.query('select finish_owner_free_reading($1,$2,$3::jsonb,$4::jsonb,$5)', [job.id, id(3), '{}', real, null]),
      /not authorized/);
    // Workspace removed from the allowlist mid-flight.
    await db.exec(`delete from private.free_owner_workspaces where workspace_id='${id(10)}'`);
    await assert.rejects(
      () => db.query('select finish_owner_free_reading($1,$2,$3::jsonb,$4::jsonb,$5)', [job.id, id(1), '{}', real, null]),
      /not authorized/);
  } finally { await db.close(); }
});

test('real SQL: daily cap counts failed attempts and rejects before any provider call', async () => {
  const db = await boot();
  try {
    await db.exec(`set roughbid.free_daily_cap = '2'`);
    const a = (await reserve(db, { fp: FP_A })).rows[0].result.job;
    const b = (await reserve(db, { fp: FP_B })).rows[0].result.job;

    // Fail BOTH attempts. A failed provider call already consumed free-tier
    // quota, so failures must still count against the cap.
    for (const job of [a, b]) {
      await db.query('select finish_owner_free_reading($1,$2,$3::jsonb,$4::jsonb,$5)',
        [job.id, id(1), '{}', '[]', 'provider error']);
    }
    const failed = await db.query(`select count(*)::int as n from plan_reading_jobs where status='failed'`);
    assert.equal(failed.rows[0].n, 2);

    // A third, distinct request is refused: retries cannot bypass the cap.
    await assert.rejects(() => reserve(db, { fp: 'e'.repeat(64) }), /daily reading limit reached/);
  } finally { await db.close(); }
});

test('real SQL: EXECUTE is not granted to PUBLIC, anon or authenticated', async () => {
  const db = await boot();
  try {
    const sigs = [
      'public.reserve_owner_free_reading(uuid,uuid,uuid,uuid,text,text,text)',
      'public.finish_owner_free_reading(uuid,uuid,jsonb,jsonb,text)',
    ];
    for (const sig of sigs) {
      for (const grantee of ['public', 'anon', 'authenticated']) {
        const r = await db.query('select has_function_privilege($1,$2,$3) as allowed', [grantee, sig, 'EXECUTE']);
        assert.equal(r.rows[0].allowed, false, `${grantee} must not execute ${sig}`);
      }
      const svc = await db.query('select has_function_privilege($1,$2,$3) as allowed', ['service_role', sig, 'EXECUTE']);
      assert.equal(svc.rows[0].allowed, true, `service_role must execute ${sig}`);
    }
    // The allowlist table itself is not readable by tenant roles.
    for (const grantee of ['anon', 'authenticated']) {
      const r = await db.query('select has_table_privilege($1,$2,$3) as allowed', [grantee, 'private.free_owner_workspaces', 'SELECT']);
      assert.equal(r.rows[0].allowed, false, `${grantee} must not read the allowlist`);
    }
  } finally { await db.close(); }
});

/*
 * Concurrency limitation, stated rather than claimed as tested.
 *
 * PGlite is a single in-process PostgreSQL instance without a second client
 * connection, so this harness CANNOT execute two overlapping transactions and
 * therefore cannot empirically prove the cap and re-use are race free. What the
 * tests above prove is the sequential semantics; the concurrency argument rests
 * on the lock, not on a test:
 *
 *   reserve_owner_free_reading() begins with
 *     perform 1 from public.workspaces where id = p_workspace_id for update;
 *
 * That takes a row-level exclusive lock on the workspace before the re-use
 * SELECT, the cap COUNT and the INSERT. A concurrent caller for the same
 * workspace blocks on that lock until the first transaction commits, so it
 * observes the first caller's inserted job in both the re-use lookup and the
 * COUNT. Two callers therefore cannot both pass the cap, and a double click
 * cannot create two jobs. This is the same serialization the paid
 * reserve_project_reading() relies on. Verifying it empirically needs a real
 * multi-connection PostgreSQL (e.g. two clients against a local server), which
 * is out of scope for this harness.
 */
