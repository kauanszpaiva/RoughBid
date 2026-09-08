import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('real SQL: platform admin uses paid reading path without payment while tenancy stays enforced', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create schema private;
      create table auth.users(id uuid primary key);
      create table public.profiles(id uuid primary key, is_platform_admin boolean not null default false);
      create table public.workspaces(id uuid primary key,ai_processing_consented_at timestamptz);
      create table public.workspace_members(workspace_id uuid,user_id uuid,role text);
      create table public.projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
      create table public.project_files(id uuid primary key,workspace_id uuid,project_id uuid,processing_status text);
      create function private.has_workspace_access(uuid) returns boolean language sql as 'select false';
      create function private.has_product_access() returns boolean language sql as 'select false';
      create function private.has_workspace_role(uuid,text[]) returns boolean language sql as 'select false';
      create function auth.uid() returns uuid language sql as 'select null::uuid';
    `);
    await db.exec(readFileSync(new URL('../migrations/0007_plan_ai_pipeline.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../migrations/0017_paid_project_readings.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../migrations/0026_platform_admin_complimentary_access.sql',import.meta.url),'utf8'));

    await db.exec(`
      insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}');
      insert into profiles values('${id(1)}',true),('${id(2)}',false),('${id(3)}',true);
      insert into workspaces values('${id(10)}',now()),('${id(20)}',now());
      insert into workspace_members values
        ('${id(10)}','${id(1)}','admin'),
        ('${id(10)}','${id(2)}','admin'),
        ('${id(10)}','${id(3)}','viewer');
      insert into projects values('${id(11)}','${id(10)}'),('${id(21)}','${id(20)}');
      insert into project_files values
        ('${id(12)}','${id(10)}','${id(11)}','ready'),
        ('${id(22)}','${id(20)}','${id(21)}','ready');
    `);

    const reserve = (user=id(1), workspace=id(10), project=id(11), file=id(12), fingerprint='b'.repeat(64)) =>
      db.query('select reserve_platform_admin_reading($1,$2,$3,$4,$5,$6,$7,$8,$9) as result', [
        user, workspace, project, file, 'gemini-test', 'a'.repeat(64), fingerprint, ['Framing'], 'Test scope',
      ]);

    await assert.rejects(reserve(id(2)), /administrator access required/i);
    await assert.rejects(reserve(id(3)), /workspace access denied/i);
    await assert.rejects(reserve(id(1),id(10),id(21),id(22)), /project not found|file unavailable/i);

    const first = (await reserve()).rows[0].result;
    assert.equal(first.reused, false);
    assert.equal(first.job.input_summary.entitlement, 'platform_admin_complimentary');
    assert.equal(first.job.input_summary.billed, false);
    assert.equal((await db.query('select count(*)::int as n from project_reading_quotes')).rows[0].n, 0);

    const reused = (await reserve()).rows[0].result;
    assert.equal(reused.reused, true);
    assert.equal(reused.job.id, first.job.id);

    const finish = (summary, findings, error=null) => db.query(
      'select finish_platform_admin_reading($1,$2,$3,$4,$5) as result',
      [first.job.id,id(1),JSON.stringify(summary),JSON.stringify(findings),error],
    );
    await assert.rejects(finish({synthetic:true},[{}]), /Real findings required/);
    const findings = [{page_number:1,finding_type:'labor',label:'Crew',quantity:4,unit:'HR',confidence:0.9,geometry:{},source_excerpt:'4 HR'}];
    const completed = (await finish({sheet_count:1},findings)).rows[0].result;
    assert.equal(completed.plan_reading_findings.length, 1);
    assert.equal(completed.plan_reading_findings[0].finding_type, 'labor');
    assert.equal((await db.query('select count(*)::int as n from project_reading_quotes')).rows[0].n, 0);

    await db.exec('set role authenticated');
    await assert.rejects(reserve(), /permission denied/i);
    await assert.rejects(finish({},[]), /permission denied/i);
    await db.exec('reset role');
  } finally {
    await db.close();
  }
});
