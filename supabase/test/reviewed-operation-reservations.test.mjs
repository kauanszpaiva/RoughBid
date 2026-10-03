import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, ids, version, manifest, accept, reserve, claim, rpc, scalar, prepare, cmd, hold, dispatch, finish } from './provider-bridge-runtime.test.mjs';
import { buildPaidFullContract, hashPaidFullContract } from '../../apps/api/src/billing/full-takeoff-pricing.ts';
import { buildReadingOrderContract, hashReadingOrder } from '../../apps/api/src/billing/full-reading-orders.ts';
import { multiproviderEnv } from '../../apps/api/test/full-takeoff-multiprovider.test.ts';

function makeContract(extra={},source=manifest){
 const env={...multiproviderEnv(),...extra},profile=JSON.parse(env.PAID_FULL_PROFILE_JSON);
 for(const route of Object.values(profile.routes))route.tariff.expiresAt='2099-01-01T00:00:00Z';
 env.PAID_FULL_PROFILE_JSON=JSON.stringify(profile);
 return buildPaidFullContract({manifest:source,membership:'standard',env,companyPolicy:{callReservationUsd:2.5,spendCapUsd:25},now:Date.parse('2026-10-03T00:00:00Z')});
}
const fresh=async()=>{const db=await fixture();await db.exec(readFileSync(new URL('../migrations/20261003060000_reviewed_operation_reservations.sql',import.meta.url),'utf8'));await db.exec('update provider_spend_policy set spend_cap_usd=25');return db;};
async function createQuote(db,c=makeContract(),file=ids.file){
 return rpc(db,'create_paid_full_quote',[{workspace_id:ids.workspace,project_id:ids.project,file_id:file,user_id:ids.user,
  file_sha256:c.manifest.fileSha256,page_count:c.manifest.physicalPageCount,trades:['Framing'],scope:'',amount_cents:c.pricing.amountCents,cost_cents:c.pricing.costCents,
  pricing_version:c.pricing.version,membership:'standard',livemode:true,mode:'full_v2',full_contract:c,full_contract_hash:hashPaidFullContract(c)}]);
}
async function setup(){
 const db=await fresh(),contract=makeContract(),q=await createQuote(db,contract);await accept(db,q);
 await rpc(db,'confirm_project_reading_payment',[`evt_${q.id}`,q.id,`cs_${q.id}`,`pi_${q.id}`,q.amount_cents,'usd',true]);
 const {run}=await reserve(db,q),c=await claim(db,run);
 for(const p of contract.providers)await db.query('select configure_full_takeoff_run_budget($1,$2,$3,$4,$5,$6,$7)',[run.id,c.lease_id,p.provider,p.models,p.approvedUsd,p.maximumCalls,`paid-full-v2:${q.id}:1`]);
 const profile={version:'full-stage-bridge-v1',template_version:'full-evidence-v1',requestTimeoutMs:120000,regionalReview:{enabled:true,grid:2},
  stages:Object.fromEntries(Object.entries(contract.profile.routes).map(([name,route])=>[name,route]))};
 return{db,contract,q,run,c,profile};
}
test('reviewed admission advertises required capability and legacy wrapper stays private',async()=>{
 const db=await fresh();try{
  assert.deepEqual(await rpc(db,'provider_bridge_schema_ready',[]),{ready:true,reservationCapability:'reviewed-operation-reservations-v1'});
  assert.equal(await scalar(db,"select has_function_privilege('service_role','reserve_provider_spend_before_reviewed_operations(uuid,uuid,uuid,uuid,text,text)','EXECUTE')"),false);
  assert.equal(await scalar(db,"select has_function_privilege('authenticated','reserve_provider_spend(uuid,uuid,uuid,uuid,text,text,numeric)','EXECUTE')"),false);
 }finally{await db.close();}
});
test('actual TS contract validates every operation; NULLs, alias pages, duplicate coverage and cap changes fail closed',async()=>{
 const db=await fresh();try{
  const original=makeContract();assert.equal(await rpc(db,'private.validate_full_operation_contract',[original]),true);
  for(const key of ['operatingReserveUsd','providerCostUpperBoundUsd','expiresAt']){
   const c=structuredClone(original);delete c.pricing[key];assert.equal(await rpc(db,'private.validate_full_operation_contract',[c]),false,key);
   await assert.rejects(createQuote(db,c),/Invalid paid Full contract/);
  }
  for(const mutate of [c=>{c.operations[0].physicalPageNumber='01';c.operations[0].key='page:01:classification:whole';},
   c=>{c.operations[1]=structuredClone(c.operations[0]);},c=>{c.operations.reverse();},c=>{c.operations[0].reservationUsd=1;},
   c=>{c.operations[0].reservationUsd=2.5000001;},c=>{c.profile.routes.classification.tariff.expiresAt='not-a-date';},
   c=>{delete c.profile.routes.classification.tariff.source;},c=>{delete c.profile.routes.classification.tariff.maximumAcceptedInput;},
   c=>{c.manifest.sheets[0].physicalPageNumber=2;}]){
   const c=structuredClone(original);mutate(c);assert.equal(await rpc(db,'private.validate_full_operation_contract',[c]),false);
  }
  await db.exec('update provider_spend_policy set spend_cap_usd=24');assert.equal(await rpc(db,'private.validate_full_operation_contract',[original]),false);
 }finally{await db.close();}
});
test('Astra24.52 uses frozen individual hold, shared25 cap waits beforedispatch, unknown result neverreplays',async()=>{
 const f=await setup();try{
  const p=await prepare(f,'reconciliation',null,f.profile),c=cmd(p),reserved=await hold(f,c);
  assert.equal(reserved.state,'reserved');assert.equal(Number(await scalar(f.db,'select reserved_usd from provider_spend_reservations where event_id=$1',[reserved.event_id])),24.52);
  assert.equal((await hold(f,c)).event_id,reserved.event_id);
  const next=await prepare(f,'classification',null,f.profile);assert.equal((await hold(f,cmd(next))).state,'waiting_budget');
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),1);
  const won=await dispatch(f,c,reserved.state_version);assert.equal(won.won,true);
  const done=await finish(f,won,{},'unknown');assert.equal(done.state,'dispatch_unknown');assert.equal(done.cost_state,'held_unknown');
  assert.equal((await hold(f,c)).state,'dispatch_unknown');
  assert.equal(Number(await scalar(f.db,'select call_reservation_usd from provider_spend_policy')),2.5);
  assert.equal(Number(await scalar(f.db,'select spend_cap_usd from provider_spend_policy')),25);
 }finally{await f.db.close();}
});
test('7arg rejects mismatched bound and direct operation; sixarg cannot bypass new consent',async()=>{
 const f=await setup();try{
  const p=await prepare(f,'reconciliation',null,f.profile),event=p.operation.event_id;
  await f.db.query('insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'openai','gpt-6-astra',`rb1:${f.run.id}:generate:pending`]);
  const params=[event,f.run.id,ids.workspace,ids.user,'openai','gpt-6-astra'];
  await assert.rejects(rpc(f.db,'reserve_provider_spend',params),/Reviewed operation reservation required/);
  await assert.rejects(rpc(f.db,'reserve_provider_spend',[...params,2.5]),/differs from consent/);
  await assert.rejects(rpc(f.db,'reserve_provider_spend',[...params,null]),/Invalid reviewed/);
  await assert.rejects(rpc(f.db,'reserve_provider_spend',['90000000-0000-4000-8000-000000000009',...params.slice(1),24.52]),/requires its durable operation/);
  assert.equal(await scalar(f.db,'select count(*)::int from provider_spend_reservations'),0);
 }finally{await f.db.close();}
});
test('next-fit preserves indivisible holds and initial headroom, not averagecost scheduling',async()=>{
 const db=await fresh();try{
  const c=makeContract();let remaining=25,windows=0;
  for(const op of c.operations){if(op.reservationUsd>remaining){windows++;remaining=25;}remaining-=op.reservationUsd;}
  assert.equal(await rpc(db,'private.full_contract_schedule_windows',[c,25,25]),windows);
  let lowRemaining=.1,lowWindows=0;for(const op of c.operations){if(op.reservationUsd>lowRemaining){lowWindows++;lowRemaining=25;}lowRemaining-=op.reservationUsd;}
  assert.equal(await rpc(db,'private.full_contract_schedule_windows',[c,25,.1]),lowWindows);
  assert.ok(windows>Math.ceil(c.pricing.operatingReserveUsd/25)-1);
 }finally{await db.close();}
});
test('budgetwait releases lease until enough exposure expires for24.52 rather than2.5',async()=>{
 const f=await setup();try{
  // Only explicitly settled known geometry can have a capacity expiry.
  await f.db.exec("insert into geometry_provider_spend_reservations(reserved_usd,telemetry_known,estimated_cost_usd,created_at,settled_at) values(10,true,10,now()-interval '2 hours',now()-interval '2 hours')");
  const p=await prepare(f,'reconciliation',null,f.profile),reserved=await hold(f,cmd(p));assert.equal(reserved.state,'waiting_budget');
  const wait=await rpc(f.db,'wait_full_takeoff_budget',[f.run.id,f.c.lease_id,reserved.event_id,1,'reconciliation','offline-wait']);
  assert.equal(wait.status,'waiting_budget');assert.ok(Date.parse(wait.not_before)>Date.now()+21*3600_000);
 }finally{await f.db.close();}
});

async function twoChildren(db){
 const file='30000000-0000-4000-8000-000000000002',extra={PROJECT_PAYMENT_FIXED_CENTS:'30',PROJECT_PAYMENT_FEE_BPS:'290',PAID_FULL_OVERHEAD_BASE_CENTS:'300',PAID_FULL_OVERHEAD_PAGE_CENTS:'25'};
 await db.query('insert into project_files values($1,$2,$3,$4,$5,$6)',[file,ids.workspace,ids.project,`${ids.workspace}/${ids.project}/${file}/source.pdf`,'ready',1]);
 return[await createQuote(db,makeContract(extra)),await createQuote(db,makeContract(extra,{...manifest,fileSha256:'f'.repeat(64)}),file)];
}
test('multi-provider PDF order charges one fee and runs next-fit in frozen item order',async()=>{
 const db=await fresh();try{
  const children=await twoChildren(db),scope={workspace_id:ids.workspace,project_id:ids.project,user_id:ids.user};
  const contract=buildReadingOrderContract(children,scope);
  const order=await rpc(db,'create_full_reading_order',[{...scope,contract,contract_hash:hashReadingOrder(contract)}]);
  assert.ok(order.amount_cents<children[0].amount_cents+children[1].amount_cents);
  assert.equal(order.cost_cents,children[0].cost_cents+children[1].cost_cents-300);
  assert.equal(contract.pricing.overheadBasePolicy,'purchase');
  assert.equal(order.amount_cents,contract.pricing.amountCents);
  await rpc(db,'accept_full_reading_order',[order.id,ids.user,ids.workspace,ids.project,order.contract_hash]);
  assert.equal(await scalar(db,'select count(*)::int from paid_full_payment_holds where released_at is null'),2);
  assert.equal(await scalar(db,'select count(*)::int from provider_spend_reservations'),0);
  assert.equal(await scalar(db,'select count(*)::int from takeoff_runs'),0);
 }finally{await db.close();}
});
test('database rejects mixed operation policies before accepting a PDF order',async()=>{
 const db=await fresh();try{
  const children=await twoChildren(db),scope={workspace_id:ids.workspace,project_id:ids.project,user_id:ids.user};
  const contract=buildReadingOrderContract(children,scope);
  // Private admin mutation only models inconsistent internal data; real immutable trigger prevents it.
  await db.exec('alter table project_reading_quotes disable trigger protect_paid_full_contract');
  await db.query("update project_reading_quotes set full_contract=jsonb_set(full_contract,'{policyId}',to_jsonb($1::text)) where id=$2",['e'.repeat(64),children[1].id]);
  await db.exec('alter table project_reading_quotes enable trigger protect_paid_full_contract');
  await assert.rejects(rpc(db,'create_full_reading_order',[{...scope,contract,contract_hash:hashReadingOrder(contract)}]),/processing policies differ/);
  assert.equal(await scalar(db,'select count(*)::int from full_reading_orders'),0);
 }finally{await db.close();}
});
