import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixture, ids, version, quote, accept, pay, reserve, claim, configure, rpc, scalar, prepare, cmd, hold, contract } from './provider-bridge-runtime.test.mjs';

async function fresh() {
  const db=await fixture();
  await db.exec(readFileSync(new URL('../migrations/20261003060000_reviewed_operation_reservations.sql',import.meta.url),'utf8'));
  await db.exec('update provider_spend_policy set spend_cap_usd=25');
  return db;
}
async function providerExposure(db,amount=25) {
  const event=randomUUID(),job=randomUUID();
  await db.query('insert into plan_reading_jobs(id,workspace_id,project_id,file_id,requested_by,status) values($1,$2,$3,$4,$5,$6)',[job,ids.workspace,ids.project,ids.file,ids.user,'queued']);
  await db.query('insert into api_usage_events(id,workspace_id,project_id,user_id,provider,model,operation) values($1,$2,$3,$4,$5,$6,$7)',[event,ids.workspace,ids.project,ids.user,'gemini','gemini-3.8-flash','synthetic-test']);
  await db.query('insert into provider_spend_reservations(event_id,job_id,workspace_id,user_id,provider,model,reserved_usd) values($1,$2,$3,$4,$5,$6,$7)',[event,job,ids.workspace,ids.user,'gemini','gemini-3.8-flash',amount]);
  return event;
}
const capacity=db=>rpc(db,'paid_full_capacity_policy',[]);

test('persistent exposure keeps aged reserved and captured-unknown money until explicit settlement',async()=>{
  const db=await fresh();try{
    const event=await providerExposure(db);
    await db.query("update provider_spend_reservations set created_at=now()-interval '3 days' where event_id=$1",[event]);
    assert.equal((await capacity(db)).available_usd,0);assert.equal((await capacity(db)).non_expiring_usd,25);
    assert.equal(await rpc(db,'private.company_next_capacity_at',[2.5]),null);
    await assert.rejects(db.exec('insert into geometry_provider_spend_reservations(reserved_usd) values(1)'),/Company AI spend limit/);
    await db.query("update provider_spend_reservations set status='captured',telemetry_known=false,settled_at=now()-interval '2 days' where event_id=$1",[event]);
    assert.equal((await capacity(db)).available_usd,0);assert.equal((await capacity(db)).window_capacity_usd,0);
    await assert.rejects(rpc(db,'private.full_contract_schedule_windows',[contract,0,0]),/capacity|schedule/i);
    // A known late response is counted from settlement, not the old reservation.
    await db.query("update provider_spend_reservations set telemetry_known=true,estimated_cost_usd=25,settled_at=now() where event_id=$1",[event]);
    const after=await capacity(db);assert.equal(after.available_usd,0);assert.equal(after.non_expiring_usd,0);assert.equal(after.window_capacity_usd,25);
    assert.ok(Date.parse(await rpc(db,'private.company_next_capacity_at',[2.5]))>Date.now()+23*3600_000);
    await db.query("update provider_spend_reservations set settled_at=now()-interval '25 hours' where event_id=$1",[event]);
    assert.equal((await capacity(db)).available_usd,25);
    assert.ok(Date.parse(await rpc(db,'private.company_next_capacity_at',[2.5]))<=Date.now()+1000);
  }finally{await db.close();}
});

test('persistent geometry exposure has no inferred completion, and known actual overages are never truncated',async()=>{
  const db=await fresh();try{
    await db.exec("insert into geometry_provider_spend_reservations(reserved_usd,created_at) values(10,now()-interval '3 days')");
    let p=await capacity(db);assert.equal(p.available_usd,15);assert.equal(p.window_capacity_usd,15);
    assert.equal(await rpc(db,'private.company_next_capacity_at',[24.52]),null);
    // A flag without a settlement receipt/date still cannot expire a reservation.
    await db.exec('update geometry_provider_spend_reservations set telemetry_known=true,estimated_cost_usd=10');
    assert.equal((await capacity(db)).non_expiring_usd,10);
    await db.exec("update geometry_provider_spend_reservations set settled_at=now()-interval '25 hours'");
    assert.equal((await capacity(db)).available_usd,25);
    const event=await providerExposure(db,2.5);
    await db.query("update provider_spend_reservations set status='captured',telemetry_known=true,estimated_cost_usd=30,settled_at=now() where event_id=$1",[event]);
    assert.equal(await scalar(db,'select sum(amount) from private.company_spend_exposure()'),'30');
    assert.equal((await capacity(db)).available_usd,0);
    await assert.rejects(db.exec('insert into geometry_provider_spend_reservations(reserved_usd) values(1)'),/Company AI spend limit/);
    assert.equal((await capacity(db)).spend_cap_usd,25);assert.equal((await capacity(db)).call_reservation_usd,2.5);
  }finally{await db.close();}
});

test('captured cost is immutable, uncertainty can resolve, and retries keep the original settlement time',async()=>{
 const db=await fresh();try{
  const event=await providerExposure(db,2.5);
  await rpc(db,'capture_provider_spend',[event,null]);
  assert.equal((await capacity(db)).non_expiring_usd,2.5);
  await rpc(db,'capture_provider_spend',[event,30]);
  const before=await scalar(db,'select settled_at from provider_spend_reservations where event_id=$1',[event]);
  await rpc(db,'capture_provider_spend',[event,30]);
  assert.deepEqual(await scalar(db,'select settled_at from provider_spend_reservations where event_id=$1',[event]),before);
  for(const amount of [null,0,2.5])await assert.rejects(rpc(db,'capture_provider_spend',[event,amount]),/cannot be replaced/);
  await assert.rejects(rpc(db,'capture_provider_spend',[event,'NaN']),/finite/);
  assert.equal((await capacity(db)).available_usd,0);
  assert.equal(Number(await scalar(db,'select sum(amount) from private.company_spend_exposure()')),30);
 }finally{await db.close();}
});

test('persistent unknown wait has no invented ETA, resumes after resolution, and retains fairness and consent fences',async()=>{
  const db=await fresh();try{
    const q=await quote(db);await accept(db,q);await pay(db,q);
    const {run}=await reserve(db,q),c=await claim(db,run);await configure(db,q,run,c.lease_id);
    const f={db,q,run,c};
    await db.exec("insert into geometry_provider_spend_reservations(reserved_usd,created_at) values(25,now()-interval '3 days')");
    const p=await prepare(f),denied=await hold(f,cmd(p));assert.equal(denied.state,'waiting_budget');
    const waiting=await rpc(db,'wait_full_takeoff_budget',[run.id,c.lease_id,denied.event_id,1,'classification','synthetic-unsent']);
    assert.equal(waiting.status,'waiting_budget');assert.equal(waiting.not_before,null);
    assert.deepEqual((await db.query('select * from due_full_takeoff_budget_runs($1)',[version])).rows,[]);
    // Explicit synthetic settlement proves this was not a paid charge.
    await db.exec('update geometry_provider_spend_reservations set telemetry_known=true,estimated_cost_usd=0,settled_at=now()');
    assert.deepEqual((await db.query('select * from due_full_takeoff_budget_runs($1)',[version])).rows,[{run_id:run.id}]);
    await assert.rejects(db.exec('insert into geometry_provider_spend_reservations(reserved_usd) values(1)'),/waiting reading has the next turn/);
    await db.exec('update workspaces set ai_processing_consented_at=null');
    assert.deepEqual((await db.query('select * from due_full_takeoff_budget_runs($1)',[version])).rows,[]);
    assert.equal(await scalar(db,'select error_code from takeoff_runs where id=$1',[run.id]),'reading_authorization_ended');
    assert.equal(await scalar(db,'select count(*)::int from provider_spend_reservations'),0);
  }finally{await db.close();}
});
