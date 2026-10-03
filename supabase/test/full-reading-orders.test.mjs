import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { buildReadingOrderContract, hashReadingOrder } from '../../apps/api/src/billing/full-reading-orders.ts';
import { hashPaidFullContract } from '../../apps/api/src/billing/full-takeoff-pricing.ts';

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
    '20261002140000_takeoff_measurement_review.sql','20261002150000_full_takeoff_regions.sql','20261002160000_full_takeoff_run_budgets.sql','20261003010000_paid_full_takeoff.sql','20261003020000_full_takeoff_budget_wait.sql','20261003030000_full_reading_orders.sql']) await db.exec(migration(file));
  await db.query('select touch_full_takeoff_v2_worker($1,$2)',['offline-worker',version]);
  return db;
}

const charge=(cost,fixed=30,fee=290)=>Number((BigInt(cost+fixed)*10000n+BigInt(10000-5000-fee)-1n)/BigInt(10000-5000-fee));
async function child(db,index,pages=1,options={}){
  const file=`30000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
  const sha=createHash('sha256').update(`synthetic-pdf-${index}`).digest('hex');
  await db.query('insert into project_files values($1,$2,$3,$4,$5,$6)',[file,ids.workspace,ids.project,`${ids.workspace}/${ids.project}/${file}/source.pdf`,'ready',pages]);
  const cost=1664*pages,full={...structuredClone(contract),manifest:{...structuredClone(manifest),fileSha256:sha,physicalPageCount:pages,
    sheets:Array.from({length:pages},(_,i)=>({...manifest.sheets[0],physicalPageNumber:i+1}))},maximumCalls:16*pages,
    providers:[{provider:'gemini',models:['gemini-3.8-flash'],approvedUsd:40*pages,maximumCalls:16*pages}],
    pricing:{...contract.pricing,costCents:cost,amountCents:charge(cost),paymentFixedCents:30,paymentFeeBps:290,operatingReserveUsd:40*pages,
      ...(options.expiresAt?{expiresAt:options.expiresAt}:{})}};
  const input={workspace_id:ids.workspace,project_id:ids.project,file_id:file,user_id:ids.user,file_sha256:sha,page_count:pages,trades:['Framing'],scope:'',
    amount_cents:full.pricing.amountCents,cost_cents:cost,pricing_version:'offline-test',membership:'standard',livemode:true,mode:'full_v2',full_contract:full,
    full_contract_hash:hashPaidFullContract(full)};
  return(await db.query('select create_paid_full_quote($1) q',[JSON.stringify(input)])).rows[0].q;
}
const scope={workspace_id:ids.workspace,project_id:ids.project,user_id:ids.user};
function inputFor(quotes){const contract=buildReadingOrderContract(quotes,scope);return {...scope,contract,contract_hash:hashReadingOrder(contract)};}
const create=(db,input)=>db.query('select create_full_reading_order($1) o',[JSON.stringify(input)]).then(result=>result.rows[0].o);
const accept=(db,order)=>db.query('select accept_full_reading_order($1,$2,$3,$4,$5) o',[order.id,ids.user,ids.workspace,ids.project,order.contract_hash]).then(r=>r.rows[0].o);
const session=(db,order,id=`cs_${order.id.replaceAll('-','')}`)=>db.query('select save_full_reading_order_session($1,$2) o',[order.id,id]).then(r=>r.rows[0].o);
const pay=(db,order,event=`evt_${order.id.replaceAll('-','')}`)=>db.query('select confirm_full_reading_order_payment($1,$2,$3,$4,$5,$6,true) o',
  [event,order.id,order.stripe_session_id,`pi_${order.id.replaceAll('-','')}`,order.amount_cents,'usd']).then(r=>r.rows[0].o);
const close=(db,order,reason='refund',event=`evt_close_${order.id.replaceAll('-','')}`)=>db.query('select close_full_reading_order_payment($1,$2,$3,$4,true,$5) closed',
  [event,order.id,reason==='refund'?null:order.stripe_session_id,reason==='expired'||reason==='failed'?null:`pi_${order.id.replaceAll('-','')}`,reason]).then(r=>r.rows[0].closed);
const scalar=async(db,sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];

test('one order applies one fixed fee, matches API largest remainders and links exact immutable child contracts',async()=>{
 const db=await fixture();try{
  const children=[await child(db,1),await child(db,2,2)],input=inputFor(children),order=await create(db,input);
  assert.equal(order.amount_cents,charge(4992));assert.ok(order.amount_cents<children.reduce((sum,q)=>sum+q.amount_cents,0));
  assert.equal(await scalar(db,'select sum(amount_cents)::integer from full_reading_order_items where order_id=$1',[order.id]),order.amount_cents);
  const stored=(await db.query('select quote_id,amount_cents from full_reading_order_items where order_id=$1 order by quote_id',[order.id])).rows;
  assert.deepEqual(stored,input.contract.items.map(i=>({quote_id:i.quote_id,amount_cents:i.amount_cents})));
  const quotes=(await db.query('select id,amount_cents,purchase_order_id,stripe_session_id,payment_intent_id from project_reading_quotes order by id')).rows;
  for(const q of quotes){assert.equal(q.amount_cents,children.find(c=>c.id===q.id).amount_cents);assert.equal(q.purchase_order_id,order.id);assert.equal(q.stripe_session_id,null);assert.equal(q.payment_intent_id,null);}
  assert.equal((await create(db,input)).id,order.id);
  await assert.rejects(create(db,{...input,contract:{...input.contract,workspace_id:ids.project}}),/contract/);
  assert.equal(await scalar(db,'select count(*)::integer from private.full_reading_order_write_guards'),0);
 }finally{await db.close();}
});

test('invalid fee, allocation, source identity and competing order cannot consume a child or leave partial rows',async()=>{
 const db=await fixture();try{
  const children=[await child(db,1),await child(db,2)],input=inputFor(children);
  for(const mutate of [c=>{c.pricing.amountCents++},c=>{c.items[0].amount_cents++;c.items[1].amount_cents--},
    c=>{c.items[0].file_sha256='f'.repeat(64)},c=>{c.items[1].quote_id=c.items[0].quote_id},c=>{c.user_id=ids.project}]){
    const candidate=structuredClone(input);mutate(candidate.contract);candidate.contract_hash=hashReadingOrder(candidate.contract);
    await assert.rejects(create(db,candidate));
    assert.equal(await scalar(db,'select count(*)::integer from full_reading_orders'),0);
    assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where purchase_order_id is not null'),0);
  }
  const [a,b]=await Promise.all([create(db,input),create(db,input)]);assert.equal(a.id,b.id);
  await assert.rejects(create(db,inputFor([children[0]])),/child is unavailable/);
  assert.equal(await scalar(db,'select count(*)::integer from full_reading_orders'),1);
 }finally{await db.close();}
});

test('accept rolls back all holds and consent if any child fails',async()=>{
 const db=await fixture();try{
  const children=[await child(db,1),await child(db,2)],order=await create(db,inputFor(children));
  await db.query("update project_reading_quotes set expires_at=now()-interval '1 minute' where id=$1",[children[1].id]);
  await assert.rejects(accept(db,order),/consent is required/);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds'),0);
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where full_consent is not null'),0);
  assert.equal(await scalar(db,'select count(*)::integer from private.full_reading_order_write_guards'),0);
  assert.equal(await scalar(db,'select consent from full_reading_orders where id=$1',[order.id]),null);
 }finally{await db.close();}
});

test('standalone checkout consent or an uncertain hold cannot be converted into a second order checkout',async()=>{
 const db=await fixture();try{
  const accepted=await child(db,1),held=await child(db,2);
  await db.query('select accept_paid_full_quote($1,$2,$3,$4,$5)',[accepted.id,ids.user,ids.workspace,ids.project,accepted.full_contract_hash]);
  await db.query('insert into paid_full_payment_holds(quote_id,reserved_usd) values($1,40)',[held.id]);
  for(const q of [accepted,held]) await assert.rejects(create(db,inputFor([q])),/child is unavailable/);
  for(const q of [accepted,held]) await assert.rejects(db.query('select create_paid_full_quote($1)',[JSON.stringify({...q,new_order_child:true})]),/PDF already belongs to an accepted or paid purchase/);
  assert.equal(await scalar(db,'select count(*)::integer from full_reading_orders'),0);
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where purchase_order_id is not null'),0);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds'),2);
 }finally{await db.close();}
});

test('changing an unaccepted selection uses fresh immutable children and fences the reverse checkout race',async()=>{
 const db=await fixture();try{
  const a=await child(db,1),b=await child(db,2),c=await child(db,3),old=await create(db,inputFor([a,b]));
  const fresh=[];
  for(const q of [a,b]) fresh.push((await db.query('select create_paid_full_quote($1) q',[JSON.stringify({...q,new_order_child:true})])).rows[0].q);
  assert.notEqual(fresh[0].id,a.id);assert.notEqual(fresh[1].id,b.id);
  const expanded=await create(db,inputFor([...fresh,c]));
  assert.equal(await scalar(db,'select purchase_order_id from project_reading_quotes where id=$1',[a.id]),old.id);
  await accept(db,expanded);
  await assert.rejects(accept(db,old),/PDF already belongs to an accepted or paid purchase/);
  assert.equal(await scalar(db,'select consent from full_reading_orders where id=$1',[old.id]),null);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds'),3);
  const saved=await session(db,expanded);await pay(db,saved);
  await assert.rejects(db.query('select create_paid_full_quote($1)',[JSON.stringify({...a,new_order_child:true})]),/PDF already belongs to an accepted or paid purchase/);
 }finally{await db.close();}
});

test('aggregate tariff horizon and an initially saturated window are checked atomically at create and accept',async()=>{
 const db=await fixture();try{
  await db.exec('update provider_spend_policy set spend_cap_usd=25');
  const expiresAt=new Date(Date.now()+2.5*86400_000).toISOString();
  const children=[await child(db,1,1,{expiresAt}),await child(db,2,1,{expiresAt})];
  // Each PDF fits in two windows, but 32 calls need four windows at ten calls/window.
  await assert.rejects(create(db,inputFor(children)),/schedule exceeds/);
  assert.equal(await scalar(db,'select count(*)::integer from full_reading_orders'),0);
  const later=await child(db,3,1,{expiresAt:new Date(Date.now()+3.5*86400_000).toISOString()});
  const later2=await child(db,4,1,{expiresAt:new Date(Date.now()+3.5*86400_000).toISOString()});
  const order=await create(db,inputFor([later,later2]));
  await db.exec('insert into geometry_provider_spend_reservations(reserved_usd) values(25)');
  await assert.rejects(accept(db,order),/schedule exceeds/);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds'),0);
  assert.equal(await scalar(db,'select consent from full_reading_orders where id=$1',[order.id]),null);
  assert.equal(await scalar(db,'select count(*)::integer from private.full_reading_order_write_guards'),0);
 }finally{await db.close();}
});

test('daily capacity cannot sell only part of a batch when another purchase consumed its slots',async()=>{
 const db=await fixture();try{
  const pair=[await child(db,1),await child(db,2)],order=await create(db,inputFor(pair));
  for(let index=3;index<27;index++){
   const q=await child(db,index);
   await db.query('insert into paid_full_payment_holds(quote_id,reserved_usd) values($1,40)',[q.id]);
  }
  await assert.rejects(accept(db,order),/Daily Full Takeoff limit/);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds'),24);
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where purchase_order_id=$1 and full_consent is not null',[order.id]),0);
  assert.equal(await scalar(db,'select consent from full_reading_orders where id=$1',[order.id]),null);
 }finally{await db.close();}
});

test('refund arriving before completion revokes the entire accepted order and fences late payment',async()=>{
 const db=await fixture();try{
  const order=await create(db,inputFor([await child(db,1),await child(db,2)]));await accept(db,order);const saved=await session(db,order);
  const intent=`pi_${saved.id.replaceAll('-','')}`;
  await assert.rejects(db.query('select close_full_reading_order_payment($1,$2,null,$3,true,$4)',['evt_early_bad',saved.id,intent,'refund']),/closing event mismatch/);
  assert.equal(await scalar(db,'select close_full_reading_order_payment($1,$2,$3,$4,true,$5)',['evt_early_refund',saved.id,saved.stripe_session_id,intent,'refund']),true);
  assert.equal((await pay(db,saved)).status,'revoked');
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where paid_at is not null'),0);
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds where released_at is null'),0);
 }finally{await db.close();}
});

test('only the accepted parent can confirm one live payment, repeated events do not duplicate grants and refund fences every child',async()=>{
 const db=await fixture();try{
  const children=[await child(db,1),await child(db,2)],order=await create(db,inputFor(children));
  await accept(db,order);let saved=await session(db,order);assert.equal((await session(db,order,saved.stripe_session_id)).id,order.id);
  await assert.rejects(session(db,order,'cs_different'),/session mismatch/);
  for(const args of [ ['evt_badmode',saved.id,saved.stripe_session_id,'pi_wrong',saved.amount_cents,'usd',false],
    ['evt_badamount',saved.id,saved.stripe_session_id,'pi_wrong',saved.amount_cents+1,'usd',true],
    ['evt_badsession',saved.id,'cs_wrong','pi_wrong',saved.amount_cents,'usd',true] ]){
    await assert.rejects(db.query('select confirm_full_reading_order_payment($1,$2,$3,$4,$5,$6,$7)',args),/payment mismatch/);
  }
  saved=await pay(db,saved);assert.equal(saved.status,'paid');assert.equal(Number(saved.payment_revision),1);
  await pay(db,saved);await pay(db,saved,'evt_other_paid');
  assert.equal(await scalar(db,'select sum(payment_revision)::integer from project_reading_quotes where purchase_order_id=$1',[saved.id]),2);
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where stripe_session_id is not null or payment_intent_id is not null'),0);
  const runs=[];
  for(const q of children){const reserved=await db.query('select reserve_paid_full_takeoff_v2($1,$2,$3,$4,$5,$6,$7) r',[q.id,ids.user,ids.workspace,ids.project,q.file_id,q.full_contract_hash,version]);runs.push(reserved.rows[0].r.run);}
  assert.equal(await close(db,saved),true);assert.equal(await close(db,saved),false);
  assert.equal((await pay(db,saved,'evt_late_paid')).status,'revoked');
  for(const run of runs){assert.equal(await scalar(db,'select private.full_takeoff_authorized($1,$2)',[run.id,ids.user]),false);assert.equal(await scalar(db,'select status from takeoff_runs where id=$1',[run.id]),'cancelled');}
  assert.equal(await scalar(db,'select count(*)::integer from paid_full_payment_holds where released_at is null'),0);
  assert.equal(await scalar(db,'select count(*)::integer from project_reading_quotes where status=$1',['revoked']),2);
 }finally{await db.close();}
});

test('signed expiry closes only unpaid orders and event identity cannot be reused for another operation',async()=>{
 const db=await fixture();try{
  const order=await create(db,inputFor([await child(db,1)]));await accept(db,order);const saved=await session(db,order);
  assert.equal(await close(db,saved,'expired'),true);
  assert.equal((await pay(db,saved)).status,'revoked');
  await assert.rejects(close(db,saved,'failed'),/event identity conflict/);
  const other=await create(db,inputFor([await child(db,2)]));await accept(db,other);const paid=await pay(db,await session(db,other));
  assert.equal(await close(db,paid,'expired'),false);assert.equal(await scalar(db,'select status from full_reading_orders where id=$1',[paid.id]),'paid');
 }finally{await db.close();}
});

test('ordered children reject standalone payment/accept and caller-controlled settings cannot bypass the private write guard',async()=>{
 const db=await fixture();try{
  const q=await child(db,1),order=await create(db,inputFor([q]));
  await assert.rejects(db.query('select accept_paid_full_quote($1,$2,$3,$4,$5)',[q.id,ids.user,ids.workspace,ids.project,q.full_contract_hash]),/combined Full order/);
  await accept(db,order);
  await assert.rejects(db.query('select accept_paid_full_quote($1,$2,$3,$4,$5)',[q.id,ids.user,ids.workspace,ids.project,q.full_contract_hash]),/combined Full order/);
  await assert.rejects(db.query('select confirm_project_reading_payment($1,$2,$3,$4,$5,$6,true)',['evt_standalone',q.id,'cs_single','pi_single',q.amount_cents,'usd']),/belongs to its order/);
  await db.exec('set role service_role');
  try{
    await db.query("select set_config('roughbid.order_write',$1,false)",[order.id]);
    await assert.rejects(db.query("update project_reading_quotes set status='paid',paid_at=now(),payment_revision=1 where id=$1",[q.id]),/requires its order operation/);
    await assert.rejects(db.query('insert into private.full_reading_order_write_guards values(txid_current(),pg_backend_pid(),$1)',[order.id]),/permission denied/);
    await assert.rejects(db.query("update full_reading_orders set status='paid' where id=$1",[order.id]),/permission denied/);
    await assert.rejects(db.query('select accept_paid_full_quote_before_orders($1,$2,$3,$4,$5)',[q.id,ids.user,ids.workspace,ids.project,q.full_contract_hash]),/permission denied/);
  }finally{await db.exec('reset role');}
  await db.exec('set role authenticated');try{await assert.rejects(db.query('select * from full_reading_orders'),/permission denied/);}finally{await db.exec('reset role');}
  assert.equal(await scalar(db,'select count(*)::integer from private.full_reading_order_write_guards'),0);
 }finally{await db.close();}
});
