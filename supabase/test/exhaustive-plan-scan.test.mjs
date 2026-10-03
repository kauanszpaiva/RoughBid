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
    create table public.profiles(id uuid primary key, is_platform_admin boolean not null default false);
    create table public.workspaces(id uuid primary key, created_by uuid not null, ai_processing_consented_at timestamptz);
    create table public.workspace_members(workspace_id uuid not null,user_id uuid not null,role text not null,primary key(workspace_id,user_id));
    create table public.projects(id uuid primary key,workspace_id uuid not null);
    create table public.project_files(
      id uuid primary key,workspace_id uuid not null,project_id uuid not null,
      storage_path text not null,original_name text not null,processing_status text not null
    );
    create table public.plan_reading_jobs(
      id uuid primary key default gen_random_uuid(), workspace_id uuid not null, project_id uuid not null,
      file_id uuid not null, requested_by uuid not null, status text not null default 'queued',
      mode text not null default 'quick', model text not null, input_summary jsonb not null default '{}'::jsonb,
      output_summary jsonb not null default '{}'::jsonb, processing_error text, started_at timestamptz,
      completed_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table public.project_reading_quotes(
      id uuid primary key,workspace_id uuid not null,project_id uuid not null,file_id uuid not null,user_id uuid not null,
      file_sha256 text not null,page_count integer not null,trades jsonb not null,scope text not null,
      amount_cents integer not null,cost_cents integer not null,currency text not null default 'usd',
      pricing_version text not null,membership text not null,livemode boolean not null,status text not null,
      attempts integer not null default 0,job_id uuid,paid_at timestamptz
    );
    create table public.plan_reading_findings(
      id uuid primary key default gen_random_uuid(), job_id uuid not null,workspace_id uuid not null,
      project_id uuid not null,file_id uuid not null,page_number integer,finding_type text not null,
      label text not null,value_text text,quantity numeric,unit text,confidence numeric not null,
      geometry jsonb not null default '{}'::jsonb,source_excerpt text not null
    );
    create table private.free_owner_workspaces(workspace_id uuid primary key);

    insert into auth.users values('${id(1)}');
    insert into profiles values('${id(1)}',true);
    insert into workspaces values('${id(10)}','${id(1)}',now());
    insert into workspace_members values('${id(10)}','${id(1)}','admin');
    insert into projects values('${id(11)}','${id(10)}');
    insert into project_files values(
      '${id(12)}','${id(10)}','${id(11)}','${id(10)}/${id(11)}/${id(12)}/source.pdf','set.pdf','ready'
    );
  `);
  await db.exec(readFileSync(new URL('../migrations/0023_durable_ai_plan_jobs.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/0024_durable_ai_worker_capabilities.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../migrations/20260925200000_exhaustive_plan_scan.sql', import.meta.url), 'utf8'));
  return db;
}

test('platform admin exhaustive job is queued, leased, and persists more than the legacy 200 findings', async () => {
  const db = await boot();
  try {
    const reservation = (await db.query(
      `select reserve_platform_admin_reading_async(
        $1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10
      ) as result`,
      [id(1),id(10),id(11),id(12),'gpt-5.4',SHA,FP,['Framing'],'entire set',1],
    )).rows[0].result;
    assert.equal(reservation.reused,false);
    assert.equal(reservation.job.status,'queued');
    assert.equal(reservation.job.mode,'detailed');
    assert.equal(reservation.job.input_summary.entitlement,'platform_admin_complimentary');
    assert.equal(reservation.job.input_summary.scan_strategy,'whole-set-plus-overlapping-regions-v1');

    const claimed=(await db.query('select claim_ai_plan_reading($1,$2) as result',[reservation.job.id,'worker-paid'])).rows[0].result;
    assert.equal(claimed.entitlement,'platform_admin_complimentary');
    assert.equal(claimed.mode,'detailed');
    assert.equal(claimed.page_count,1);

    const started=await db.query('select begin_ai_plan_provider_attempt($1,$2) as value',[reservation.job.id,claimed.lease_id]);
    assert.equal(started.rows[0].value,true);

    const findings=Array.from({length:201},(_,index)=>({
      page_number:1,finding_type:index%2?'symbol':'room',label:`finding-${index+1}`,
      value_text:null,quantity:null,unit:null,confidence:0.8,geometry:{bbox:[0.1,0.1,0.01,0.01]},
      source_excerpt:`visible evidence ${index+1}`,
    }));
    const providerResult={summary:{synthetic:false,sheet_count:1,human_review_required:true},findings};
    const checkpoint=await db.query('select checkpoint_ai_plan_reading($1,$2,$3::jsonb) as value',
      [reservation.job.id,claimed.lease_id,JSON.stringify(providerResult)]);
    assert.equal(checkpoint.rows[0].value,true,'checkpoint accepts exhaustive evidence above 200 findings');

    const finished=(await db.query(
      'select finish_platform_admin_reading($1,$2,$3::jsonb,$4::jsonb,$5) as result',
      [reservation.job.id,id(1),JSON.stringify(providerResult.summary),JSON.stringify(findings),null],
    )).rows[0].result;
    assert.equal(finished.status,'needs_review');
    assert.equal(finished.plan_reading_findings.length,201);

    const count=await db.query('select count(*)::int as count from plan_reading_findings where job_id=$1',[reservation.job.id]);
    assert.equal(count.rows[0].count,201);
  } finally {
    await db.close();
  }
});

test('exhaustive admin functions remain service-role only', async () => {
  const db=await boot();
  try {
    const signatures=[
      'public.reserve_platform_admin_reading_async(uuid,uuid,uuid,uuid,text,text,text,text[],text,integer)',
      'public.claim_ai_plan_reading(uuid,text)',
      'public.begin_ai_plan_provider_attempt(uuid,uuid)',
      'public.checkpoint_ai_plan_reading(uuid,uuid,jsonb)',
      'public.finish_platform_admin_reading(uuid,uuid,jsonb,jsonb,text)',
    ];
    for(const fn of signatures){
      for(const role of ['public','anon','authenticated']){
        const privilege=await db.query('select has_function_privilege($1,$2,$3) as allowed',[role,fn,'EXECUTE']);
        assert.equal(privilege.rows[0].allowed,false,`${role} must not execute ${fn}`);
      }
      const service=await db.query('select has_function_privilege($1,$2,$3) as allowed',['service_role',fn,'EXECUTE']);
      assert.equal(service.rows[0].allowed,true,`service_role must execute ${fn}`);
    }
  } finally {
    await db.close();
  }
});
