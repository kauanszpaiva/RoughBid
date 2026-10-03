import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const user='00000000-0000-4000-8000-000000000001', workspace='10000000-0000-4000-8000-000000000001';
const project='20000000-0000-4000-8000-000000000001', file='30000000-0000-4000-8000-000000000001';
const version='takeoff-v2.2-durable';
const sheet={physicalPageNumber:1,pageSha256:'b'.repeat(64),widthPoints:612,heightPoints:792,rotationDegrees:0,contentKind:'vector',textQuality:'good'};
const manifest={fileSha256:'a'.repeat(64),physicalPageCount:1,sheets:[sheet]};
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');

async function database() {
  const db=new PGlite();
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema private;
    create table auth.users(id uuid primary key);
    create table profiles(id uuid primary key,is_platform_admin boolean);
    create table workspaces(id uuid primary key,ai_processing_consented_at timestamptz);
    create table workspace_members(workspace_id uuid,user_id uuid,role text);
    create table projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
    create table project_files(id uuid primary key,workspace_id uuid,project_id uuid,storage_path text,processing_status text,page_count integer,unique(id,workspace_id,project_id));
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';
    create function private.has_product_access() returns boolean language sql stable as 'select true';
    create table plan_reading_jobs(id uuid primary key,workspace_id uuid,project_id uuid,requested_by uuid);
    create table api_usage_events(id uuid primary key,workspace_id uuid,project_id uuid,user_id uuid,provider text,model text,operation text);
    create table provider_spend_policy(singleton boolean primary key,enabled boolean,rolling_window interval,spend_cap_usd numeric,call_reservation_usd numeric);
    insert into provider_spend_policy values(true,true,interval '24 hours',25,2.5);
    create table provider_spend_reservations(event_id uuid primary key references api_usage_events(id),job_id uuid not null references plan_reading_jobs(id),workspace_id uuid references workspaces(id),user_id uuid,provider text,model text,status text default 'reserved',reserved_usd numeric,estimated_cost_usd numeric,telemetry_known boolean default false,created_at timestamptz default now());
    insert into auth.users values('${user}');insert into profiles values('${user}',true);
    insert into workspaces values('${workspace}',now());insert into workspace_members values('${workspace}','${user}','estimator');
    insert into projects values('${project}','${workspace}');
    insert into project_files values('${file}','${workspace}','${project}','${workspace}/${project}/${file}/source.pdf','ready',1);
  `);
  await db.exec(migration('20260910225937_takeoff_v2_foundation.sql'));
  await db.exec(migration('20261002120000_full_takeoff_v2_durable.sql'));
  await db.query('select touch_full_takeoff_v2_worker($1,$2)',['worker',version]);
  return db;
}
async function reserve(db, input=manifest) {
  return (await db.query('select reserve_full_takeoff_v2($1,$2,$3,$4,$5,$6) as result',[user,workspace,project,file,JSON.stringify(input),version])).rows[0].result;
}
async function claim(db,id,worker='worker') { return (await db.query('select claim_full_takeoff_v2($1,$2,$3) as result',[id,worker,version])).rows[0].result; }
async function begin(db,id,lease,pass='classification',key='c'.repeat(64)) {
  return (await db.query('select begin_full_takeoff_v2_pass($1,$2,1,$3,1,$4) as result',[id,lease,pass,key])).rows[0].result;
}
async function checkpoint(db,id,lease,pass='classification',key='c'.repeat(64),status='succeeded') {
  return db.query('select checkpoint_full_takeoff_v2_pass($1,$2,1,$3,1,$4,$5,null)',[id,lease,pass,key,JSON.stringify({status,checkpoint:{source:'mock'}})]);
}

test('migration executes, service-only RPCs and V2 spend FK retain tenant constraints',async()=>{
  const db=await database();try {
    const functions=(await db.query("select proname,has_function_privilege('authenticated',oid,'EXECUTE') as browser,has_function_privilege('service_role',oid,'EXECUTE') as service from pg_proc where proname like '%full_takeoff_v2%' or proname='reserve_provider_spend'")).rows;
    assert.ok(functions.length>=11);assert.ok(functions.every(f=>!f.browser&&f.service));
    const live=(await db.query('select full_takeoff_v2_worker_available($1) as live',[version])).rows[0].live;assert.equal(live,true);
    const first=await reserve(db),second=await reserve(db);assert.equal(first.run.id,second.run.id);assert.equal(second.reused,true);
    assert.equal((await db.query('select count(*)::int as count from plan_sheets')).rows[0].count,1);
    await assert.rejects(reserve(db,{...manifest,physicalPageCount:null}),/Invalid Full Takeoff pages/);
    await db.exec('update profiles set is_platform_admin=false');await assert.rejects(reserve(db),/Platform administrator/);
  } finally {await db.close();}
});

test('expired worker restarts only completed checkpoints, uncertain provider passes stay blocked',async()=>{
  const db=await database();try {
    const {run}=await reserve(db),first=await claim(db,run.id);
    assert.equal(await begin(db,run.id,first.lease_id),'run');await checkpoint(db,run.id,first.lease_id);
    await db.query("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second' where id=$1",[run.id]);
    const resumed=await claim(db,run.id,'worker-2');assert.notEqual(resumed.lease_id,first.lease_id);
    assert.equal(await begin(db,run.id,resumed.lease_id),'already_succeeded');
    assert.equal(await begin(db,run.id,resumed.lease_id,'legends_schedules','d'.repeat(64)),'run');
    await db.query("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second' where id=$1",[run.id]);
    const blocked=await claim(db,run.id,'worker-3');assert.equal(blocked.skip,true);assert.equal(blocked.reconciliation_required,true);
    await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,user,workspace]),/reconciliation/);
    await assert.rejects(checkpoint(db,run.id,first.lease_id),/lease invalid/);
  }finally{await db.close();}
});

test('cancel fences checkpoints/spend and restart preserves safe completed evidence',async()=>{
  const db=await database();try {
    const {run}=await reserve(db),active=await claim(db,run.id);
    await begin(db,run.id,active.lease_id);await checkpoint(db,run.id,active.lease_id);
    await db.query('select cancel_full_takeoff_v2($1,$2,$3)',[run.id,user,workspace]);
    const heartbeat=(await db.query('select heartbeat_full_takeoff_v2($1,$2,$3) as active',[run.id,active.lease_id,'worker'])).rows[0].active;assert.equal(heartbeat,false);
    await assert.rejects(begin(db,run.id,active.lease_id,'geometry','e'.repeat(64)),/lease invalid/);
    const event='40000000-0000-4000-8000-000000000003';
    await db.query("insert into api_usage_events values($1,$2,$3,$4,'claude','configured-model',$5)",[event,workspace,project,user,`rb1:${run.id}:generate:pending`]);
    await assert.rejects(db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,workspace,user,'claude','configured-model']),/job is not authorized/);
    await db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,user,workspace]);
    const resumed=await claim(db,run.id);assert.equal(await begin(db,run.id,resumed.lease_id),'already_succeeded');
    assert.equal((await db.query('select count(*)::int as count from takeoff_passes')).rows[0].count,1);
  }finally{await db.close();}
});

test('revoked consent stops an active worker before the next pass reservation',async()=>{
  const db=await database();try {
    const {run}=await reserve(db),active=await claim(db,run.id);
    await db.exec('update workspaces set ai_processing_consented_at=null');
    const beat=(await db.query('select heartbeat_full_takeoff_v2($1,$2,$3) as active',[run.id,active.lease_id,'worker'])).rows[0].active;
    assert.equal(beat,false);
    const event='40000000-0000-4000-8000-000000000004';
    await db.query("insert into api_usage_events values($1,$2,$3,$4,'gemini','configured-model',$5)",[event,workspace,project,user,`rb1:${run.id}:generate:pending`]);
    await assert.rejects(db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,workspace,user,'gemini','configured-model']),/Full Takeoff access denied/);
  }finally{await db.close();}
});

test('Full provider spend reserves every call separately, cap/identity reject before dispatch',async()=>{
  const db=await database();try {
    const {run}=await reserve(db);await claim(db,run.id);
    const event='40000000-0000-4000-8000-000000000001';
    await db.query("insert into api_usage_events values($1,$2,$3,$4,'openai','configured-model',$5)",[event,workspace,project,user,`rb1:${run.id}:generate:pending`]);
    const reserveSpend=()=>db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6) as result',[event,run.id,workspace,user,'openai','configured-model']);
    const result=(await reserveSpend()).rows[0].result;assert.equal(result.job_id,null);assert.equal(result.takeoff_run_id,run.id);assert.equal(Number(result.reserved_usd),2.5);
    await reserveSpend();assert.equal((await db.query('select count(*)::int as count from provider_spend_reservations')).rows[0].count,1);
    await assert.rejects(db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,workspace,user,'claude','configured-model']),/identity mismatch/);
    const event2='40000000-0000-4000-8000-000000000002';
    await db.query("insert into api_usage_events values($1,$2,$3,$4,'openai','configured-model',$5)",[event2,workspace,project,user,`rb1:${run.id}:generate:pending`]);
    await db.exec('update provider_spend_policy set spend_cap_usd=2.5');
    await assert.rejects(db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event2,run.id,workspace,user,'openai','configured-model']),/spend limit/);
    await db.exec("update provider_spend_policy set spend_cap_usd=25;update api_usage_events set project_id='20000000-0000-4000-8000-000000000002' where id='40000000-0000-4000-8000-000000000002'");
    await assert.rejects(db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event2,run.id,workspace,user,'openai','configured-model']),/event is not authorized/);
  }finally{await db.close();}
});

test('completion derives coverage from checkpoints and always requires review/price evidence',async()=>{
  const db=await database();try {
    const {run}=await reserve(db),active=await claim(db,run.id);
    const passes=['classification','legends_schedules','geometry','discipline','reconciliation','conflict_detection','completeness','arithmetic_qa','pricing_assemblies','risk_review'];
    for(const [i,pass]of passes.entries()){const key=i.toString(16).repeat(64);await begin(db,run.id,active.lease_id,pass,key);await checkpoint(db,run.id,active.lease_id,pass,key);}
    const result=(await db.query('select finish_full_takeoff_v2($1,$2,$3) as result',[run.id,active.lease_id,JSON.stringify({failed:0})])).rows[0].result;
    assert.equal(result.status,'needs_review');assert.equal(result.humanReviewRequired,true);
    const saved=(await db.query('select output_summary from takeoff_runs where id=$1',[run.id])).rows[0].output_summary;
    assert.equal(saved.takeoff_v2.budgetStatus,'awaiting_measurement_and_price_evidence');
    assert.equal((await claim(db,run.id)).skip,true);
  }finally{await db.close();}
});
