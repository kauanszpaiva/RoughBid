import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ids={user:'00000000-0000-4000-8000-000000000001',workspace:'10000000-0000-4000-8000-000000000001',
  project:'20000000-0000-4000-8000-000000000001',file:'30000000-0000-4000-8000-000000000001'};
const version='takeoff-v2.2-durable';
const manifest={fileSha256:'a'.repeat(64),physicalPageCount:1,sheets:[{physicalPageNumber:1,pageSha256:'b'.repeat(64),widthPoints:200,heightPoints:100,rotationDegrees:0,contentKind:'vector',textQuality:'good'}]};
const contract={version:'paid-full-v1',manifest,policyId:'c'.repeat(64),maximumCalls:16,regionGrid:2,stages:['classification'],
  executionPolicy:'one-durable-run-budget-wait-no-uncertain-replay',providers:[{provider:'gemini',models:['gemini-3.8-flash'],approvedUsd:40,maximumCalls:16}],
  pricing:{version:'offline-test',currency:'usd',costCents:1664,amountCents:3328,membership:'standard',marginBps:5000,paymentFixedCents:0,paymentFeeBps:0,providerCostUpperBoundUsd:16.64,operatingReserveUsd:40,expiresAt:'2099-01-01T00:00:00Z'}};
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
async function fixture(){
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;
    create table auth.users(id uuid primary key);create table profiles(id uuid primary key,is_platform_admin boolean);
    create table workspaces(id uuid primary key,ai_processing_consented_at timestamptz);create table workspace_members(workspace_id uuid,user_id uuid,role text);
    create table projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));
    create table project_files(id uuid primary key,workspace_id uuid,project_id uuid,storage_path text,processing_status text,page_count integer,unique(id,workspace_id,project_id));
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';
    create function private.has_product_access() returns boolean language sql stable as 'select true';
    create table plan_reading_jobs(id uuid primary key,workspace_id uuid,project_id uuid,file_id uuid,requested_by uuid,status text,processing_error text,completed_at timestamptz,started_at timestamptz,created_at timestamptz default now(),mode text,model text,input_summary jsonb);
    create table plan_reading_findings(id uuid,job_id uuid,workspace_id uuid,status text);
    create table api_usage_events(id uuid primary key,workspace_id uuid,project_id uuid,user_id uuid,provider text,model text,operation text);
    create table provider_spend_policy(singleton boolean primary key,enabled boolean,rolling_window interval,spend_cap_usd numeric,call_reservation_usd numeric);
    insert into provider_spend_policy values(true,true,interval '24 hours',100,2.5);
    create table provider_spend_reservations(event_id uuid primary key references api_usage_events(id),job_id uuid not null references plan_reading_jobs(id),workspace_id uuid references workspaces(id),user_id uuid,provider text,model text,status text default 'reserved',reserved_usd numeric,estimated_cost_usd numeric,telemetry_known boolean default false,created_at timestamptz default now());
    create table geometry_provider_spend_reservations(id uuid default gen_random_uuid(),reserved_usd numeric,created_at timestamptz default now());
    insert into auth.users values('${ids.user}');insert into profiles values('${ids.user}',false);insert into workspaces values('${ids.workspace}',now());
    insert into workspace_members values('${ids.workspace}','${ids.user}','estimator');insert into projects values('${ids.project}','${ids.workspace}');
    insert into project_files values('${ids.file}','${ids.workspace}','${ids.project}','${ids.workspace}/${ids.project}/${ids.file}/source.pdf','ready',1);`);
  for(const file of ['0017_paid_project_readings.sql','0023_durable_ai_plan_jobs.sql','20260910225937_takeoff_v2_foundation.sql','20261002120000_full_takeoff_v2_durable.sql',
    '20261002140000_takeoff_measurement_review.sql','20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql','20261003010000_paid_full_takeoff.sql','20261003020000_full_takeoff_budget_wait.sql']) await db.exec(migration(file));
  await db.query('select touch_full_takeoff_v2_worker($1,$2)',['offline-worker',version]);
  return db;
}
async function quote(db,hash='d'.repeat(64),fullContract=contract){
  const input={workspace_id:ids.workspace,project_id:ids.project,file_id:ids.file,user_id:ids.user,file_sha256:manifest.fileSha256,page_count:1,trades:['Framing'],scope:'',
    amount_cents:3328,cost_cents:1664,pricing_version:'offline-test',membership:'standard',livemode:true,mode:'full_v2',full_contract:fullContract,full_contract_hash:hash};
  return(await db.query('select create_paid_full_quote($1) as q',[JSON.stringify(input)])).rows[0].q;
}
async function accept(db,q){return db.query('select accept_paid_full_quote($1,$2,$3,$4,$5)',[q.id,ids.user,ids.workspace,ids.project,q.full_contract_hash]);}
async function pay(db,q,event=`evt_${q.id}`){return(await db.query('select confirm_project_reading_payment($1,$2,$3,$4,$5,$6,true) as result',[event,q.id,`cs_${q.id}`,`pi_${q.id}`,3328,'usd'])).rows[0].result;}
async function reserve(db,q){return(await db.query('select reserve_paid_full_takeoff_v2($1,$2,$3,$4,$5,$6,$7) as r',[q.id,ids.user,ids.workspace,ids.project,ids.file,q.full_contract_hash,version])).rows[0].r;}
async function claim(db,run){return(await db.query('select claim_full_takeoff_v2($1,$2,$3) as c',[run.id,'offline-worker',version])).rows[0].c;}
async function configure(db,q,run,lease){return db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',[run.id,lease,'gemini',['gemini-3.8-flash'],40,16,`paid-full-v1:${q.id}:1`]);}
async function spend(db,run,event){
  await db.query('insert into api_usage_events values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'gemini','gemini-3.8-flash',`rb1:${run.id}:generate:pending`]);
  return db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,ids.workspace,ids.user,'gemini','gemini-3.8-flash']);
}

async function paidRun(db,hash='d'.repeat(64)){
  const q=await quote(db,hash);await accept(db,q);await pay(db,q);const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
  return {q,run,lease:c.lease_id};
}
async function denied(db,run,event='50000000-0000-4000-8000-000000000001'){
  await db.query('insert into api_usage_events values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'gemini','gemini-3.8-flash',`rb1:${run.id}:generate:blocked_spend_limit`]);return event;
}
const wait=(db,r,event,pass='classification',key='f'.repeat(64))=>db.query('select wait_full_takeoff_budget($1,$2,$3,1,$4,$5) w',[r.run.id,r.lease,event,pass,key]);

test('multiwindow admits complete obligations above25, preserves total budgets and applies shared cap to admitted calls',async()=>{
 const db=await fixture();try{
  await db.exec('update provider_spend_policy set spend_cap_usd=25');
  const a=await paidRun(db),b=await paidRun(db,'e'.repeat(64));
  assert.equal(Number((await db.query('select sum(reserved_usd) n from paid_full_payment_holds')).rows[0].n),80);
  assert.equal((await db.query('select paid_full_capacity_ready(40,2.5,null) ready')).rows[0].ready,true);
  for(let i=1;i<=10;i++)await spend(db,a.run,`40000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
  await assert.rejects(spend(db,b.run,'40000000-0000-4000-8000-000000000020'),/Company AI spend limit reached/);
  await assert.rejects(db.query('insert into geometry_provider_spend_reservations(reserved_usd) values(2.5)'),/Company AI spend limit reached/);
  assert.equal(Number((await db.query('select sum(reserved_usd) n from provider_spend_reservations')).rows[0].n),25);
  assert.equal(Number((await db.query('select approved_usd from full_takeoff_provider_budgets where takeoff_run_id=$1',[a.run.id])).rows[0].approved_usd),40);
 }finally{await db.close();}
});

test('company refusal waits without a processing claim, survives restart and expires only scheduling usage, not unknown reservations',async()=>{
 const db=await fixture();try{
  await db.exec('update provider_spend_policy set spend_cap_usd=25');const r=await paidRun(db);
  await db.query('insert into geometry_provider_spend_reservations(reserved_usd) values(25)');
  const event=await denied(db,r.run);const w=(await wait(db,r,event)).rows[0].w;
  assert.equal(w.status,'waiting_budget');assert.ok(Date.parse(w.not_before)>Date.now()+23*3600000);
  assert.equal((await db.query('select count(*)::int n from takeoff_passes')).rows[0].n,0);
  assert.equal((await claim(db,r.run)).skip,true);
  await assert.rejects(db.query('select finish_full_takeoff_v2($1,$2,$3)',[r.run.id,r.lease,'{}']),/lease invalid/);
  assert.equal((await db.query('select * from due_full_takeoff_budget_runs($1)',[version])).rows.length,0);
  await db.exec("update geometry_provider_spend_reservations set created_at=now()-interval '25 hours';update takeoff_runs set not_before=now()-interval '1 second'");
  assert.equal((await db.query('select * from due_full_takeoff_budget_runs($1)',[version])).rows[0].run_id,r.run.id);
  const resumed=await claim(db,r.run);assert.notEqual(resumed.lease_id,r.lease);assert.equal(resumed.skip,false);
  await spend(db,r.run,'40000000-0000-4000-8000-000000000001');
  assert.equal((await db.query('select count(*)::int n from geometry_provider_spend_reservations')).rows[0].n,1);
  assert.equal((await db.query('select status from project_reading_quotes where id=$1',[r.q.id])).rows[0].status,'processing');
 }finally{await db.close();}
});

test('regional wait preserves completed child, resumes aggregate, and funded claim is required before a new dispatch',async()=>{
 const db=await fixture();try{
  const r=await paidRun(db);const event='40000000-0000-4000-8000-000000000001',key='f'.repeat(64),regionKey='a'.repeat(64);
  await assert.rejects(db.query("select begin_funded_full_takeoff_v2_pass($1,$2,1,'discipline',1,$3,$4)",[r.run.id,r.lease,key,event]),/no funded reservation/);
  await spend(db,r.run,event);
  await db.query("select begin_funded_full_takeoff_v2_pass($1,$2,1,'discipline',1,$3,$4)",[r.run.id,r.lease,key,event]);
  const args=[r.run.id,r.lease,1,manifest.sheets[0].pageSha256,'discipline','r1c1g2',JSON.stringify({columns:2,rows:2,column:1,row:1,x:0,y:0,width:100,height:50}),regionKey];
  await db.query('select begin_funded_full_takeoff_region($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...args,event]);
  const result={status:'succeeded',checkpoint:{physical_page_number:1,pass_type:'discipline',source_coverage:{region_key:'r1c1g2'},evidence:'saved'}};
  await db.query('select save_full_takeoff_region($1,$2,$3,$4,$5,$6,$7,$8,$9)',[...args,JSON.stringify(result)]);
  await db.query('update api_usage_events set operation=$1 where id=$2',[`rb1:${r.run.id}:generate:unknown`,event]);
  const noSend=await denied(db,r.run);await wait(db,r,noSend,'discipline',key);
  assert.equal((await db.query('select status from takeoff_passes')).rows[0].status,'queued');
  await db.exec("update takeoff_runs set not_before=now()-interval '1 second'");const c=await claim(db,r.run);
  const prior=(await db.query('select inspect_full_takeoff_region($1,$2,$3,$4,$5,$6,$7,$8) p',[r.run.id,c.lease_id,...args.slice(2)])).rows[0].p;
  assert.deepEqual(prior,{disposition:'saved',result});
  assert.equal((await db.query("select inspect_full_takeoff_v2_pass($1,$2,1,'discipline',1,$3) p",[r.run.id,c.lease_id,key])).rows[0].p,'run');
  const next='40000000-0000-4000-8000-000000000002';await spend(db,r.run,next);
  await db.query("select begin_funded_full_takeoff_v2_pass($1,$2,1,'discipline',1,$3,$4)",[r.run.id,c.lease_id,key,next]);
  assert.equal((await db.query('select count(*)::int n from takeoff_region_checkpoints')).rows[0].n,1);
 }finally{await db.close();}
});

test('uncertain funded send cannot become waiting or be restarted even after the rolling window',async()=>{
 const db=await fixture();try{
  const r=await paidRun(db);await spend(db,r.run,'40000000-0000-4000-8000-000000000001');
  const event=await denied(db,r.run);await assert.rejects(wait(db,r,event),/Uncertain provider dispatch/);
  await db.exec("update provider_spend_reservations set created_at=now()-interval '25 hours';update takeoff_runs set worker_lease_expires_at=now()-interval '1 second'");
  assert.equal((await claim(db,r.run)).reconciliation_required,true);
  await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[r.run.id,ids.user,ids.workspace]),/reconciliation/);
  assert.equal(Number((await db.query('select reserved_usd from provider_spend_reservations')).rows[0].reserved_usd),2.5);
 }finally{await db.close();}
});

test('due waiter owns one admission turn across workers and revocation prevents resumption',async()=>{
 const db=await fixture();try{
  const a=await paidRun(db),b=await paidRun(db,'e'.repeat(64));await wait(db,a,await denied(db,a.run));
  await db.query("update takeoff_runs set not_before=now()-interval '1 second' where id=$1",[a.run.id]);
  await assert.rejects(spend(db,b.run,'40000000-0000-4000-8000-000000000001'),/waiting reading has the next turn/);
  const ca=await claim(db,a.run);await assert.rejects(claim(db,a.run),/already leased/);
  await spend(db,a.run,'40000000-0000-4000-8000-000000000002');
  assert.equal((await db.query('select budget_wait_started_at from takeoff_runs where id=$1',[a.run.id])).rows[0].budget_wait_started_at,null);
  await db.query('update api_usage_events set operation=$1 where id=$2',[`rb1:${a.run.id}:generate:unknown`,'40000000-0000-4000-8000-000000000002']);
  await wait(db,{...a,lease:ca.lease_id},await denied(db,a.run,'50000000-0000-4000-8000-000000000002'));
  await db.query('select revoke_project_reading_payment($1,$2,$3,true)',['evt_revoke',a.q.id,`pi_${a.q.id}`]);
  await db.query('select * from due_full_takeoff_budget_runs($1)',[version]);
  assert.equal((await db.query('select status from takeoff_runs where id=$1',[a.run.id])).rows[0].status,'failed');
  assert.equal((await db.query('select status from project_reading_quotes where id=$1',[a.q.id])).rows[0].status,'revoked');
 }finally{await db.close();}
});

test('paid completion cannot label unvisited contracted regions complete and diagnostics reject arbitrary text',async()=>{
 const db=await fixture();try{
  const r=await paidRun(db);
  for(const pass of ['classification','legends_schedules','geometry','discipline','reconciliation','conflict_detection','completeness','arithmetic_qa','pricing_assemblies','risk_review']){
    const key=Buffer.from(pass).toString('hex').padEnd(64,'0');
    await db.query('select begin_full_takeoff_v2_pass($1,$2,1,$3,1,$4)',[r.run.id,r.lease,pass,key]);
    await db.query('select checkpoint_full_takeoff_v2_pass($1,$2,1,$3,1,$4,$5,null)',[r.run.id,r.lease,pass,key,JSON.stringify({status:'succeeded',checkpoint:{}})]);
  }
  const result=(await db.query('select finish_full_takeoff_v2($1,$2,$3) r',[r.run.id,r.lease,'{}'])).rows[0].r;
  assert.equal(result.status,'failed');assert.equal(result.releaseStatus,'blocked');
  assert.equal((await db.query('select error_code from takeoff_runs where id=$1',[r.run.id])).rows[0].error_code,'reading_incomplete');
  assert.equal((await db.query('select released_at from paid_full_payment_holds where quote_id=$1',[r.q.id])).rows[0].released_at,null);
  await assert.rejects(db.query('select fail_full_takeoff_boundary($1,$2,$3)',[r.run.id,r.lease,'raw private provider detail']),/Unsupported reading diagnostic/);
  assert.equal((await db.query("select has_function_privilege('authenticated','wait_full_takeoff_budget(uuid,uuid,uuid,integer,text,text)','EXECUTE') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});

test('checkout price validity includes an initial occupied window and never changes company policy',async()=>{
 const db=await fixture();try{
  await db.exec('update provider_spend_policy set spend_cap_usd=25');
  const expiring={...contract,pricing:{...contract.pricing,expiresAt:new Date(Date.now()+36*3600000).toISOString()}};
  const q=await quote(db,'d'.repeat(64),expiring);await db.query('insert into geometry_provider_spend_reservations(reserved_usd) values(25)');
  assert.equal(Number((await db.query('select paid_full_capacity_policy() p')).rows[0].p.available_usd),0);
  await assert.rejects(accept(db,q),/schedule exceeds/);
  assert.equal((await db.query('select count(*)::int n from paid_full_payment_holds')).rows[0].n,0);
  const policy=(await db.query('select * from provider_spend_policy')).rows[0];assert.equal(Number(policy.spend_cap_usd),25);assert.equal(Number(policy.call_reservation_usd),2.5);
 }finally{await db.close();}
});
