import test from 'node:test';
import assert from 'node:assert/strict';
import {completePhotoDatabase} from './helpers/complete-photo-db.mjs';
import {completePhotoEnvironment,seedCompletePhoto,payPhotoQuote,createPhotoQuote,scalar,syntheticPhotoObservation} from './helpers/complete-photo-fixture.mjs';
import {USER,WORKSPACE,PROJECT,PHOTO,PNG} from './helpers/photo-db.mjs';
import {requirePhotoTakeoffConfig} from '../src/photos/config.ts';
import {requireCompletePhotoProfile,planCompletePhotoOperations,photoHash,assertCompletePhotoPayload} from '../src/photos/complete-profile.ts';
import {buildPhotoPurchaseContract,photoCompleteManifest} from '../src/billing/photo-pricing.ts';
import {HttpPhotoReader} from '../src/photos/provider.ts';
import {processCompletePhoto,recoverCompletePhotoRuns} from '../src/photos/complete-worker.ts';
import {handlePhotoRequest} from '../src/photos/routes.ts';
import {openPhotoCheckout,reconcilePhotoPayment,ensurePaidPhotoRun,requirePhotoScheduling} from '../src/billing/photo-payments.ts';
import {ProjectPayments} from '../src/billing/project-payments.ts';
import {parsePhotoStageReview} from '../src/photos/stages.ts';

const request=(path:string,method='GET',body?:unknown)=>new Request(`https://local.invalid/api/projects/${PROJECT}/photos/${path}`,{method,headers:{'x-workspace-id':WORKSPACE,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
const storage={async presign(){return {url:'https://storage.invalid/synthetic'};}};
const noCalls:typeof fetch=async()=>{throw new Error('Unexpected network call');};
const context=(db:any,env:any)=>({db:db.client,env,fetcher:noCalls,userId:USER,workspaceId:WORKSPACE,projectId:PROJECT,ready:async()=>{}});
async function reserve(db:any,c:any){const q=await payPhotoQuote(db.sql,c),saved=await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[q.id]);return {q,run:saved.run};}

test('eight-photo decimal exposure and explicit overhead match PostgreSQL exactly',async()=>{
 const db=await completePhotoDatabase();try{
 const env={...completePhotoEnvironment(),PAID_PHOTO_MAXIMUM_RESERVE_USD:'1000',PAID_PHOTO_BATCH_OVERHEAD_CENTS:'300',PAID_PHOTO_ASSET_OVERHEAD_CENTS:'25'};
 const raw=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);raw.routes.observation.maximumCallCostUsd=5.346304;raw.routes.reconciliation.maximumCallCostUsd=24.52;raw.routes.risk_review.maximumCallCostUsd=5.474304;env.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(raw);
 const seeded=await seedCompletePhoto(db,env),assets=[seeded.asset];
 for(let i=1;i<8;i++){const id=`30000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,sha=String(i).repeat(64);
 await db.sql.query(`insert into photo_assets(id,workspace_id,project_id,uploaded_by,storage_path,original_name,mime_type,byte_size)
 select $1::uuid,workspace_id,project_id,uploaded_by,replace(storage_path,id::text,($1::uuid)::text),original_name,mime_type,byte_size from photo_assets where id=$2`,[id,PHOTO]);
 await db.sql.query("update photo_assets set status='ready',sha256=$1,width_pixels=1,height_pixels=1,completed_at=now()where id=$2",[sha,id]);
 assets.push({...seeded.asset,id,sha256:sha,revision:sha});}
 const c=buildPhotoPurchaseContract({assets,workspaceId:WORKSPACE,projectId:PROJECT,userId:USER,membership:'standard',env});
 assert.equal(c.maximumCalls,44);assert.equal(c.pricing.operatingReserveUsd,773.124864);assert.equal(c.providers[0].approvedUsd,773.124864);
 assert.equal(c.pricing.providerCostUpperBoundUsd,773.124864);assert.equal(c.pricing.costCents,77813);assert.equal(c.pricing.overheadBatchCents,300);assert.equal(c.pricing.overheadAssetCents,25);
 const q=await payPhotoQuote(db.sql,c),saved=await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[q.id]);
 assert.equal(Number(await scalar(db.sql,'select approved_usd from complete_photo_provider_budgets where run_id=$1',[saved.run.id])),773.124864);
 for(const key of ['PAID_PHOTO_ASSET_OVERHEAD_CENTS','PAID_PHOTO_BATCH_OVERHEAD_CENTS']){const missing={...env,[key]:undefined};assert.throws(()=>buildPhotoPurchaseContract({assets,workspaceId:WORKSPACE,projectId:PROJECT,userId:USER,membership:'standard',env:missing}));}
 const bad=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);bad.routes.observation.maximumCallCostUsd=5.3463041;assert.throws(()=>requireCompletePhotoProfile({...env,PHOTO_COMPLETE_PROFILE_JSON:JSON.stringify(bad)}));
 }finally{await db.close();}
});

test('included runs require a non-null explicit allowance and recover exact existing identity',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),manifest={...photoCompleteManifest(s.contract),includedAuthorization:{confirmed:true,approvedBy:USER,approvalRef:'synthetic-only',approvedUsd:110}};
 const p={user_id:USER,workspace_id:WORKSPACE,project_id:PROJECT,request_key:'80000000-0000-4000-8000-000000000001',manifest};
 for(const value of [null,undefined])await assert.rejects(scalar(db.sql,'select reserve_included_complete_photo($1)',[JSON.stringify({...p,manifest:{...manifest,includedAuthorization:{...manifest.includedAuthorization,approvedUsd:value}}})]),/approval|allowance|authorization|budget/i);
 const first=await scalar(db.sql,'select reserve_included_complete_photo($1)',[JSON.stringify(p)]);
 assert.equal((await scalar(db.sql,'select reserve_included_complete_photo($1)',[JSON.stringify(p)])).run.id,first.run.id);
 }finally{await db.close();}
});

test('complete profile stays closed without reviewed tariff and covers every view, pair, and risk pass',()=>{
 const env=completePhotoEnvironment(),profile=requireCompletePhotoProfile(env);
 assert.equal(profile.routes.observation.model,'gpt-6-astra');
 for(const mutate of [(e:any)=>delete e.PHOTO_COMPLETE_PROFILE_JSON,(e:any)=>{e.PHOTO_COMPLETE_ENABLED='false'},(e:any)=>{const p=JSON.parse(e.PHOTO_COMPLETE_PROFILE_JSON);p.routes.risk_review.tariff.expiresAt='2000-01-01';e.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(p)},(e:any)=>{const p=JSON.parse(e.PHOTO_COMPLETE_PROFILE_JSON);p.routes.risk_review.maximumCallCostUsd=.00001;e.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(p)}]){
 const changed={...env};mutate(changed);assert.throws(()=>requireCompletePhotoProfile(changed));}
 for(let n=1;n<=8;n++){const assets=Array.from({length:n},(_,i)=>({id:`asset-${i}`})) as any;const ops=planCompletePhotoOperations(assets);
 assert.equal(ops.length,2*n+Math.max(1,n*(n-1)/2));assert.equal(new Set(ops.map(o=>o.key)).size,ops.length);assert.equal(ops.filter(o=>o.stage==='risk_review').length,n);}
});

test('reconciliation requires exact source and observation coverage; uncertain evidence never becomes a measurement',()=>{
 const operation={key:'reconciliation:a:b',stage:'reconciliation' as const,assetIds:['a','b']},context={observations:[{id:'a:wall'},{id:'b:wall'}] as any,priorReviews:[]};
 const raw={stage:operation.stage,assetIds:['a','b'],coveredObservationIds:['a:wall','b:wall'],checks:[{id:operation.key+':identity',observationIds:['a:wall','b:wall'],kind:'duplication',status:'uncertain',note:'Physical identity remains unverified.'}],blockers:['identity_review_required']};
 assert.equal(parsePhotoStageReview(raw,operation,context).checks[0]?.status,'uncertain');
 assert.throws(()=>parsePhotoStageReview({...raw,coveredObservationIds:['a:wall']},operation,context));assert.throws(()=>parsePhotoStageReview({...raw,assetIds:['a','other']},operation,context));
 assert.throws(()=>parsePhotoStageReview({...raw,checks:[]},operation,context));
});

test('paid SQL quote applies one fee, immutable scope, explicit consent, paid-only idempotent run and service-only writes',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db);
 const q=await createPhotoQuote(db.sql,s.contract);assert.equal(q.amount_cents,s.contract.pricing.amountCents);
 await assert.rejects(scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[q.id]),/authorization/);
 await assert.rejects(scalar(db.sql,'select save_photo_reading_session($1,$2)',[q.id,'cs_x']),/session/);
 await assert.rejects(createPhotoQuote(db.sql,{...s.contract,pricing:{...s.contract.pricing,amountCents:1}}),/amount/);
 const paid=await payPhotoQuote(db.sql,s.contract),r=await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[paid.id]);
 assert.equal(r.run.progress.totalStages,3);assert.equal((await scalar(db.sql,'select reserve_paid_photo_takeoff($1)',[paid.id])).run.id,r.run.id);
 assert.equal(await scalar(db.sql,'select count(*)::integer from photo_takeoff_runs'),1);
 await assert.rejects(db.sql.query('update photo_takeoff_runs set manifest=$1 where id=$2',[JSON.stringify({...r.run.manifest,maximumCalls:1}),r.run.id]),/immutable/);
 assert.equal(await scalar(db.sql,"select has_function_privilege('authenticated','public.reserve_paid_photo_takeoff(uuid)','execute')"),false);
 assert.equal(await scalar(db.sql,"select has_table_privilege('service_role','photo_reading_quotes','update')"),false);
 }finally{await db.close();}
});

test('quote and paid callbacks cannot charge duplicate content, bypass mode/amount, or resurrect refunded work',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),{q,run}=await reserve(db,s.contract);
 const changed={...s.contract,pricing:{...s.contract.pricing,version:'new-synthetic'}};
 await assert.rejects(createPhotoQuote(db.sql,changed),/already belongs/);
 await assert.rejects(scalar(db.sql,'select confirm_photo_reading_payment($1,$2,$3,$4,$5,$6,true)',['evt_wrong',q.id,'cs_synthetic','pi_synthetic',1,'usd']),/mismatch/);
 await scalar(db.sql,'select close_photo_reading_payment($1,$2,$3,$4,true,$5)',['evt_refund',q.id,'cs_synthetic','pi_synthetic','refund']);
 assert.equal(await scalar(db.sql,'select status from photo_takeoff_runs where id=$1',[run.id]),'cancelled');
 assert.equal((await scalar(db.sql,'select confirm_photo_reading_payment($1,$2,$3,$4,$5,$6,true)',['evt_late',q.id,'cs_synthetic','pi_synthetic',q.amount_cents,'usd'])).status,'revoked');
 await assert.rejects(scalar(db.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[run.id,'worker',s.config.profileHash]),/authorization/);
 assert.equal(await scalar(db.sql,'select count(*)::integer from provider_spend_reservations'),0);
 }finally{await db.close();}
});

test('complete synthetic worker persists all three stages before reporting processing complete, never physical zero',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),{run}=await reserve(db,s.contract);let calls=0;
 const fetcher:typeof fetch=async(url,init)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});
 assert.equal(String(url),'https://api.openai.com/v1/responses');calls++;
 const processing=await scalar(db.sql,"select count(*)::integer from photo_stage_checkpoints where run_id=$1 and status='processing'",[run.id]);assert.equal(processing,1);
 const admitted=await scalar(db.sql,'select count(*)::integer from provider_spend_reservations where photo_run_id=$1',[run.id]);assert.equal(admitted,calls);
 const body=JSON.parse(String(init?.body));let value:any;
 assert.deepEqual(body.prompt_cache_options,{mode:'explicit'});assert.equal(body.service_tier,'default');assert.equal(body.max_output_tokens,64000);assert.equal(body.reasoning.effort,'max');assert.equal(body.tools,undefined);
 if(calls===1)value=syntheticPhotoObservation(PHOTO);else {const stage=calls===2?'reconciliation':'risk_review';value={stage,assetIds:[PHOTO],coveredObservationIds:[PHOTO+':wall'],checks:[{id:stage+':'+PHOTO+':check',observationIds:[PHOTO+':wall'],kind:'quantity',status:'uncertain',note:'A verified dimension is required.'}],blockers:['dimension_required']};}
 assert.equal(body.input[0].content.filter((x:any)=>x.type==='input_image').length,1);
 return Response.json({id:'synthetic-'+calls,status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:100,output_tokens:100}});};
 const result=await processCompletePhoto({db:db.client,storage,profile:s.config,reader:new HttpPhotoReader(s.config,fetcher),fetcher,workerId:'synthetic-worker',runId:run.id});
 assert.equal((result as any).status,'needs_review');assert.equal(calls,3);
 assert.equal(await scalar(db.sql,"select count(*)::integer from provider_spend_reservations where telemetry_known and status='captured'and estimated_cost_usd=0.00002"),3);
 assert.equal(await scalar(db.sql,'select count(*)::integer from provider_spend_reservations'),3);
 assert.equal(await scalar(db.sql,'select count(*)::integer from api_usage_events where actual_cost_usd is not null'),0); // Token estimate is not an invoice cost.
 const deps={writer:db.client,storage,config:s.config,env:s.env,queue:{add:async()=>{throw Error('GET queued work')}}};
 const response=await handlePhotoRequest(request('runs/'+run.id),db.client,deps);assert.equal(response.status,200);const detail=await response.json();
 assert.equal(detail.coverage.processingComplete,true);assert.equal(detail.coverage.completeTakeoffVerified,false);assert.equal(detail.run.result.estimate,null);
 assert.equal(detail.stageCheckpoints.length,3);assert.ok(detail.stageCheckpoints.every((x:any)=>x.status==='completed'&&!('event_id'in x)));
 assert.deepEqual(detail.run.result.approvedMeasurements,[]);assert.ok(detail.coverage.referenceRequiredObservationIds.includes(PHOTO+':wall'));
 assert.equal(await recoverCompletePhotoRuns(db.client,deps.queue,s.config),0);
 const reviewInput={expectedReviewRevision:0,reviewRequestKey:crypto.randomUUID(),references:[],decisions:[]};
 const reviewed=await handlePhotoRequest(request('runs/'+run.id+'/review','POST',reviewInput),db.client,deps);assert.equal(reviewed.status,200);
 const reviewResult=await reviewed.json();assert.equal(reviewResult.review.independentReview,'completed');assert.equal(reviewResult.review.estimate,null);
 assert.ok(reviewResult.review.blockers.includes('dimension_required'));assert.equal(reviewResult.reviewRevision,1);
 const replay=await handlePhotoRequest(request('runs/'+run.id+'/review','POST',reviewInput),db.client,deps);assert.equal((await replay.json()).reused,true);
 }finally{await db.close();}
});

test('Astra combined-context tariff supports unchanged 64k output with explicit cache disabled and a 24.52 operation hold',()=>{
 const env=completePhotoEnvironment(),raw=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);
 for(const route of Object.values(raw.routes)as any[]){route.maximumCallCostUsd=24.52;Object.assign(route.tariff,{inputTokenLimit:1050000,outputTokenLimit:64000,combinedContextTokenLimit:1050000,inputUsdPerMillion:20,outputUsdPerMillion:75});}
 env.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(raw);const profile=requireCompletePhotoProfile(env);
 assert.equal(profile.routes.observation.maximumCallCostUsd,24.52);assert.equal(profile.routes.observation.maxOutputTokens,64000);
 raw.routes.observation.maximumCallCostUsd=24.51;assert.throws(()=>requireCompletePhotoProfile({...env,PHOTO_COMPLETE_PROFILE_JSON:JSON.stringify(raw)}));
 const image={id:PHOTO,widthPixels:8000,heightPixels:8000,byteSize:10000}as any;
 assert.throws(()=>assertCompletePhotoPayload(profile,[image],planCompletePhotoOperations([image])),/selected detail/);
});

test('company capacity waits before beginning; restored capacity resumes without replaying completed work',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),{run}=await reserve(db,s.contract);
 await db.sql.query('insert into geometry_provider_spend_reservations(reserved_usd)values(25)');let calls=0;
 const fetcher:typeof fetch=async(url)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});calls++;throw Error('No dispatch permitted');};
 const result=await processCompletePhoto({db:db.client,storage,profile:s.config,reader:new HttpPhotoReader(s.config,fetcher),fetcher,workerId:'synthetic-worker',runId:run.id});
 assert.equal((result as any).status,'waiting_budget');assert.equal(calls,0);
 assert.equal(await scalar(db.sql,"select count(*)::integer from photo_stage_checkpoints where status<>'pending'"),0);
 assert.equal(await scalar(db.sql,'select count(*)::integer from provider_spend_reservations'),0);
 assert.ok((result as any).not_before);assert.equal(await recoverCompletePhotoRuns(db.client,{add:async()=>{throw Error('Premature wake')}},s.config),0);
 await db.sql.exec("update geometry_provider_spend_reservations set created_at=now()-interval '25 hours';update photo_takeoff_runs set not_before=now()-interval '1 second'");
 let queued=0;assert.equal(await recoverCompletePhotoRuns(db.client,{add:async()=>{queued++;}},s.config),1);assert.equal(queued,1);
 }finally{await db.close();}
});

test('uncertain provider outcome remains blocked with its reservation and cannot be resumed',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),{run}=await reserve(db,s.contract);let calls=0;
 const fetcher:typeof fetch=async(url)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});calls++;throw Error('Synthetic lost response');};
 await assert.rejects(processCompletePhoto({db:db.client,storage,profile:s.config,reader:new HttpPhotoReader(s.config,fetcher),fetcher,workerId:'synthetic-worker',runId:run.id}),/reconciliation_required/);
 assert.equal(calls,1);assert.equal(await scalar(db.sql,'select error_code from photo_takeoff_runs where id=$1',[run.id]),'unknown_provider_outcome');
 assert.equal(await scalar(db.sql,'select sum(reserved_usd)::float from provider_spend_reservations'),2.5);
 await assert.rejects(scalar(db.sql,'select resume_complete_photo_takeoff($1,$2,$3,$4)',[run.id,WORKSPACE,USER,s.config.profileHash]),/reconciliation/);
 assert.equal(await recoverCompletePhotoRuns(db.client,{add:async()=>{throw Error('Replay')}},s.config),0);
 }finally{await db.close();}
});

test('short checkout window fails before any consent mutation or Stripe call; mismatched accounts never POST',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),q=await createPhotoQuote(db.sql,s.contract);
 await db.sql.query("update photo_reading_quotes set expires_at=now()+interval '15 minutes'where id=$1",[q.id]);
 await assert.rejects(openPhotoCheckout({...context(db,s.env),quoteId:q.id,consent:{confirmed:true,contract_hash:q.contract_hash}}),/Refresh/);
 assert.equal(await scalar(db.sql,'select consent from photo_reading_quotes where id=$1',[q.id]),null);
 await db.sql.query("update photo_reading_quotes set expires_at=now()+interval '1 hour'where id=$1",[q.id]);let calls=0;
 await assert.rejects(openPhotoCheckout({...context(db,s.env),quoteId:q.id,consent:{confirmed:true,contract_hash:q.contract_hash},fetcher:async(url,init)=>{calls++;assert.equal(url,'https://api.stripe.com/v1/account');assert.notEqual(init?.method,'POST');return Response.json({id:'acct_other',charges_enabled:true});}}),/application/);
 assert.equal(calls,1);assert.equal(await scalar(db.sql,'select consent from photo_reading_quotes where id=$1',[q.id]),null);
 }finally{await db.close();}
});

test('nonowner may upload/purchase complete photos but cannot bypass payment through included run',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db);await db.sql.query('update profiles set is_platform_admin=false');
 const deps={writer:db.client,storage,config:s.config,env:s.env,queue:{add:async()=>{throw Error('Unpaid enqueue')}}};
 const capability=await(await handlePhotoRequest(request('capability'),db.client,deps)).json();assert.equal(capability.includedAvailable,false);assert.equal(capability.purchaseAvailable,true);
 const response=await handlePhotoRequest(request('runs','POST',{assetIds:[PHOTO],requestKey:crypto.randomUUID(),consentConfirmed:true}),db.client,deps);assert.equal(response.status,403);
 const quote=await handlePhotoRequest(request('quote','POST',{assetIds:[PHOTO]}),db.client,deps);assert.equal(quote.status,201);const saved=await quote.json();assert.equal(saved.quote.consent_confirmed,false);
 const history=await handlePhotoRequest(request('quote'),db.client,deps);assert.equal(history.status,200);assert.equal((await history.json()).quote.id,saved.quote.id);
 assert.equal(await scalar(db.sql,'select count(*)::integer from photo_takeoff_runs'),0);
 }finally{await db.close();}
});

test('each stage reserves its verified upper bound above the unchanged base and never exceeds shared daily capacity',async()=>{
 const db=await completePhotoDatabase();try{const env=completePhotoEnvironment(),raw=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);
 raw.routes.observation.maximumCallCostUsd=6;raw.routes.reconciliation.maximumCallCostUsd=1;raw.routes.risk_review.maximumCallCostUsd=8;
 env.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(raw);const s=await seedCompletePhoto(db,env),{run}=await reserve(db,s.contract);
 assert.equal(s.contract.pricing.callReservationUsd,2.5);assert.deepEqual(s.contract.operations.map((o:any)=>o.reservationUsd),[6,2.5,8]);
 assert.equal(s.contract.providers[0].approvedUsd,16.5);assert.equal(s.contract.pricing.operatingReserveUsd,16.5);
 await db.sql.exec('insert into geometry_provider_spend_reservations(reserved_usd)values(20)');let calls=0;
 const fetcher:typeof fetch=async(url)=>{if(String(url).startsWith('https://storage.invalid'))return new Response(PNG,{headers:{'content-type':'image/png'}});calls++;throw Error('Synthetic unknown response');};
 let result=await processCompletePhoto({db:db.client,storage,profile:s.config,reader:new HttpPhotoReader(s.config,fetcher),fetcher,workerId:'worker',runId:run.id});
 assert.equal((result as any).status,'waiting_budget');assert.equal(calls,0);
 await db.sql.exec("update geometry_provider_spend_reservations set created_at=now()-interval '25 hours';update photo_takeoff_runs set not_before=now()-interval '1 second'");
 await assert.rejects(processCompletePhoto({db:db.client,storage,profile:s.config,reader:new HttpPhotoReader(s.config,fetcher),fetcher,workerId:'worker',runId:run.id}),/reconciliation/);
 assert.equal(calls,1);assert.equal(await scalar(db.sql,'select reserved_usd::float from provider_spend_reservations'),6);
 assert.equal(await scalar(db.sql,'select spend_cap_usd::float from provider_spend_policy'),25);assert.equal(await scalar(db.sql,'select call_reservation_usd::float from provider_spend_policy'),2.5);
 }finally{await db.close();}
});

test('shared signed-paid reconciliation autoqueues the unique photo run and retries lost enqueue without a second run',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db);let q=await createPhotoQuote(db.sql,s.contract);
 q=await scalar(db.sql,'select accept_photo_reading_quote($1,$2,$3,$4,$5)',[q.id,USER,WORKSPACE,PROJECT,q.contract_hash]);
 q=await scalar(db.sql,'select save_photo_reading_session($1,$2)',[q.id,'cs_photo']);let enqueues=0,starts=0;
 const payments=new ProjectPayments(db.client,s.env,noCalls,async()=>{},async()=>{throw Error('Photo webhook routed to PDF')},async(id)=>{starts++;
 await ensurePaidPhotoRun(db.client,{add:async()=>{if(++enqueues===1)throw Error('Synthetic queue acknowledgement lost');}},s.config,s.env,id);});
 const object={id:'cs_photo',livemode:true,mode:'payment',payment_status:'paid',amount_total:q.amount_cents,currency:'usd',payment_intent:'pi_photo',client_reference_id:USER,
 metadata:{roughbid_mode:'photo_batch',roughbid_photo_quote_id:q.id,roughbid_contract_hash:q.contract_hash,workspace_id:WORKSPACE,project_id:PROJECT}};
 const event={id:'evt_photo_paid',type:'checkout.session.completed',livemode:true,data:{object}};
 await payments.reconcile({...event,livemode:false}as any);assert.equal(starts,0);
 await assert.rejects(payments.reconcile({...event,data:{object:{...object,amount_total:1}}}as any),/amount/);assert.equal(starts,0);
 await assert.rejects(payments.reconcile(event as any),/acknowledgement/);assert.equal(await scalar(db.sql,'select count(*)::integer from photo_takeoff_runs'),1);
 await payments.reconcile(event as any);assert.equal(starts,2);assert.equal(enqueues,2);assert.equal(await scalar(db.sql,'select count(*)::integer from photo_takeoff_runs'),1);
 await payments.reconcile({id:'evt_photo_refund',type:'charge.refunded',livemode:true,data:{object:{payment_intent:'pi_photo',amount_refunded:1}}}as any);
 await payments.reconcile(event as any);assert.equal(starts,2);assert.equal(await scalar(db.sql,'select status from photo_reading_quotes where id=$1',[q.id]),'revoked');
 }finally{await db.close();}
});

test('early dispute binds an authenticated charge before paid event; unrelated products and Connect events are ignored',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db);let q=await createPhotoQuote(db.sql,s.contract);
 await scalar(db.sql,'select accept_photo_reading_quote($1,$2,$3,$4,$5)',[q.id,USER,WORKSPACE,PROJECT,q.contract_hash]);
 await scalar(db.sql,'select save_photo_reading_session($1,$2)',[q.id,'cs_early']);let reads=0;
 const gateway={env:s.env,fetcher:async(url:any,init:any)=>{reads++;assert.equal(url,'https://api.stripe.com/v1/charges/ch_early');assert.notEqual(init?.method,'POST');return Response.json({id:'ch_early',livemode:true,payment_intent:'pi_early',metadata:{roughbid_mode:'photo_batch',roughbid_photo_quote_id:q.id,roughbid_contract_hash:q.contract_hash}});}};
 const event={id:'evt_early_dispute',type:'charge.dispute.created',livemode:true,data:{object:{charge:'ch_early',payment_intent:'pi_early'}}};
 assert.equal(await reconcilePhotoPayment(db.client,{...event,account:'acct_other'}as any,async()=>{throw Error('dispatch')},gateway),false);assert.equal(reads,0);
 assert.equal(await reconcilePhotoPayment(db.client,event as any,async()=>{throw Error('dispatch')},gateway),true);assert.equal(reads,1);
 const paid=await scalar(db.sql,'select confirm_photo_reading_payment($1,$2,$3,$4,$5,$6,true)',['evt_late_paid',q.id,'cs_early','pi_early',q.amount_cents,'usd']);assert.equal(paid.status,'revoked');
 assert.equal(await reconcilePhotoPayment(db.client,{id:'evt_other',type:'checkout.session.completed',livemode:true,data:{object:{metadata:{product:'other'}}}}as any,async()=>{throw Error('dispatch')}),false);
 }finally{await db.close();}
});

test('conservative variable scheduling rejects a tariff that expires before the complete photo sequence fits',async()=>{
 const db=await completePhotoDatabase();try{const env=completePhotoEnvironment(),raw=JSON.parse(env.PHOTO_COMPLETE_PROFILE_JSON);
 for(const r of Object.values(raw.routes)as any[]){r.maximumCallCostUsd=24.52;Object.assign(r.tariff,{inputTokenLimit:1050000,outputTokenLimit:64000,combinedContextTokenLimit:1050000,inputUsdPerMillion:20,outputUsdPerMillion:75,expiresAt:new Date(Date.now()+86400000).toISOString()});}
 env.PHOTO_COMPLETE_PROFILE_JSON=JSON.stringify(raw);const s=await seedCompletePhoto(db,env);
 await assert.rejects(createPhotoQuote(db.sql,s.contract),/validity/);assert.equal(await scalar(db.sql,'select count(*)::integer from photo_reading_quotes'),0);
 assert.equal(await scalar(db.sql,'select count(*)::integer from provider_spend_reservations'),0);
 }finally{await db.close();}
});

test('expired pre-dispatch leases recover only the saved run; admitted unknown operations cannot replay',async()=>{
 const db=await completePhotoDatabase();try{const s=await seedCompletePhoto(db),{run}=await reserve(db,s.contract);
 await scalar(db.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[run.id,'synthetic-worker',s.config.profileHash]);
 await db.sql.exec("update photo_takeoff_runs set lease_expires_at=now()-interval '1 second'");let queued=0;
 assert.equal(await recoverCompletePhotoRuns(db.client,{add:async()=>{queued++;}},s.config),1);assert.equal(queued,1);
 const claim=await scalar(db.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[run.id,'recovered-worker',s.config.profileHash]);assert.equal(claim.skip,false);
 await db.sql.exec("update photo_takeoff_runs set lease_expires_at=now()-interval '1 second';update photo_stage_checkpoints set status='admitted'where stage='observation'");
 const blocked=await scalar(db.sql,'select claim_complete_photo_takeoff($1,$2,$3)',[run.id,'recovered-worker',s.config.profileHash]);assert.equal(blocked.skip,true);
 assert.equal(await scalar(db.sql,'select error_code from photo_takeoff_runs where id=$1',[run.id]),'unknown_provider_outcome');
 }finally{await db.close();}
});
