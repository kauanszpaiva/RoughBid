import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ids={user:'00000000-0000-4000-8000-000000000001',workspace:'10000000-0000-4000-8000-000000000001',
  project:'20000000-0000-4000-8000-000000000001',file:'30000000-0000-4000-8000-000000000001'};
const version='takeoff-v2.2-durable';
const manifest={fileSha256:'a'.repeat(64),physicalPageCount:1,sheets:[{physicalPageNumber:1,pageSha256:'b'.repeat(64),widthPoints:200,heightPoints:100,rotationDegrees:0,contentKind:'vector',textQuality:'good'}]};
const contract={version:'paid-full-v1',manifest,policyId:'c'.repeat(64),maximumCalls:16,regionGrid:2,stages:['classification'],
  executionPolicy:'one-durable-run-no-uncertain-replay',providers:[{provider:'gemini',models:['gemini-3.8-flash'],approvedUsd:40,maximumCalls:16}],
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
    '20261002140000_takeoff_measurement_review.sql','20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql','20261003010000_paid_full_takeoff.sql']) await db.exec(migration(file));
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

test('paid Full SQL requires live confirmed consent, binds one run, preserves quick/free isolation and immutable contract',async()=>{
  const db=await fixture();try{
    const q=await quote(db);await assert.rejects(pay(db,q),/consent/);await assert.rejects(reserve(db,q),/Confirmed paid/);
    await accept(db,q);assert.equal(await pay(db,q),true);assert.equal(await pay(db,q),false);
    const [a,b]=await Promise.all([reserve(db,q),reserve(db,q)]);assert.equal(a.run.id,b.run.id);
    assert.equal((await db.query('select count(*)::int n from takeoff_runs')).rows[0].n,1);
    await assert.rejects(db.query('select reserve_project_reading_async($1,$2,$3,$4,$5,$6)',[q.id,ids.user,ids.workspace,ids.project,ids.file,'legacy']),/Paid quote required/);
    await assert.rejects(db.query('update project_reading_quotes set amount_cents=1 where id=$1',[q.id]),/immutable/);
    await assert.rejects(db.query("update takeoff_runs set payment_kind='complimentary',payment_quote_id=null,payment_revision=null where id=$1",[a.run.id]),/immutable/);
    await db.exec('update profiles set is_platform_admin=true');
    const free=(await db.query('select reserve_full_takeoff_v2($1,$2,$3,$4,$5,$6) r',[ids.user,ids.workspace,ids.project,ids.file,JSON.stringify(manifest),version])).rows[0].r;
    assert.notEqual(free.run.id,a.run.id);
    const grants=(await db.query("select has_function_privilege('authenticated','reserve_paid_full_takeoff_v2(uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE') browser,has_function_privilege('service_role','reserve_paid_full_takeoff_v2(uuid,uuid,uuid,uuid,uuid,text,text)','EXECUTE') service")).rows[0];
    assert.equal(grants.browser,false);assert.equal(grants.service,true);
  }finally{await db.close();}
});

test('checkout holds serialize competing purchases and every provider sees capacity without double-counting paid calls',async()=>{
  const db=await fixture();try{
    const a=await quote(db),b=await quote(db,'e'.repeat(64));await db.exec('update provider_spend_policy set spend_cap_usd=40');
    const attempts=await Promise.allSettled([accept(db,a),accept(db,b)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
    const q=attempts[0].status==='fulfilled'?a:b;await accept(db,q); // reopening one's own checkout is idempotent
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() as value')).rows[0].value),40);
    await assert.rejects(db.query('insert into geometry_provider_spend_reservations(reserved_usd) values(2.5)'),/Company AI spend/);
    await pay(db,q);const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
    await spend(db,run,'40000000-0000-4000-8000-000000000001');
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),37.5);
    await db.exec("update provider_spend_reservations set status='captured',telemetry_known=true,estimated_cost_usd=0.5");
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),39.5);
    await assert.rejects(db.query('insert into geometry_provider_spend_reservations(reserved_usd) values(0.01)'),/Company AI spend/);
    await db.exec('update provider_spend_policy set call_reservation_usd=3');
    assert.equal((await db.query('select paid_full_capacity_ready(40,2.5,$1) ready',[q.id])).rows[0].ready,false);
  }finally{await db.close();}
});

test('revocation stops claim, heartbeat, pass, spending, finish, restart and review even for a platform admin',async()=>{
  const db=await fixture();try{
    const q=await quote(db);await accept(db,q);await pay(db,q);const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
    await db.exec('update profiles set is_platform_admin=true');
    await db.query('select revoke_project_reading_payment($1,$2,$3,true)',['evt_refund',q.id,`pi_${q.id}`]);await pay(db,q,'evt_late_payment');
    assert.equal((await db.query('select heartbeat_full_takeoff_v2($1,$2,$3) alive',[run.id,c.lease_id,'offline-worker'])).rows[0].alive,false);
    await assert.rejects(claim(db,run),/authorization revoked/);
    await assert.rejects(db.query("select begin_full_takeoff_v2_pass($1,$2,1,'classification',1,$3)",[run.id,c.lease_id,'f'.repeat(64)]),/authorization revoked/);
    await assert.rejects(spend(db,run,'40000000-0000-4000-8000-000000000002'),/authorization revoked/);
    await assert.rejects(db.query('select finish_full_takeoff_v2($1,$2,$3)',[run.id,c.lease_id,'{}']),/authorization revoked/);
    await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]),/access denied/);
    assert.equal((await db.query('select full_takeoff_run_access($1,$2,$3) allowed',[run.id,ids.user,ids.workspace])).rows[0].allowed,false);
    await assert.rejects(db.query('select record_takeoff_measurement_review($1,$2,$3,$4)',[run.id,ids.workspace,ids.user,'{}']),/access denied/);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[q.id])).rows[0].status,'revoked');
  }finally{await db.close();}
});

test('only matching signed terminal payment events release holds; local expiry and late events cannot release paid exposure',async()=>{
  const db=await fixture();try{
    const a=await quote(db);await accept(db,a);await db.query("update project_reading_quotes set expires_at=now()-interval '1 day' where id=$1",[a.id]);
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),40);
    const fail=(q,event,mode=true)=>db.query('select fail_paid_full_payment($1,$2,$3,$4,$5)',[event,q.id,`cs_${q.id}`,mode,'expired']);
    await assert.rejects(fail(a,'evt_wrong_mode',false),/does not match/);await fail(a,'evt_expired');await fail(a,'evt_expired');
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),0);
    const b=await quote(db,'e'.repeat(64));await accept(db,b);await pay(db,b);await fail(b,'evt_stale_expiry');
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),40);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[b.id])).rows[0].status,'paid');
  }finally{await db.close();}
});

test('paid resume keeps checkpoints and budget, uncertain calls cannot replay, completed review releases only unused hold',async()=>{
  const db=await fixture();try{
    const q=await quote(db);await accept(db,q);await pay(db,q);const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
    await spend(db,run,'40000000-0000-4000-8000-000000000003');
    const checkpoint=async(lease,pass,key)=>{
      await db.query('select begin_full_takeoff_v2_pass($1,$2,1,$3,1,$4)',[run.id,lease,pass,key]);
      await db.query('select checkpoint_full_takeoff_v2_pass($1,$2,1,$3,1,$4,$5,null)',[run.id,lease,pass,key,JSON.stringify({status:'blocked',checkpoint:{blockers:['No measured quantity is invented.']}})]);
    };
    await checkpoint(c.lease_id,'classification','0'.repeat(64));
    await db.query('select cancel_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[q.id])).rows[0].status,'failed');
    await db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]);const resumed=await claim(db,run);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[q.id])).rows[0].status,'processing');
    assert.equal((await db.query("select begin_full_takeoff_v2_pass($1,$2,1,'classification',1,$3) result",[run.id,resumed.lease_id,'0'.repeat(64)])).rows[0].result,'already_blocked');
    await configure(db,q,run,resumed.lease_id);
    const remaining=['legends_schedules','geometry','discipline','reconciliation','conflict_detection','completeness','arithmetic_qa','pricing_assemblies','risk_review'];
    for(const[i,pass]of remaining.entries())await checkpoint(resumed.lease_id,pass,(i+1).toString(16).repeat(64));
    await db.query('select finish_full_takeoff_v2($1,$2,$3)',[run.id,resumed.lease_id,'{}']);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[q.id])).rows[0].status,'complete');
    assert.equal(Number((await db.query('select private.paid_full_held_exposure() value')).rows[0].value),0);
    const spendSaved=(await db.query('select reserved_usd,telemetry_known from provider_spend_reservations')).rows[0];
    assert.equal(Number(spendSaved.reserved_usd),2.5);assert.equal(spendSaved.telemetry_known,false);
    assert.equal((await db.query('select full_takeoff_run_access($1,$2,$3) allowed',[run.id,ids.user,ids.workspace])).rows[0].allowed,true);
    await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]),/cannot restart/);

    const q2=await quote(db,'e'.repeat(64));await accept(db,q2);await pay(db,q2);const {run:uncertain}=await reserve(db,q2),leased=await claim(db,uncertain);
    await db.query("select begin_full_takeoff_v2_pass($1,$2,1,'classification',1,$3)",[uncertain.id,leased.lease_id,'f'.repeat(64)]);
    await db.query("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second' where id=$1",[uncertain.id]);
    assert.equal((await claim(db,uncertain)).reconciliation_required,true);
    assert.equal((await db.query('select status from project_reading_quotes where id=$1',[q2.id])).rows[0].status,'failed');
    await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[uncertain.id,ids.user,ids.workspace]),/reconciliation/);
  }finally{await db.close();}
});

test('tariff expiry fences active paid dispatch and heartbeat without blocking access or cancellation',async()=>{
  const db=await fixture();try{
    const expiring={...contract,pricing:{...contract.pricing,expiresAt:new Date(Date.now()+1600).toISOString()}};
    const q=await quote(db,'d'.repeat(64),expiring);await accept(db,q);await pay(db,q);const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
    await new Promise(resolve=>setTimeout(resolve,1700));
    assert.equal((await db.query('select heartbeat_full_takeoff_v2($1,$2,$3) alive',[run.id,c.lease_id,'offline-worker'])).rows[0].alive,false);
    await assert.rejects(spend(db,run,'40000000-0000-4000-8000-000000000004'),/authorization revoked/);
    assert.equal((await db.query('select full_takeoff_run_access($1,$2,$3) allowed',[run.id,ids.user,ids.workspace])).rows[0].allowed,true);
    await db.query('select cancel_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]);
    assert.equal((await db.query('select status from takeoff_runs where id=$1',[run.id])).rows[0].status,'cancelled');
    await assert.rejects(db.query('select restart_full_takeoff_v2($1,$2,$3)',[run.id,ids.user,ids.workspace]),/access denied/);
  }finally{await db.close();}
});

test('daily run limit reserves a checkout slot and blocks purchase before charging, including competing complimentary runs',async()=>{
  const db=await fixture();try{
    const a=await quote(db),b=await quote(db,'e'.repeat(64));
    await db.query("insert into takeoff_runs(workspace_id,project_id,file_id,mode,status,file_sha256,orchestrator_version,requested_by) select $1,$2,$3,'full','failed',$4,'historical-'||n,$5 from generate_series(1,24) n",
      [ids.workspace,ids.project,ids.file,manifest.fileSha256,ids.user]);
    await accept(db,a);await accept(db,a);
    assert.equal((await db.query('select paid_full_daily_capacity_ready($1) ready',[ids.user])).rows[0].ready,false);
    await assert.rejects(accept(db,b),/Daily Full/);
    await assert.rejects(quote(db,'f'.repeat(64)),/Daily Full/);
    await db.exec('update profiles set is_platform_admin=true');
    await assert.rejects(db.query('select reserve_full_takeoff_v2($1,$2,$3,$4,$5,$6)',[ids.user,ids.workspace,ids.project,ids.file,JSON.stringify(manifest),version]),/Daily Full/);
    await pay(db,a);const first=await reserve(db,a),repeated=await reserve(db,a);assert.equal(first.run.id,repeated.run.id);
    assert.equal((await db.query('select count(*)::int n from takeoff_runs')).rows[0].n,25);
    assert.equal((await db.query('select paid_full_daily_capacity_ready($1) ready',[ids.user])).rows[0].ready,false);
  }finally{await db.close();}
});
