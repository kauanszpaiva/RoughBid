import type { DocumentDb,DocumentObjectStorage } from '../documents/service.ts';
import { ProviderSpendLimitError,withUsageMeter } from '../owner-usage/meter.ts';
import { reviewPhotoEvidence,validatePhotoAssets,type PhotoSourceAsset } from '../photo-evidence.ts';
import { loadVerifiedPhoto,toPhotoSourceAsset } from './assets.ts';
import type { PhotoTakeoffProfile } from './config.ts';
import { photoHash,planCompletePhotoOperations, type PhotoOperation } from './complete-profile.ts';
import { parsePhotoReading,type PhotoReader,type PhotoReadingResult } from './provider.ts';
import { completeStageContext,parsePhotoStageReview,type PhotoStageReview,type PhotoStageResult } from './stages.ts';
import { photoSourceBlockers } from './coverage.ts';
import { enqueuePhotoRun,type PhotoTakeoffQueue } from './queue.ts';
import { PhotoBridgeRecoveryError,PhotoBridgeOutcomeUnknownError } from './bridge-state.ts';

export async function recoverCompletePhotoRuns(db:DocumentDb,queue:PhotoTakeoffQueue,profile:PhotoTakeoffProfile):Promise<number>{
  if(!profile.complete||!db.rpc)return 0;
  const found=await db.rpc('due_complete_photo_runs',{p_profile_hash:profile.profileHash});
  if(found.error||!Array.isArray(found.data))throw new Error('photo_recovery_unavailable');
  let count=0;for(const row of found.data){if(typeof row?.id!=='string')throw new Error('photo_recovery_invalid');await enqueuePhotoRun(queue,row.id);count++;}return count;
}
export async function processCompletePhoto(input:{db:DocumentDb;storage:DocumentObjectStorage;reader:PhotoReader;profile:PhotoTakeoffProfile;workerId:string;runId:string;fetcher:typeof fetch}):Promise<unknown>{
 const {db,storage,reader,profile,workerId,runId,fetcher}=input;
 const rpc=async(name:string,args:Record<string,unknown>):Promise<any>=>{if(!db.rpc)throw new Error('photo_persistence_unavailable');const result=await db.rpc(name,args);if(result.error)throw new Error('photo_persistence_operation_failed');return result.data;};
 if(!profile.complete||!reader.readStage)throw new Error('complete_photo_worker_unconfigured');
 const claim=await rpc('claim_complete_photo_takeoff',{p_run_id:runId,p_worker_id:workerId,p_profile_hash:profile.profileHash});if(claim.skip)return claim;
 const lease=claim.lease_id,scope={workspaceId:claim.workspace_id,projectId:claim.project_id};
 const controller=new AbortController();let beating=false,started=false;
 const heartbeat=async()=>{if(beating||controller.signal.aborted)return;beating=true;try{if(await rpc('heartbeat_complete_photo_takeoff',{p_run_id:runId,p_lease_id:lease,p_worker_id:workerId})!==true)controller.abort();}catch{controller.abort();}finally{beating=false;}};
 const timer=setInterval(()=>{void heartbeat();},20000);timer.unref?.();
 try{
  const assets=validatePhotoAssets(claim.manifest.assets,scope),operations=planCompletePhotoOperations(assets,profile.complete,claim.manifest.callReservationUsd);
  if(photoHash(operations)!==photoHash(claim.manifest.operations)||photoHash(profile.complete)!==photoHash(claim.manifest.profile))throw new Error('photo_manifest_profile_changed');
  const saved=await db.from('photo_stage_checkpoints').select('operation_key,stage,status,result').eq('run_id',runId);
  if(saved.error||!Array.isArray(saved.data))throw new Error('photo_checkpoints_unavailable');
  const results=new Map<string,PhotoStageResult>();
  for(const operation of operations){
   const checkpoint=saved.data.find((s:any)=>s.operation_key===operation.key);
   if(checkpoint?.status==='completed'){
    const context=completeStageContext(operation,results);
    const value=operation.stage==='observation'?parsePhotoReading(checkpoint.result,assets.find(a=>a.id===operation.assetIds[0])!,claim.manifest.references??[]):parsePhotoStageReview(checkpoint.result,operation,context);
    results.set(operation.key,value);continue;
   }
   await heartbeat();if(controller.signal.aborted)throw new Error('photo_lease_lost');
   const sources:Array<{asset:PhotoSourceAsset;bytes:Uint8Array}>=[];
   for(const id of operation.assetIds){const expected=assets.find(a=>a.id===id)!;
    const stored=await db.from('photo_assets').select('*').eq('id',id).eq('workspace_id',scope.workspaceId).eq('project_id',scope.projectId).eq('status','ready').maybeSingle();
    if(stored.error||!stored.data||photoHash(toPhotoSourceAsset(stored.data))!==photoHash(expected))throw new Error('photo_source_revision_changed');
    sources.push({asset:expected,bytes:await loadVerifiedPhoto(stored.data,storage,fetcher,true,controller.signal)});
   }
   const context=completeStageContext(operation,results);
   const writer={from:(table:string)=>db.from(table),rpc:async(name:string,args:Record<string,unknown>)=>{
    if(!db.rpc)throw new Error('photo_accounting_unavailable');
    if(name==='reserve_provider_spend'){
     const {p_job_id,...identity}=args;if(p_job_id!==runId)throw new Error('photo_accounting_identity_mismatch');
     const result=await db.rpc('reserve_complete_photo_spend',{...identity,p_run_id:runId,p_lease_id:lease,p_operation_key:operation.key});
     const raw=result.error&&typeof result.error==='object'&&'message'in result.error?String(result.error.message):'';
     return {data:result.data,error:result.error?{message:/Company AI spend limit reached/i.test(raw)?'Company AI spend limit reached':/Provider run spend limit reached/i.test(raw)?'Provider run spend limit reached':'Photo provider accounting unavailable'}:null};
    }
    const result=await db.rpc(name,args);return {data:result.data,error:result.error?{message:'Photo provider accounting unavailable'}:null};
   }};
   const raw=await withUsageMeter({writer,userId:claim.requested_by,...scope,jobId:runId,billing:'paid'},()=>reader.readStage!({operation,sources,context,references:claim.manifest.references??[],signal:controller.signal,execution:{runId,leaseId:lease},
    beforeDispatch:async(eventId)=>{if(await rpc('begin_complete_photo_stage',{p_run_id:runId,p_lease_id:lease,p_operation_key:operation.key,p_event_id:eventId})!==true)throw new Error('photo_admission_receipt_missing');started=true;}}));
   if(controller.signal.aborted)throw new Error('photo_lease_lost');
   const result=operation.stage==='observation'?parsePhotoReading(raw,sources[0]!.asset,claim.manifest.references??[]):parsePhotoStageReview(raw,operation,context);
   if(await rpc('checkpoint_complete_photo_stage',{p_run_id:runId,p_lease_id:lease,p_operation_key:operation.key,p_result:result})!==true)throw new Error('photo_checkpoint_failed');
   results.set(operation.key,result);started=false;
  }
  const observations=operations.filter(op=>op.stage==='observation').map(op=>results.get(op.key) as PhotoReadingResult);
  const reviews=operations.filter(op=>op.stage!=='observation').map(op=>results.get(op.key) as PhotoStageReview);
  const review=reviewPhotoEvidence({...scope,assets,observations:observations.flatMap(r=>r.observations),references:claim.manifest.references??[],decisions:[]});
  const modelBlockers=reviews.flatMap(r=>[...r.blockers,...r.checks.filter(c=>c.status!=='supported').map(c=>`${c.id}:${c.kind}_${c.status}`)]);
  const result={...review,independentReview:'completed',stageStatus:{observation:'completed',reconciliation:'completed',risk_review:'completed'},stageReviews:reviews,
   photoQuality:assets.map(asset=>({sourceAssetId:asset.id,...(results.get(`observation:${asset.id}`) as PhotoReadingResult).quality})),
   blockers:[...new Set([...review.blockers,...modelBlockers,...photoSourceBlockers(assets,assets.map(asset=>({photo_asset_id:asset.id,status:'completed',result:results.get(`observation:${asset.id}`)})))])],references:claim.manifest.references??[],decisions:[]};
  return await rpc('finish_complete_photo_takeoff',{p_run_id:runId,p_lease_id:lease,p_result:result});
 }catch(error){
  if(error instanceof PhotoBridgeRecoveryError&&!started)return rpc('recover_photo_bridge_run',{p_run_id:runId,p_lease_id:lease});
  if(error instanceof PhotoBridgeOutcomeUnknownError)started=true;
  if(error instanceof ProviderSpendLimitError&&error.scope==='company'&&error.eventId&&!started)return rpc('wait_complete_photo_budget',{p_run_id:runId,p_lease_id:lease,p_event_id:error.eventId});
  await rpc('block_complete_photo_takeoff',{p_run_id:runId,p_lease_id:lease,p_code:error instanceof ProviderSpendLimitError?'run_provider_spend_limit':started?'unknown_provider_outcome':'photo_source_or_persistence_blocked'}).catch(()=>{});
  throw new Error(started?'photo_run_reconciliation_required':'photo_processing_review_required');
 }finally{clearInterval(timer);controller.abort();}
}
