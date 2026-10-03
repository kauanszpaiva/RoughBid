import test from 'node:test';
import assert from 'node:assert/strict';
import {photoDatabase,USER,WORKSPACE,PROJECT,PHOTO,REQUEST_KEY} from '../../apps/api/test/helpers/photo-db.mjs';

const profile='a'.repeat(64),hash='b'.repeat(64);
const asset={id:PHOTO,workspaceId:WORKSPACE,projectId:PROJECT,sha256:hash,revision:hash,mimeType:'image/png',byteSize:100,widthPixels:200,heightPixels:200,storageVerified:true};
async function call(db,name,args){const result=await db.client.rpc(name,args);if(result.error)throw new Error(result.error.message);return result.data;}
async function setup(){
  const db=await photoDatabase();
  try{
    await db.sql.query("insert into photo_assets(id,workspace_id,project_id,uploaded_by,storage_path,original_name,mime_type,byte_size) values($1,$2,$3,$4,$5,'test.png','image/png',100)",
      [PHOTO,WORKSPACE,PROJECT,USER,`${WORKSPACE}/${PROJECT}/photos/${PHOTO}/source.png`]);
    await db.sql.query("update photo_assets set status='ready',sha256=$1,width_pixels=200,height_pixels=200,completed_at=now() where id=$2",[hash,PHOTO]);
    await call(db,'touch_photo_takeoff_worker',{p_worker_id:'test-worker',p_profile_hash:profile,p_version:'photo-takeoff-v1'});
    return db;
  }catch(error){await db.close();throw error;}
}
const reserve=(db,changes={})=>call(db,'reserve_photo_takeoff',{p_workspace_id:WORKSPACE,p_project_id:PROJECT,p_user_id:USER,p_request_key:REQUEST_KEY,
  p_assets:[asset],p_references:[],p_profile_hash:profile,p_provider:'openai',p_model:'gpt-6-astra',p_approved_budget_usd:10,p_budget_approval_ref:'test-explicit-approval-v1',...changes});
const claim=(db,id)=>call(db,'claim_photo_takeoff',{p_run_id:id,p_worker_id:'test-worker',p_profile_hash:profile});
const begin=(db,id,lease)=>call(db,'begin_photo_takeoff_step',{p_run_id:id,p_lease_id:lease,p_asset_id:PHOTO});
const checkpoint=(db,id,lease)=>call(db,'checkpoint_photo_takeoff_step',{p_run_id:id,p_lease_id:lease,p_asset_id:PHOTO,p_result:{observations:[],independentReview:'pending'}});
async function event(db,run,id=crypto.randomUUID(),changes={}){
  await db.client.from('api_usage_events').insert({id,workspace_id:WORKSPACE,project_id:PROJECT,user_id:USER,provider:'openai',model:'gpt-6-astra',operation:`rb1:${run}:generate:pending`,...changes});return id;
}
const spend=(db,id,lease,eventId,changes={})=>call(db,'reserve_photo_provider_spend',{p_event_id:eventId,p_run_id:id,p_lease_id:lease,p_asset_id:PHOTO,
  p_workspace_id:WORKSPACE,p_user_id:USER,p_provider:'openai',p_model:'gpt-6-astra',...changes});

test('photo migrations execute with scoped FKs, founder/consent checks and service-only writers',async()=>{
  const db=await setup();try{
    const grants=(await db.sql.query("select proname,has_function_privilege('authenticated',oid,'EXECUTE') browser,has_function_privilege('service_role',oid,'EXECUTE') service from pg_proc where proname like '%photo_takeoff%' or proname='reserve_photo_provider_spend'")).rows;
    assert.ok(grants.length>=12);assert.ok(grants.every(row=>!row.browser&&row.service));
    assert.equal((await db.sql.query("select has_table_privilege('authenticated','photo_assets','INSERT') permitted")).rows[0].permitted,false);
    const audit=(await db.sql.query("select has_table_privilege('authenticated','photo_takeoff_reviews','SELECT') browser,has_table_privilege('service_role','photo_takeoff_reviews','UPDATE') mutable,has_table_privilege('service_role','photo_takeoff_reviews','INSERT') direct_write")).rows[0];
    assert.equal(audit.browser,false);assert.equal(audit.mutable,false);assert.equal(audit.direct_write,false);
    const first=await reserve(db),second=await reserve(db);assert.equal(first.run.id,second.run.id);assert.equal(second.reused,true);
    await assert.rejects(reserve(db,{p_assets:[asset,asset]}),/Duplicate photo/);
    await assert.rejects(reserve(db,{p_assets:[{...asset,projectId:crypto.randomUUID()}]}),/source not verified/);
    await assert.rejects(reserve(db,{p_request_key:crypto.randomUUID(),p_approved_budget_usd:null}),/input invalid/);
    await db.sql.exec('update workspaces set ai_processing_consented_at=null');await assert.rejects(reserve(db),/access denied/);
    await db.sql.exec('update workspaces set ai_processing_consented_at=now();update profiles set is_platform_admin=false');await assert.rejects(reserve(db),/access denied/);
    await assert.rejects(db.sql.query('update photo_takeoff_steps set workspace_id=$1 where run_id=$2',[crypto.randomUUID(),first.run.id]),/foreign key/);
  }finally{await db.close();}
});
test('safe checkpoints resume after lease expiry; an uncertain step cannot auto-retry or be overwritten',async()=>{
  const db=await setup();try{
    const {run}=await reserve(db),active=await claim(db,run.id);assert.equal(await begin(db,run.id,active.lease_id),'run');
    await db.sql.query("update photo_takeoff_runs set lease_expires_at=now()-interval '1 second' where id=$1",[run.id]);
    const blocked=await claim(db,run.id);assert.equal(blocked.skip,true);assert.equal(blocked.reconciliation_required,true);
    await assert.rejects(call(db,'resume_photo_takeoff',{p_run_id:run.id,p_workspace_id:WORKSPACE,p_user_id:USER,p_profile_hash:profile}),/reconciliation/);
    await assert.rejects(checkpoint(db,run.id,active.lease_id),/lease invalid/);
    const safe=(await reserve(db,{p_request_key:crypto.randomUUID()})).run.id,claimed=await claim(db,safe);
    await begin(db,safe,claimed.lease_id);await checkpoint(db,safe,claimed.lease_id);
    await db.sql.query("update photo_takeoff_runs set lease_expires_at=now()-interval '1 second' where id=$1",[safe]);
    const resumed=await claim(db,safe);assert.notEqual(resumed.lease_id,claimed.lease_id);assert.equal(await begin(db,safe,resumed.lease_id),'completed');
    const result=await call(db,'finish_photo_takeoff',{p_run_id:safe,p_lease_id:resumed.lease_id,p_result:{pricingStatus:'missing_price',estimate:null,humanReviewRequired:true,independentReview:'pending'}});
    assert.equal(result.status,'needs_review');assert.equal((await claim(db,safe)).skip,true);
  }finally{await db.close();}
});
test('photo spend retains unknown cost exposure and enforces approved run/provider and company caps',async()=>{
  const db=await setup();try{
    const {run}=await reserve(db,{p_approved_budget_usd:2.5}),active=await claim(db,run.id);await begin(db,run.id,active.lease_id);
    const first=await event(db,run.id),reserved=await spend(db,run.id,active.lease_id,first);
    assert.equal(reserved.photo_run_id,run.id);assert.equal(reserved.photo_asset_id,PHOTO);assert.equal(reserved.job_id,null);assert.equal(reserved.takeoff_run_id,null);
    assert.equal(Number(reserved.reserved_usd),2.5);await spend(db,run.id,active.lease_id,first);
    assert.equal((await db.sql.query('select count(*)::int count from provider_spend_reservations')).rows[0].count,1);
    await call(db,'capture_provider_spend',{p_event_id:first,p_estimated_cost_usd:null});
    const next=await event(db,run.id);await assert.rejects(spend(db,run.id,active.lease_id,next),/approved spend limit/);
    const captured=(await db.sql.query('select telemetry_known,reserved_usd,estimated_cost_usd from provider_spend_reservations where event_id=$1',[first])).rows[0];
    assert.equal(captured.telemetry_known,false);assert.equal(captured.estimated_cost_usd,null);assert.equal(Number(captured.reserved_usd),2.5);
    await db.sql.exec('update provider_spend_policy set spend_cap_usd=2.5');await assert.rejects(spend(db,run.id,active.lease_id,next),/Company AI spend limit/);
    await db.sql.exec('update provider_spend_policy set spend_cap_usd=25');
    const wrong=await event(db,run.id,crypto.randomUUID(),{project_id:crypto.randomUUID()});await assert.rejects(spend(db,run.id,active.lease_id,wrong),/event not authorized/);
    await assert.rejects(spend(db,run.id,active.lease_id,next,{p_model:'claude-opus-5-5',p_provider:'claude'}),/access denied/);
    await call(db,'cancel_photo_takeoff',{p_run_id:run.id,p_workspace_id:WORKSPACE,p_user_id:USER});
    assert.equal(await call(db,'heartbeat_photo_takeoff',{p_run_id:run.id,p_lease_id:active.lease_id,p_worker_id:'test-worker'}),false);
    await assert.rejects(spend(db,run.id,active.lease_id,next),/access denied/);
  }finally{await db.close();}
});
test('photo spend checks workspace consent again at dispatch and cannot exceed the shared founder daily allowance',async()=>{
  const db=await setup();try{
    const {run}=await reserve(db),active=await claim(db,run.id);await begin(db,run.id,active.lease_id);
    const pending=await event(db,run.id);await db.sql.exec('update workspaces set ai_processing_consented_at=null');
    await assert.rejects(spend(db,run.id,active.lease_id,pending),/access denied/);
    await db.sql.exec('update workspaces set ai_processing_consented_at=now()');
    for(let index=0;index<24;index++)await db.sql.query('insert into plan_reading_jobs(id,workspace_id,project_id,requested_by) values($1,$2,$3,$4)',[crypto.randomUUID(),WORKSPACE,PROJECT,USER]);
    await assert.rejects(reserve(db,{p_request_key:crypto.randomUUID()}),/Daily AI reading limit/);
  }finally{await db.close();}
});
