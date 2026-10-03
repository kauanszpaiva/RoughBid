import type { DocumentDb, DocumentObjectStorage } from '../documents/service.ts';
import { ProviderSpendLimitError, withUsageMeter } from '../owner-usage/meter.ts';
import { reviewPhotoEvidence, validatePhotoAssets, type PhotoDimensionReference } from '../photo-evidence.ts';
import { loadVerifiedPhoto, toPhotoSourceAsset, type PhotoAssetRow } from './assets.ts';
import { PHOTO_TAKEOFF_VERSION, type PhotoTakeoffProfile } from './config.ts';
import type { PhotoReader, PhotoReadingResult } from './provider.ts';
import type { PhotoTakeoffJob } from './queue.ts';

export interface PhotoWorkerJob { data: PhotoTakeoffJob }
/** Durable image checkpoints. No overall reading deadline and no automatic paid retry. */
export class PhotoTakeoffProcessor {
  private readonly db:DocumentDb;
  private readonly storage:DocumentObjectStorage;
  private readonly reader:PhotoReader;
  private readonly profile:PhotoTakeoffProfile;
  private readonly workerId:string;
  private readonly fetcher:typeof fetch;
  constructor(db:DocumentDb,storage:DocumentObjectStorage,reader:PhotoReader,profile:PhotoTakeoffProfile,workerId:string,fetcher:typeof fetch=fetch) {
    this.db=db;this.storage=storage;this.reader=reader;this.profile=profile;this.workerId=workerId;this.fetcher=fetcher;
  }
  private async rpc(name:string,args:Record<string,unknown>):Promise<any> {
    if (!this.db.rpc) throw new Error('photo_persistence_unavailable');
    const result=await this.db.rpc(name,args);
    if (result.error) throw new Error('photo_persistence_operation_failed');
    return result.data;
  }
  async touch():Promise<void> {
    if (await this.rpc('touch_photo_takeoff_worker',{p_worker_id:this.workerId,p_profile_hash:this.profile.profileHash,p_version:PHOTO_TAKEOFF_VERSION})!==true) {
      throw new Error('photo_worker_capability_unavailable');
    }
  }
  async process(job:PhotoWorkerJob):Promise<unknown> {
    if (job.data.version!==PHOTO_TAKEOFF_VERSION) throw new Error('photo_job_version_invalid');
    const claim=await this.rpc('claim_photo_takeoff',{p_run_id:job.data.runId,p_worker_id:this.workerId,p_profile_hash:this.profile.profileHash});
    if (claim.skip) return claim;
    const runId=job.data.runId,leaseId=claim.lease_id;
    const scope={workspaceId:claim.workspace_id,projectId:claim.project_id};
    const assets=validatePhotoAssets(claim.manifest.assets,scope);
    const references:readonly PhotoDimensionReference[]=claim.manifest.references??[];
    const controller=new AbortController(); let heartbeatBusy=false;
    const heartbeat=async()=>{
      if (heartbeatBusy || controller.signal.aborted) return;
      heartbeatBusy=true;
      try {
        if (await this.rpc('heartbeat_photo_takeoff',{p_run_id:runId,p_lease_id:leaseId,p_worker_id:this.workerId})!==true) controller.abort();
      } catch {controller.abort();} finally {heartbeatBusy=false;}
    };
    const timer=setInterval(()=>{void heartbeat();},20_000);timer.unref?.();
    let providerStarted=false;
    try {
      const saved=await this.db.from('photo_takeoff_steps').select('photo_asset_id,status,result').eq('workspace_id',scope.workspaceId).eq('project_id',scope.projectId).eq('run_id',runId);
      if (saved.error || !Array.isArray(saved.data)) throw new Error('photo_persistence_unavailable');
      const checkpoints=new Map<string,PhotoReadingResult>(saved.data.filter((step:any)=>step.status==='completed').map((step:any)=>[step.photo_asset_id,step.result]));
      for (const asset of assets) {
        if (checkpoints.has(asset.id)) continue;
        await heartbeat(); if (controller.signal.aborted) throw new Error('photo_lease_or_authorization_lost');
        this.reader.assertCompatibleAsset?.(asset);
        const stored=await this.db.from('photo_assets').select('*').eq('id',asset.id).eq('workspace_id',scope.workspaceId).eq('project_id',scope.projectId).eq('status','ready').maybeSingle();
        if (stored.error || !stored.data) throw new Error('photo_source_unavailable');
        const row:PhotoAssetRow=stored.data;
        if (toPhotoSourceAsset(row).sha256!==asset.sha256) throw new Error('photo_source_revision_changed');
        const bytes=await loadVerifiedPhoto(row,this.storage,this.fetcher,true,controller.signal);
        const begun=await this.rpc('begin_photo_takeoff_step',{p_run_id:runId,p_lease_id:leaseId,p_asset_id:asset.id});
        if (begun!=='run') throw new Error('photo_checkpoint_conflict');
        providerStarted=true;
        // Reuse the established meter and capture routine. Only the reservation
        // boundary is scoped to the real photo run/lease/asset, never a fake PDF job.
        const writer={from:(table:string)=>this.db.from(table),rpc:async(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:{message?:string}|null}>=>{
          if (!this.db.rpc) throw new Error('photo_accounting_unavailable');
          if (name==='reserve_provider_spend') {
            const {p_job_id,...identity}=args;
            if (p_job_id!==runId) throw new Error('photo_accounting_identity_mismatch');
            const result=await this.db.rpc('reserve_photo_provider_spend',{...identity,p_run_id:runId,p_lease_id:leaseId,p_asset_id:asset.id});
            const message=result.error && typeof result.error==='object' && 'message' in result.error ? String(result.error.message) : '';
            const classification=/^Company AI spend limit reached$/i.test(message)?'Company AI spend limit reached'
              :/^Photo run\/provider approved (?:spend limit reached|budget is unavailable)$/i.test(message)?'Provider run spend limit reached'
              :'Photo provider accounting unavailable';
            return {data:result.data,error:result.error?{message:classification}:null};
          }
          const result=await this.db.rpc(name,args);
          return {data:result.data,error:result.error?{message:'Photo provider accounting unavailable'}:null};
        }};
        const result=await withUsageMeter({writer,userId:claim.requested_by,workspaceId:scope.workspaceId,
          projectId:scope.projectId,jobId:runId,billing:'paid'},()=>this.reader.read({asset,bytes,references,signal:controller.signal}));
        if (controller.signal.aborted) throw new Error('photo_lease_or_authorization_lost');
        if (await this.rpc('checkpoint_photo_takeoff_step',{p_run_id:runId,p_lease_id:leaseId,p_asset_id:asset.id,p_result:result})!==true) throw new Error('photo_checkpoint_unavailable');
        checkpoints.set(asset.id,result);providerStarted=false;
      }
      const readings=assets.map(asset=>checkpoints.get(asset.id)!);
      const review=reviewPhotoEvidence({...scope,assets,observations:readings.flatMap(result=>result.observations),references,decisions:[]});
      const result={...review,independentReview:'pending',stageStatus:{observation:'completed',reconciliation:'pending',risk_review:'pending'},
        photoQuality:assets.map((asset,index)=>({sourceAssetId:asset.id,...readings[index]!.quality})),
        blockers:[...new Set([...review.blockers,...readings.flatMap(reading=>reading.blockers),'independent_photo_review_pending'])]};
      return await this.rpc('finish_photo_takeoff',{p_run_id:runId,p_lease_id:leaseId,p_result:result});
    } catch (error) {
      // The source/provider body, credential and signed URL never enter errors.
      // A started call has an uncertain outcome until reconciled; lease expiry
      // cannot trigger another billed attempt. Completed photos stay persisted.
      const spendCode=error instanceof ProviderSpendLimitError
        ?error.scope==='run'?'run_provider_spend_limit':'company_spend_limit':null;
      await this.rpc('block_photo_takeoff',{p_run_id:runId,p_lease_id:leaseId,
        p_code:spendCode??(providerStarted?'unknown_provider_outcome':'photo_source_or_persistence_blocked')}).catch(()=>{});
      throw new Error(spendCode??(providerStarted?'photo_run_reconciliation_required':'photo_run_blocked'));
    } finally {clearInterval(timer);controller.abort();}
  }
}
