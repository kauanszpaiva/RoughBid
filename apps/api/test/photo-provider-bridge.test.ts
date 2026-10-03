import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// @ts-expect-error Embedded PostgreSQL fixture is an existing JavaScript helper.
import {completePhotoDatabase} from './helpers/complete-photo-db.mjs';
// @ts-expect-error Embedded PostgreSQL fixture is an existing JavaScript helper.
import {completePhotoEnvironment,seedCompletePhoto,payPhotoQuote,scalar,syntheticPhotoObservation} from './helpers/complete-photo-fixture.mjs';
// @ts-expect-error Embedded PostgreSQL fixture is an existing JavaScript helper.
import {PHOTO,PNG} from './helpers/photo-db.mjs';
import {requirePhotoBridgeConfig} from '../src/provider-bridge/photo-config.ts';
import {PhotoBridgeReader} from '../src/provider-bridge/photo-client.ts';
import {routeProviderBridge} from '../src/provider-bridge/router.ts';
import {processCompletePhoto} from '../src/photos/complete-worker.ts';
import type {DocumentObjectStorage} from '../src/documents/service.ts';

async function fixture(){
 const db=await completePhotoDatabase();
 try{
  for(const name of ['20261003040000_provider_execution_bridge.sql','20261003060000_reviewed_operation_reservations.sql','20261003070000_photo_execution_bridge.sql'])
   await db.sql.exec(readFileSync(new URL(`../../../supabase/migrations/${name}`,import.meta.url),'utf8'));
  const env={...completePhotoEnvironment(),PHOTO_TAKEOFF_TRANSPORT:'bridge',PROVIDER_BRIDGE_ENABLED:'true',
   PROVIDER_BRIDGE_URL:'https://roughbid.test/api/internal/provider-bridge/v1',PROVIDER_BRIDGE_AUTH_CONTEXT:'synthetic-project/production',SUPABASE_SERVICE_ROLE_KEY:'synthetic-offline-service-secret'};
  const seeded=await seedCompletePhoto(db,env),paid=await payPhotoQuote(db.sql,seeded.contract);
  const {run}=await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[paid.id]);
  const workerConfig=requirePhotoBridgeConfig({...env,OPENAI_API_KEY:undefined},'worker'),workerId=crypto.randomUUID(),generation=crypto.randomUUID();
  const storage:DocumentObjectStorage={async presign(){return{url:'https://storage.invalid/synthetic',method:'GET',headers:{},expiresAt:new Date(Date.now()+300_000).toISOString()};}};
  return{db,env,seeded,run,workerConfig,workerId,generation,storage};
 }catch(error){await db.close();throw error;}
}

test('photo bridge uses real SQL authority and one ledger for all stages; lost HTTP result recovers without a second emission',async()=>{
 const f=await fixture();try{let calls=0,lost=false;const submitted:string[]=[];
  const fetcher:typeof fetch=async(url,init)=>{
   if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});
   assert.equal(String(url),'https://api.openai.com/v1/responses');calls++;
   assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_bridge_operations where state='dispatching'"),1);
   assert.equal(await scalar(f.db.sql,'select count(*)::integer from provider_spend_reservations where photo_run_id=$1',[f.run.id]),calls);
   // The operation CAS is the dispatch checkpoint; application stages attach only after durable result save.
   assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_stage_checkpoints where status='processing'"),0);
   const body=JSON.parse(String(init?.body));assert.equal(body.service_tier,'default');assert.deepEqual(body.prompt_cache_options,{mode:'explicit'});assert.equal(body.max_output_tokens,64000);
   const stage=calls===1?'observation':calls===2?'reconciliation':'risk_review';
   const value=stage==='observation'?syntheticPhotoObservation(PHOTO):{stage,assetIds:[PHOTO],coveredObservationIds:[PHOTO+':wall'],checks:[{id:stage+':'+PHOTO+':check',observationIds:[PHOTO+':wall'],kind:'quantity',status:'uncertain',note:'Physical scale is not established.'}],blockers:['dimension_required']};
   return Response.json({id:'offline-response-'+calls,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:100,output_tokens:100}});
  };
  const transport:typeof fetch=async(url,init)=>{
   const body=String(init?.body);submitted.push(body);assert.doesNotMatch(body,/synthetic-offline-service-secret|local-synthetic|data:image|prompt|model|assetIds/);
   const response=await routeProviderBridge(new Request(String(url),init),{db:f.db.client,storage:f.storage,env:f.env,fetcher});
   if(JSON.parse(body).action==='submit_stage'&&!lost){lost=true;assert.equal(response.status,200);throw new Error('Synthetic HTTP acknowledgement lost');}
   return response;
  };
  const reader=new PhotoBridgeReader(f.db.client,f.workerConfig,f.workerId,f.generation,transport);await reader.handshake();assert.equal(calls,0);
  const result=await processCompletePhoto({db:f.db.client,storage:f.storage,profile:f.workerConfig.profile,reader,fetcher,workerId:f.workerId,runId:f.run.id}).catch(async()=>{
   assert.fail(JSON.stringify({calls,ops:(await f.db.sql.query('select operation_key,state,error_code from photo_bridge_operations')).rows,
    checkpoints:(await f.db.sql.query('select operation_key,status from photo_stage_checkpoints')).rows}));});
  assert.equal((result as any).status,'needs_review');assert.equal(calls,3);assert.equal(lost,true);
  assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_bridge_operations where state='completed'and cost_state='captured'"),3);
  assert.equal(await scalar(f.db.sql,'select count(*)::integer from api_usage_events where estimated_cost_usd>0 and actual_cost_usd is null'),3);
  assert.equal(await scalar(f.db.sql,'select count(*)::integer from provider_spend_reservations'),3);
  assert.equal(await scalar(f.db.sql,'select count(*)::integer from api_usage_events'),3);
  assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_stage_checkpoints where status='completed'"),3);
  assert.equal(await scalar(f.db.sql,'select count(*)::integer from provider_bridge_operations'),0);
  assert.equal(await scalar(f.db.sql,'select sum(reserved_usd)::float from provider_spend_reservations'),7.5);
  assert.equal(await scalar(f.db.sql,'select spend_cap_usd::float from provider_spend_policy'),25);
 }finally{await f.db.close();}
});

test('photo bridge company denial persists waiting without dispatch, false processing checkpoint, or local provider key',async()=>{
 const f=await fixture();try{
  await f.db.sql.exec('insert into geometry_provider_spend_reservations(reserved_usd)values(25)');let calls=0;
  const fetcher:typeof fetch=async(url)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});calls++;throw Error('No provider permitted');};
  const transport:typeof fetch=async(url,init)=>routeProviderBridge(new Request(String(url),init),{db:f.db.client,storage:f.storage,env:f.env,fetcher});
  const reader=new PhotoBridgeReader(f.db.client,f.workerConfig,f.workerId,f.generation,transport);await reader.handshake();
  const result=await processCompletePhoto({db:f.db.client,storage:f.storage,profile:f.workerConfig.profile,reader,fetcher,workerId:f.workerId,runId:f.run.id});
  assert.equal((result as any).status,'waiting_budget');assert.equal(calls,0);
  assert.equal(await scalar(f.db.sql,'select count(*)::integer from provider_spend_reservations'),0);
  assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_stage_checkpoints where status<>'pending'"),0);
 }finally{await f.db.close();}
});

test('uncertain photo provider outcome blocks the run and keeps its one reservation without replay',async()=>{
 const f=await fixture();try{let calls=0;
  const fetcher:typeof fetch=async(url)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});calls++;throw Error('Synthetic lost provider outcome');};
  const transport:typeof fetch=async(url,init)=>routeProviderBridge(new Request(String(url),init),{db:f.db.client,storage:f.storage,env:f.env,fetcher});
  const reader=new PhotoBridgeReader(f.db.client,f.workerConfig,f.workerId,f.generation,transport);await reader.handshake();
  const input={db:f.db.client,storage:f.storage,profile:f.workerConfig.profile,reader,fetcher,workerId:f.workerId,runId:f.run.id};
  await assert.rejects(()=>processCompletePhoto(input),/photo_run_reconciliation_required/);
  assert.equal(calls,1);assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_bridge_operations where state='dispatch_unknown'and cost_state='held_unknown'"),1);
  assert.equal(await scalar(f.db.sql,"select status from photo_takeoff_runs where id=$1",[f.run.id]),'blocked');
  await processCompletePhoto(input).catch(()=>{});
  assert.equal(calls,1);assert.equal(await scalar(f.db.sql,'select count(*)::integer from provider_spend_reservations'),1);
  assert.equal(await scalar(f.db.sql,'select reserved_usd::float from provider_spend_reservations'),2.5);
  assert.equal(await scalar(f.db.sql,"select count(*)::integer from photo_stage_checkpoints where status='completed'"),0);
 }finally{await f.db.close();}
});
