import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeUsageOperation} from '../../packages/domain/src/api-usage.ts';
import {completePhotoDatabase} from '../../apps/api/test/helpers/complete-photo-db.mjs';
import {seedCompletePhoto,payPhotoQuote,scalar,syntheticPhotoObservation} from '../../apps/api/test/helpers/complete-photo-fixture.mjs';
import {USER,WORKSPACE,PHOTO} from '../../apps/api/test/helpers/photo-db.mjs';
import {requirePhotoScheduling} from '../../apps/api/src/billing/photo-payments.ts';
const worker='60000000-0000-4000-8000-000000000001',generation='60000000-0000-4000-8000-000000000002';
const digest='a'.repeat(64),payload='b'.repeat(64);
async function fixture(){const db=await completePhotoDatabase({reviewedExposure:true});try{
 await db.sql.exec(readFileSync(new URL('../migrations/20261003070000_photo_execution_bridge.sql',import.meta.url),'utf8'));
 const seed=await seedCompletePhoto(db),quote=await payPhotoQuote(db.sql,seed.contract),saved=await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[quote.id]);
 const claim=await scalar(db.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[saved.run.id,worker,seed.config.profileHash]);
 const prepared=await scalar(db.sql,'select prepare_photo_bridge_operation($1,$2,$3,$4,$5,$6)',[saved.run.id,claim.lease_id,worker,generation,`observation:${PHOTO}`,JSON.stringify(seed.config.complete)]);
 return {...db,seed,quote,run:saved.run,claim,prepared,command:{protocol:'photo-complete-v1',action:'submit_stage',run_id:saved.run.id,operation_id:prepared.operation.id,worker:prepared.worker,
 expected_operation_spec_sha256:digest,expected_stage_version:1}};
 }catch(e){await db.close();throw e;}}
const reserve=f=>scalar(f.sql,'select reserve_photo_bridge_operation($1)',[JSON.stringify(f.command)]);
const hashes=f=>({assets:[{id:PHOTO,sha256:f.seed.asset.sha256}]});
const dispatch=(f,op,source=hashes(f))=>scalar(f.sql,'select claim_photo_bridge_dispatch($1,$2,$3,$4,$5)',[JSON.stringify(f.command),op.state_version,digest,payload,JSON.stringify(source)]);
const settle=(f,token,result=syntheticPhotoObservation(PHOTO),usage={input_tokens:100,output_tokens:50},outcome='result')=>scalar(f.sql,'select finalize_photo_bridge_operation($1,$2,$3,$4,$5,$6)',[f.prepared.operation.id,token,result?JSON.stringify(result):null,result?digest:null,JSON.stringify(usage),outcome]);
const read=f=>scalar(f.sql,'select read_photo_bridge_result($1)',[JSON.stringify({...f.command,action:'get_operation'})]);

test('photo bridge snapshot is authority-scoped, nonce replay is exact, and money/result commands are service-only',async()=>{
 const f=await fixture();try{
 const spec=f.prepared.operation.spec;assert.equal(spec.workspace_id,WORKSPACE);assert.equal(spec.user_id,USER);assert.equal(spec.approved_contract.quoteId,f.quote.id);
 assert.deepEqual(spec.assets,[f.seed.asset]);assert.deepEqual(spec.previous_stage_keys,[]);
 const now=Math.floor(Date.now()/1000),args=[JSON.stringify(f.command),'photo-test','c'.repeat(64),'d'.repeat(64),now];
 assert.equal((await scalar(f.sql,'select authorize_photo_bridge_command($1,$2,$3,$4,$5)',args)).replay,false);
 assert.equal((await scalar(f.sql,'select authorize_photo_bridge_command($1,$2,$3,$4,$5)',args)).replay,true);
 await assert.rejects(scalar(f.sql,'select authorize_photo_bridge_command($1,$2,$3,$4,$5)',[...args.slice(0,3),'e'.repeat(64),now]),/nonce_conflict/);
 await assert.rejects(reserve({...f,command:{...f.command,worker:{...f.command.worker,fence:'2'}}}),/authority/);
 assert.equal(await scalar(f.sql,"select has_function_privilege('authenticated','public.reserve_photo_bridge_operation(jsonb)','execute')"),false);
 assert.equal(await scalar(f.sql,"select has_table_privilege('service_role','photo_bridge_operations','update')"),false);
 assert.deepEqual(await scalar(f.sql,'select photo_provider_bridge_schema_ready()'),{ready:true,reservationCapability:'reviewed-operation-reservations-v1',photoCapability:'photo-bridge-v1'});
 }finally{await f.close();}
});

test('one bridge reservation and one dispatch CAS bind original photo hash; only the completed result funds attachment',async()=>{
 const f=await fixture();try{const op=await reserve(f);assert.equal(op.state,'reserved');assert.equal((await reserve(f)).event_id,op.event_id);
 await assert.rejects(dispatch(f,op,{assets:[{id:PHOTO,sha256:'f'.repeat(64)}]}),/source/);
 const first=await dispatch(f,op);assert.equal(first.won,true);assert.equal((await dispatch(f,op)).won,false);
 await assert.rejects(scalar(f.sql,'select begin_complete_photo_stage($1,$2,$3,$4)',[f.run.id,f.claim.lease_id,`observation:${PHOTO}`,op.event_id]),/not funded/);
 assert.equal(await scalar(f.sql,'select count(*)::integer from provider_spend_reservations'),1);
 const done=await settle(f,first.dispatch_token);assert.equal(done.state,'completed');assert.equal(done.cost_state,'held_unknown');
 assert.equal((await read(f)).result_sha256,digest);
 assert.equal(await scalar(f.sql,'select begin_complete_photo_stage($1,$2,$3,$4)',[f.run.id,f.claim.lease_id,`observation:${PHOTO}`,op.event_id]),true);
 assert.equal(await scalar(f.sql,'select checkpoint_complete_photo_stage($1,$2,$3,$4)',[f.run.id,f.claim.lease_id,`observation:${PHOTO}`,JSON.stringify(syntheticPhotoObservation(PHOTO))]),true);
 const reconciliation=await scalar(f.sql,'select prepare_photo_bridge_operation($1,$2,$3,$4,$5,$6)',[f.run.id,f.claim.lease_id,worker,generation,`reconciliation:${PHOTO}`,JSON.stringify(f.seed.config.complete)]);
 assert.deepEqual(reconciliation.operation.spec.previous_stage_keys,[`observation:${PHOTO}`]);
 await assert.rejects(settle(f,first.dispatch_token,{...syntheticPhotoObservation(PHOTO),blockers:['changed']}),/conflict/);
 }finally{await f.close();}
});

test('full company window refuses before bridge dispatch and retries the same unfunded event after safe wait',async()=>{
 const f=await fixture();try{await f.sql.exec('insert into geometry_provider_spend_reservations(reserved_usd)values(25)');
 const waiting=await reserve(f);assert.equal(waiting.state,'waiting_budget');assert.equal(waiting.reservation_id,null);
 assert.equal(await scalar(f.sql,'select count(*)::integer from provider_spend_reservations'),0);
 assert.equal((await dispatch(f,waiting)).won,false);
 await f.sql.exec("update geometry_provider_spend_reservations set created_at=now()-interval '25 hours'");
 assert.equal((await reserve(f)).state,'waiting_budget'); // Age cannot settle unknown spend.
 await f.sql.exec("update geometry_provider_spend_reservations set telemetry_known=true,estimated_cost_usd=25,settled_at=now()-interval '25 hours'");
 const admitted=await reserve(f);assert.equal(admitted.state,'reserved');assert.equal(admitted.event_id,waiting.event_id);
 assert.equal(await scalar(f.sql,'select count(*)::integer from provider_spend_reservations'),1);
 }finally{await f.close();}
});

test('late settlement after refund retains real cost but cannot deliver or dispatch again',async()=>{
 const f=await fixture();try{const op=await reserve(f),sent=await dispatch(f,op);
 await scalar(f.sql,'select close_photo_reading_payment($1,$2,$3,$4,true,$5)',['evt_photo_revoke',f.quote.id,'cs_synthetic','pi_synthetic','refund']);
 const done=await settle(f,sent.dispatch_token,syntheticPhotoObservation(PHOTO),{input_tokens:100,output_tokens:50,estimated_cost_usd:3});
 assert.equal(done.cost_state,'captured');assert.equal(done.captured_usd_micros,'3000000');
 assert.equal(decodeUsageOperation(await scalar(f.sql,'select operation from api_usage_events'))?.state,'measured');
 assert.equal(await scalar(f.sql,'select estimated_cost_usd::float from provider_spend_reservations'),3); // Never clamp an observed overage to the hold.
 await assert.rejects(read(f),/authority/);await assert.rejects(reserve(f),/authority/);
 assert.equal(await scalar(f.sql,'select status from photo_takeoff_runs'), 'cancelled');
 }finally{await f.close();}
});

test('uncertain exposure preserves an undated wait and only authoritative settled capacity wakes it',async()=>{
 const f=await fixture();try{
 await f.sql.exec("insert into geometry_provider_spend_reservations(reserved_usd,created_at)values(25,now()-interval '3 days')");
 const waiting=await reserve(f);assert.equal(waiting.state,'waiting_budget');assert.equal(waiting.not_before,null);
 await assert.rejects(requirePhotoScheduling(f.client,f.seed.contract),/available capacity/);
 await assert.rejects(scalar(f.sql,'select private.check_photo_schedule(manifest)from photo_takeoff_runs where id=$1',[f.run.id]),/capacity/);
 const parked=await scalar(f.sql,'select wait_complete_photo_budget($1,$2,$3)',[f.run.id,f.claim.lease_id,waiting.event_id]);
 assert.equal(parked.status,'waiting_budget');assert.equal(parked.not_before,null);
 assert.deepEqual(await scalar(f.sql,'select due_complete_photo_runs($1)',[f.seed.config.profileHash]),[]);
 assert.equal((await scalar(f.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[f.run.id,worker,f.seed.config.profileHash])).skip,true);
 assert.equal((await scalar(f.sql,'select resume_complete_photo_takeoff($1,$2,$3,$4)',[f.run.id,WORKSPACE,USER,f.seed.config.profileHash])).status,'waiting_budget');
 await f.sql.exec('update geometry_provider_spend_reservations set telemetry_known=true,estimated_cost_usd=25,settled_at=now()');
 assert.deepEqual(await scalar(f.sql,'select due_complete_photo_runs($1)',[f.seed.config.profileHash]),[]);
 await f.sql.exec("update geometry_provider_spend_reservations set settled_at=now()-interval '25 hours'");
 assert.deepEqual(await scalar(f.sql,'select due_complete_photo_runs($1)',[f.seed.config.profileHash]),[{id:f.run.id}]);
 assert.equal((await scalar(f.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[f.run.id,worker,f.seed.config.profileHash])).skip,false);
 assert.equal(await scalar(f.sql,'select count(*)::integer from provider_spend_reservations'),0);
 }finally{await f.close();}
});

test('unknown dispatch is never repeated and retains its full reservation',async()=>{
 const f=await fixture();try{const op=await reserve(f),sent=await dispatch(f,op),unknown=await settle(f,sent.dispatch_token,null,{},'unknown');
 assert.equal(unknown.state,'dispatch_unknown');assert.equal(unknown.cost_state,'held_unknown');assert.equal((await reserve(f)).state,'dispatch_unknown');
 await assert.rejects(read(f),/unavailable/);assert.equal(await scalar(f.sql,'select reserved_usd::float from provider_spend_reservations'),2.5);
 await f.sql.exec("update photo_takeoff_runs set lease_expires_at=now()-interval '1 second'");
 const blocked=await scalar(f.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[f.run.id,worker,f.seed.config.profileHash]);assert.equal(blocked.skip,true);
 assert.equal(await scalar(f.sql,'select error_code from photo_takeoff_runs'),'unknown_provider_outcome');
 }finally{await f.close();}
});

test('lost delivery recovers a completed checkpoint under a new fence without a second provider reservation',async()=>{
 const f=await fixture();try{const op=await reserve(f),sent=await dispatch(f,op);
 const waiting=await scalar(f.sql,'select recover_photo_bridge_run($1,$2)',[f.run.id,f.claim.lease_id]);assert.equal(waiting.status,'blocked');assert.equal(waiting.error_code,'bridge_delivery_pending');
 await settle(f,sent.dispatch_token);assert.equal(await scalar(f.sql,'select status from photo_takeoff_runs'),'queued');
 const claim=await scalar(f.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[f.run.id,worker,f.seed.config.profileHash]);assert.equal(claim.skip,false);
 const next=await scalar(f.sql,'select prepare_photo_bridge_operation($1,$2,$3,$4,$5,$6)',[f.run.id,claim.lease_id,worker,generation,`observation:${PHOTO}`,JSON.stringify(f.seed.config.complete)]);
 assert.equal(next.operation.id,op.id);assert.equal(next.operation.state,'completed');assert.equal(next.worker.fence,'2');
 await assert.rejects(read(f),/authority/);f.command.worker=next.worker;assert.equal((await read(f)).result_sha256,digest);
 assert.equal(await scalar(f.sql,'select begin_complete_photo_stage($1,$2,$3,$4)',[f.run.id,claim.lease_id,`observation:${PHOTO}`,op.event_id]),true);
 assert.equal(await scalar(f.sql,'select count(*)::integer from provider_spend_reservations'),1);
 }finally{await f.close();}
});
