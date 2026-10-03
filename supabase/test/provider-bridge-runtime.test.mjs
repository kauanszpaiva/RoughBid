import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { decodeUsageOperation } from '../../packages/domain/src/api-usage.ts';

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
    create table geometry_provider_spend_reservations(id uuid default gen_random_uuid(),reserved_usd numeric,telemetry_known boolean not null default false,estimated_cost_usd numeric,created_at timestamptz default now());
    insert into auth.users values('${ids.user}');insert into profiles values('${ids.user}',false);insert into workspaces values('${ids.workspace}',now());
    insert into workspace_members values('${ids.workspace}','${ids.user}','estimator');insert into projects values('${ids.project}','${ids.workspace}');
    insert into project_files values('${ids.file}','${ids.workspace}','${ids.project}','${ids.workspace}/${ids.project}/${ids.file}/source.pdf','ready',1);`);
  for(const file of ['0017_paid_project_readings.sql','0023_durable_ai_plan_jobs.sql','20260910225937_takeoff_v2_foundation.sql','20261002120000_full_takeoff_v2_durable.sql',
    '20261002140000_takeoff_measurement_review.sql','20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql','20261003010000_paid_full_takeoff.sql','20261003020000_full_takeoff_budget_wait.sql','20261003030000_full_reading_orders.sql','20261003040000_provider_execution_bridge.sql']) await db.exec(migration(file));
  await db.exec(`alter table api_usage_events add column input_tokens integer default 0,add column output_tokens integer default 0,
    add column estimated_cost_usd numeric default 0,add column provider_request_id text;
    alter table provider_spend_reservations add column settled_at timestamptz;`);
  const capture=migration('0039_commercial_spend_and_marketplace.sql').split('create function public.capture_provider_spend')[1].split('revoke all on function')[0];
  await db.exec('create function public.capture_provider_spend'+capture);
  await db.query('select touch_full_takeoff_v2_worker($1,$2)',['40000000-0000-4000-8000-000000000001',version]);
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
async function claim(db,run){return(await db.query('select claim_full_takeoff_v2($1,$2,$3) as c',[run.id,'40000000-0000-4000-8000-000000000001',version])).rows[0].c;}
async function configure(db,q,run,lease){return db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',[run.id,lease,'gemini',['gemini-3.8-flash'],40,16,`paid-full-v1:${q.id}:1`]);}
async function spend(db,run,event){
  await db.query('insert into api_usage_events values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'gemini','gemini-3.8-flash',`rb1:${run.id}:generate:pending`]);
  return db.query('select reserve_provider_spend($1,$2,$3,$4,$5,$6)',[event,run.id,ids.workspace,ids.user,'gemini','gemini-3.8-flash']);
}

export { fixture, quote, accept, pay, reserve, claim, configure, ids, version, manifest, contract, scalar, rpc, prepare, cmd, hold, dispatch, finish, profile, stage, worker, generation };
const worker='40000000-0000-4000-8000-000000000001',generation='50000000-0000-4000-8000-000000000001';
const stage={provider:'gemini',model:'gemini-3.8-flash',reasoningEffort:'high',maxOutputTokens:64000,
  attestation:{accountVerified:true,compatibilityVerified:true,priceVersion:'offline',maximumCallCostUsd:1.04}};
const profile={version:'full-stage-bridge-v1',template_version:'full-evidence-v1',requestTimeoutMs:60000,regionalReview:{enabled:true,grid:2},
  stages:Object.fromEntries(['classification','legends_schedules','discipline','reconciliation','conflict_detection','completeness','risk_review'].map(p=>[p,stage]))};
const scalar=async(db,sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const rpc=(db,name,args)=>scalar(db,`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args.map(x=>x&&typeof x==='object'?JSON.stringify(x):x));
async function setup(){const db=await fixture(),q=await quote(db);await accept(db,q);await pay(db,q);const{run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);return{db,q,run,c};}
const prepare=(f,pass='classification',region=null,config=profile)=>rpc(f.db,'prepare_provider_bridge_full_operation',[f.run.id,f.c.lease_id,worker,generation,1,pass,region,config]);
const cmd=(p,action='submit_stage')=>({action,protocol:version,run_id:p.operation.run_id,operation_id:p.operation.id,worker:p.worker,
  ...(action==='submit_stage'?{expected_stage_version:1,expected_approved_contract_sha256:'d'.repeat(64),expected_operation_spec_sha256:'e'.repeat(64)}:{})});
const authorize=(f,c,nonce='a'.repeat(64),body='b'.repeat(64),time=Math.floor(Date.now()/1000))=>rpc(f.db,'authorize_provider_bridge_command',[c,'unit/bridge',nonce,body,time]);
const hold=(f,c)=>rpc(f.db,'reserve_provider_bridge_operation',[c]);
const dispatch=(f,c,v)=>rpc(f.db,'claim_provider_bridge_dispatch',[c,v,'e'.repeat(64),'f'.repeat(64),{file_sha256:manifest.fileSha256,page_bytes_sha256:'1'.repeat(64),input_bytes_sha256:'2'.repeat(64)}]);
const result={raw:{id:'mock-result',contents:['actual mocked response']},usage:{inputTokens:10,outputTokens:20}};
const finish=(f,op,usage={},outcome='result')=>rpc(f.db,'finalize_provider_bridge_operation',[op.operation.id,op.dispatch_token,outcome==='result'?result:null,outcome==='result'?'3'.repeat(64):null,usage,outcome]);

test('bridge service-only schema, authoritative source and stable operation survive JSON key order',async()=>{
 const f=await setup();try{
  assert.equal(await rpc(f.db,'provider_bridge_schema_ready',[]),true);
  const p=await prepare(f),again=await prepare(f);assert.equal(p.operation.id,again.operation.id);assert.equal(p.operation.state,'planned');assert.equal(p.worker.fence,'1');
  assert.deepEqual(p.operation.spec.sheet,manifest.sheets[0]);assert.equal(p.operation.spec.user_id,ids.user);
  const denied=await scalar(f.db,"select has_function_privilege('authenticated','prepare_provider_bridge_full_operation(uuid,uuid,uuid,uuid,integer,text,text,jsonb)','EXECUTE')");assert.equal(denied,false);
  assert.equal(await scalar(f.db,"select has_table_privilege('service_role','provider_bridge_operations','UPDATE')"),false);
  await assert.rejects(prepare(f,'classification','r1c1g2'),/region_invalid/);
  await assert.rejects(prepare(f,'discipline','r0c0g2'),/region_invalid/);
  await assert.rejects(prepare(f,'discipline','r3c1g2'),/region_invalid/);
  assert.equal((await prepare(f,'discipline','r1c1g2')).operation.spec.region_key,'r1c1g2');
  await assert.rejects(prepare(f,'classification',null,{...profile,requestTimeoutMs:60001}),/spec_conflict/);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),0);
 }finally{await f.db.close();}
});
test('nonce replay is read-only, conflicting body rejected, time and current authority checked on GET too',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),time=Math.floor(Date.now()/1000);
  assert.equal((await authorize(f,c,'a'.repeat(64),'b'.repeat(64),time)).replay,false);
  assert.equal((await authorize(f,c,'a'.repeat(64),'b'.repeat(64),time)).replay,true);
  await assert.rejects(authorize(f,c,'a'.repeat(64),'c'.repeat(64),time),/nonce_conflict/);
  await assert.rejects(authorize(f,c,'d'.repeat(64),'b'.repeat(64),time-100),/auth_expired/);
  const get=cmd(p,'get_operation');await assert.rejects(hold(f,get),/read_only/);
  const bad={...get,worker:{...get.worker,worker_generation:'60000000-0000-4000-8000-000000000001'}};
  await assert.rejects(authorize(f,bad),/authority_denied/);
  await f.db.exec('update workspaces set ai_processing_consented_at=null');
  await assert.rejects(authorize(f,get),/authority_denied/);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),0);
 }finally{await f.db.close();}
});
test('one ledger reservation, one CAS dispatch and token-bound finalization preserve unknown cost',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c),b=await hold(f,c);assert.equal(a.event_id,b.event_id);assert.equal(a.state,'reserved');
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
  const d=await dispatch(f,c,a.state_version);assert.equal(d.won,true);assert.equal((await dispatch(f,c,a.state_version)).won,false);
  const done=await finish(f,d);assert.equal(done.state,'completed');assert.equal(done.cost_state,'held_unknown');assert.equal(done.captured_usd_micros,null);
  assert.deepEqual(await finish(f,d),done);
  await assert.rejects(finish(f,d,{},'unknown'),/result_conflict/);
  const ledger=(await f.db.query('select status,telemetry_known,reserved_usd from provider_spend_reservations')).rows[0];
  assert.equal(ledger.status,'captured');assert.equal(ledger.telemetry_known,false);assert.equal(Number(ledger.reserved_usd),2.5);
  const saved=await rpc(f.db,'read_provider_bridge_result',[cmd(p,'get_operation')]);assert.deepEqual(saved.result,result);
  assert.equal((await hold(f,c)).state,'completed');
  await assert.rejects(rpc(f.db,'begin_funded_full_takeoff_v2_pass',[f.run.id,f.c.lease_id,1,'risk_review',1,'4'.repeat(64),a.event_id]),/not funded/);
  assert.equal(await rpc(f.db,'begin_funded_full_takeoff_v2_pass',[f.run.id,f.c.lease_id,1,'classification',1,'4'.repeat(64),a.event_id]),'run');
 }finally{await f.db.close();}
});
test('known telemetry is captured once; wrong source and dispatch token cannot mutate money',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c);
  await assert.rejects(rpc(f.db,'claim_provider_bridge_dispatch',[c,a.state_version,'e'.repeat(64),'f'.repeat(64),{file_sha256:'f'.repeat(64),page_bytes_sha256:'1'.repeat(64),input_bytes_sha256:'2'.repeat(64)}]),/payload_invalid/);
  const d=await dispatch(f,c,a.state_version);
  await assert.rejects(finish(f,{...d,dispatch_token:worker}),/token_invalid/);
  const done=await finish(f,d,{input_tokens:10,output_tokens:20,estimated_cost_usd:0.003});assert.equal(done.captured_usd_micros,'3000');
  assert.equal(decodeUsageOperation(await scalar(f.db,'select operation from api_usage_events'))?.state,'measured');
  await assert.rejects(finish(f,d,{estimated_cost_usd:0.01}),/result_conflict/);
  assert.equal(Number(await scalar(f.db,'select estimated_cost_usd from provider_spend_reservations')),0.003);
 }finally{await f.db.close();}
});
test('budget denial records provably unsent waiting; next window reuses its event without double reservation',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p);await f.db.exec('update provider_spend_policy set spend_cap_usd=2');
  const waiting=await hold(f,c);assert.equal(waiting.state,'waiting_budget');assert.equal(waiting.cost_state,'unreserved');
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),0);
  assert.match(await scalar(f.db,'select operation from api_usage_events'),/blocked_spend_limit$/);
  await f.db.exec('update provider_spend_policy set spend_cap_usd=25');
  const funded=await hold(f,c);assert.equal(funded.state,'reserved');assert.equal(funded.event_id,waiting.event_id);
  assert.equal(await scalar(f.db,'select count(*)::int from api_usage_events'),1);
 }finally{await f.db.close();}
});
test('unknown dispatch is never replayed or released by lease age; stale dispatch can finalize but not deliver',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c),d=await dispatch(f,c,a.state_version);
  await f.db.exec("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second'");
  const old=await claim(f.db,f.run);assert.equal(old.reconciliation_required,true);
  const done=await finish(f,d);assert.equal(done.state,'completed');
  await assert.rejects(rpc(f.db,'read_provider_bridge_result',[cmd(p,'get_operation')]),/authority_denied/);
  await rpc(f.db,'restart_full_takeoff_v2',[f.run.id,ids.user,ids.workspace]);f.c=await claim(f.db,f.run);
  const next=await prepare(f);assert.equal(next.operation.id,p.operation.id);assert.equal(next.worker.fence,'2');
  assert.deepEqual((await rpc(f.db,'read_provider_bridge_result',[cmd(next,'get_operation')])).result,result);
  await assert.rejects(authorize(f,c),/authority_denied/);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
 }finally{await f.db.close();}
});
test('durable unknown outcome remains held and forbids any new dispatch after a restart request',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c),d=await dispatch(f,c,a.state_version),unknown=await finish(f,d,{},'unknown');
  assert.equal(unknown.state,'dispatch_unknown');assert.equal((await hold(f,c)).state,'dispatch_unknown');
  assert.equal((await dispatch(f,c,unknown.state_version)).won,false);
  await f.db.exec("update takeoff_runs set status='failed',worker_lease_expires_at=now()-interval '1 day'");
  await assert.rejects(rpc(f.db,'restart_full_takeoff_v2',[f.run.id,ids.user,ids.workspace]),/reconciliation/);
  assert.equal(Number(await scalar(f.db,'select reserved_usd from provider_spend_reservations')),2.5);
 }finally{await f.db.close();}
});
test('refund fences GET/reservation while allowing original in-flight result to settle its held ledger',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c),d=await dispatch(f,c,a.state_version);
  await rpc(f.db,'revoke_project_reading_payment',['evt_refund',f.q.id,`pi_${f.q.id}`,true]);
  assert.equal((await finish(f,d)).state,'completed');
  await assert.rejects(authorize(f,cmd(p,'get_operation')),/authority_denied/);
  await assert.rejects(hold(f,c),/authority_denied/);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
 }finally{await f.db.close();}
});

test('reserved crash resumes the same unsent event and invalidates the previous lease fence',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c);
  await f.db.exec("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second'");
  f.c=await claim(f.db,f.run);assert.equal(f.c.skip,false);
  const next=await prepare(f);assert.equal(next.worker.fence,'2');assert.equal(next.operation.event_id,a.event_id);
  await assert.rejects(hold(f,c),/authority_denied/);
  assert.equal((await hold(f,cmd(next))).event_id,a.event_id);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
 }finally{await f.db.close();}
});
test('regional attachment crash recovers completed evidence and never resets a failed parsing checkpoint',async()=>{
 const f=await setup();try{
  const p=await prepare(f,'discipline','r1c1g2'),c=cmd(p),a=await hold(f,c),d=await dispatch(f,c,a.state_version);await finish(f,d);
  const identity='4'.repeat(64),region={columns:2,rows:2,column:1,row:1,x:0,y:0,width:100,height:50};
  assert.equal(await rpc(f.db,'begin_funded_full_takeoff_v2_pass',[f.run.id,f.c.lease_id,1,'discipline',1,identity,a.event_id]),'run');
  const args=[f.run.id,f.c.lease_id,1,manifest.sheets[0].pageSha256,'discipline','r1c1g2',region,identity,a.event_id];
  assert.equal((await rpc(f.db,'begin_funded_full_takeoff_region',args)).disposition,'run');
  await f.db.exec("update takeoff_runs set worker_lease_expires_at=now()-interval '1 second'");f.c=await claim(f.db,f.run);assert.equal(f.c.skip,false);
  assert.equal(await rpc(f.db,'inspect_full_takeoff_v2_pass',[f.run.id,f.c.lease_id,1,'discipline',1,identity]),'run');
  assert.equal(await rpc(f.db,'begin_funded_full_takeoff_v2_pass',[f.run.id,f.c.lease_id,1,'discipline',1,identity,a.event_id]),'run');
  args[1]=f.c.lease_id;assert.equal((await rpc(f.db,'inspect_full_takeoff_region',args.slice(0,8))).disposition,'run');
  assert.equal((await rpc(f.db,'begin_funded_full_takeoff_region',args)).disposition,'run');
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
  await f.db.exec("update takeoff_passes set status='failed';update takeoff_runs set status='failed'");
  await assert.rejects(rpc(f.db,'restart_full_takeoff_v2',[f.run.id,ids.user,ids.workspace]),/reconciliation/);
 }finally{await f.db.close();}
});
test('NULL cannot bypass CAS or choose an implicit outcome',async()=>{
 const f=await setup();try{
  const p=await prepare(f),c=cmd(p),a=await hold(f,c);
  await assert.rejects(dispatch(f,c,null),/payload_invalid/);
  const d=await dispatch(f,c,a.state_version);
  await assert.rejects(rpc(f.db,'finalize_provider_bridge_operation',[d.operation.id,d.dispatch_token,null,null,{},null]),/result_invalid/);
  assert.equal(await scalar(f.db,'select state from provider_bridge_operations'),'dispatching');
 }finally{await f.db.close();}
});
