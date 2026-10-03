import { createHash } from 'node:crypto';
import { isPlatformAdmin } from '../access/platform-admin.ts';
import { ProjectApiError } from '../projects/service.ts';
import type { DocumentDb, DocumentObjectStorage } from '../documents/service.ts';
import { PHOTO_ASSET_LIMITS, reviewPhotoEvidence, validatePhotoAssets, type PhotoDimensionReference,
  type PhotoReviewDecision, type PhotoSourceAsset } from '../photo-evidence.ts';
import { assertPhotoId, assertPhotoStoragePath, inspectPhoto, loadVerifiedPhoto, photoStoragePath, toPhotoSourceAsset,
  type PhotoAssetRow } from './assets.ts';
import { PHOTO_TAKEOFF_VERSION, type PhotoTakeoffProfile } from './config.ts';
import { enqueuePhotoRun, type PhotoTakeoffQueue } from './queue.ts';

export interface PhotoRequestDependencies {
  writer: DocumentDb;
  storage: DocumentObjectStorage;
  config?: PhotoTakeoffProfile;
  queue?: PhotoTakeoffQueue;
  fetcher?: typeof fetch;
}
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const RUN_LIST_COLUMNS = 'id,status,progress,error_code,request_key,asset_ids,review_revision,created_at,updated_at,cancel_requested_at';
const RUN_COLUMNS = `${RUN_LIST_COLUMNS},result,manifest,requested_by`;
const safeRun = (row: any,includeResult=false) => ({ id: row.id, status: row.status, progress: row.progress, error_code: row.error_code,
  ...(includeResult?{result:row.result}:{}),request_key:row.request_key,asset_ids:row.asset_ids??row.manifest?.assets?.map((asset:any)=>asset.id)??[],
  review_revision:row.review_revision,created_at: row.created_at, updated_at: row.updated_at, cancel_requested: Boolean(row.cancel_requested_at) });
function canonicalReviewValue(value:unknown):unknown {
  if (Array.isArray(value)) return value.map(canonicalReviewValue);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalReviewValue(value[key])]));
  return value;
}
const planarPoints=(value:unknown)=>Array.isArray(value)?value.map(point=>Array.isArray(point)
  ?[typeof point[0]==='number'?point[0]:null,typeof point[1]==='number'?point[1]:null]:null):null;
function planarCalibrationInput(value:unknown):unknown {
  if(!record(value))return null;
  return {version:value.version,sourceAssetId:value.sourceAssetId,sourceRevision:value.sourceRevision,sourceSha256:value.sourceSha256,
    surfaceKey:value.surfaceKey,referencePoints:planarPoints(value.referencePoints),referenceWidth:value.referenceWidth,
    referenceHeight:value.referenceHeight,referenceUnit:value.referenceUnit,rectangleVerified:value.rectangleVerified,lensDistortionReviewed:value.lensDistortionReviewed};
}
function planarMeasurementInput(value:unknown):unknown {
  if(!record(value))return null;
  return {version:value.version,sourceAssetId:value.sourceAssetId,sourceRevision:value.sourceRevision,sourceSha256:value.sourceSha256,
    surfaceKey:value.surfaceKey,kind:value.kind,points:planarPoints(value.points),measure:value.measure,
    samePlaneReviewed:value.samePlaneReviewed,geometryReviewed:value.geometryReviewed,
    ...(value.holes===undefined?{}:{holes:true}),...(value.rings===undefined?{}:{rings:true})};
}

/** All privileged writes/signing follow authenticated tenant, founder, role and consent checks. */
export class PhotoTakeoffService {
  private readonly db:DocumentDb;
  private readonly deps:PhotoRequestDependencies;
  private readonly userId:string;
  private readonly workspaceId:string;
  constructor(db:DocumentDb,deps:PhotoRequestDependencies,userId:string,workspaceId:string) {
    this.db=db;this.deps=deps;this.userId=userId;this.workspaceId=workspaceId;
  }

  private async access(projectId: string, write = false, consent = false): Promise<void> {
    assertPhotoId(projectId); assertPhotoId(this.workspaceId); assertPhotoId(this.userId);
    const member = await this.db.from('workspace_members').select('role').eq('workspace_id', this.workspaceId).eq('user_id', this.userId).maybeSingle();
    if (member.error || !member.data || (write && !['admin','estimator'].includes(member.data.role))) throw new ProjectApiError(403, 'Your workspace role cannot process photos.');
    const project = await this.db.from('projects').select('id').eq('workspace_id', this.workspaceId).eq('id',projectId).maybeSingle();
    if (project.error || !project.data) throw new ProjectApiError(404,'Project not found.');
    if (!await isPlatformAdmin(this.db,this.userId)) throw new ProjectApiError(403,'Photo takeoff is restricted to the platform owner during validation.');
    if (consent) {
      const workspace = await this.db.from('workspaces').select('ai_processing_consented_at').eq('id',this.workspaceId).maybeSingle();
      if (workspace.error || !workspace.data?.ai_processing_consented_at) throw new ProjectApiError(403,'Workspace AI processing consent is required.');
    }
  }
  private requireConfig(): PhotoTakeoffProfile {
    if (!this.deps.config) throw new ProjectApiError(503,'Photo takeoff is disabled or has not passed model/schema verification.');
    return this.deps.config;
  }
  private async rpc(name: string, args: Record<string,unknown>): Promise<any> {
    if (!this.deps.writer.rpc) throw new ProjectApiError(503,'Photo takeoff persistence is unavailable.');
    const result = await this.deps.writer.rpc(name,args);
    if (result.error) throw new ProjectApiError(409,'Photo operation could not be completed safely. Check its saved state before continuing.');
    return result.data;
  }
  private async workerReady(config: PhotoTakeoffProfile): Promise<boolean> {
    if (!this.deps.writer.rpc) return false;
    const result = await this.deps.writer.rpc('photo_takeoff_worker_available',{p_profile_hash:config.profileHash});
    return !result.error && result.data === true;
  }
  async capability(projectId: string) {
    await this.access(projectId);
    const config = this.deps.config;
    return { enabled:Boolean(config), ownerAccess:true, workerReady:config ? await this.workerReady(config) : false,
      ...(config ? {provider:config.provider,model:config.model} : {}), quality:'maximum', quantityPolicy:'human_reference_review_required', pricingStatus:'missing_price',
      stages:[{stage:'observation',state:config?'configured':'disabled',...(config?{provider:config.provider,model:config.model}:{})},
        {stage:'reconciliation',state:'pending'},{stage:'risk_review',state:'pending'}] };
  }
  async beginUpload(projectId: string, input: unknown) {
    await this.access(projectId,true,true); this.requireConfig();
    if (!record(input) || typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 255
      || !['image/jpeg','image/png','image/webp'].includes(input.contentType)) throw new ProjectApiError(415,'Only named JPEG, PNG and WebP photos are accepted.');
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > PHOTO_ASSET_LIMITS.maximumAssetBytes) throw new ProjectApiError(413,'Photo must be no larger than 20 MB.');
    const id = crypto.randomUUID();
    const row = {id,workspace_id:this.workspaceId,project_id:projectId,uploaded_by:this.userId,
      storage_path:photoStoragePath(this.workspaceId,projectId,id,input.contentType),original_name:input.name.replace(/[^a-zA-Z0-9._ -]/g,'_'),
      mime_type:input.contentType,byte_size:input.byteSize,status:'uploading'};
    const result = await this.deps.writer.from('photo_assets').insert(row).select('id,original_name,mime_type,byte_size,status').single();
    if (result.error || !result.data) throw new ProjectApiError(503,'Photo upload could not be reserved.');
    return {asset:result.data,upload:await this.deps.storage.presign('PUT',row.storage_path,{contentType:row.mime_type,
      maximumSizeInBytes:row.byte_size,expiresIn:300})};
  }
  private async asset(projectId: string, assetId: string): Promise<PhotoAssetRow> {
    assertPhotoId(assetId);
    const result = await this.db.from('photo_assets').select('*').eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',assetId).maybeSingle();
    if (result.error || !result.data) throw new ProjectApiError(404,'Photo not found.');
    assertPhotoStoragePath(result.data); return result.data;
  }
  async completeUpload(projectId: string, assetId: string) {
    await this.access(projectId,true,true); this.requireConfig();
    const row = await this.asset(projectId,assetId);
    if (row.status === 'ready') return {asset:toPhotoSourceAsset(row)};
    if (row.uploaded_by !== this.userId) throw new ProjectApiError(403,'Only the uploader can complete this photo.');
    const bytes = await loadVerifiedPhoto(row,this.deps.storage,this.deps.fetcher ?? fetch,false);
    const metadata = inspectPhoto(bytes,row.mime_type);
    const saved = await this.deps.writer.from('photo_assets').update({status:'ready',sha256:metadata.sha256,
      width_pixels:metadata.width,height_pixels:metadata.height,completed_at:new Date().toISOString()})
      .eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',assetId).eq('status','uploading').select('*').maybeSingle();
    if (saved.error || !saved.data) throw new ProjectApiError(409,'Photo completion conflicted. Reload its saved state.');
    return {asset:toPhotoSourceAsset(saved.data)};
  }
  async download(projectId: string,assetId:string) {
    await this.access(projectId);
    const row = await this.asset(projectId,assetId);
    if (row.status !== 'ready') throw new ProjectApiError(409,'Photo upload is not verified.');
    return this.deps.storage.presign('GET',row.storage_path,{expiresIn:60});
  }
  private references(value:unknown,assets:readonly PhotoSourceAsset[],projectId:string): readonly PhotoDimensionReference[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100 || value.some(item => !record(item))) throw new ProjectApiError(400,'Photo references must be a bounded array.');
    const references = value.map(item => ({id:item.id,region:record(item.region)?{sourceAssetId:item.region.sourceAssetId,
      surfaceKey:item.region.surfaceKey,bbox:item.region.bbox}:item.region,objectIdentityKey:item.objectIdentityKey,
      reviewerId:this.userId,kind:item.kind,value:item.value,unit:item.unit,verified:item.verified === true,
      coplanarVerified:item.coplanarVerified === true,perspectiveVerified:item.perspectiveVerified === true,
      ...(item.planarCalibration===undefined?{}:{planarCalibration:planarCalibrationInput(item.planarCalibration)})})) as PhotoDimensionReference[];
    reviewPhotoEvidence({assets,workspaceId:this.workspaceId,projectId,observations:[],references,decisions:[]});
    return references;
  }
  async reserve(projectId:string,input:unknown) {
    await this.access(projectId,true,true); const config = this.requireConfig();
    if (!this.deps.queue || !await this.workerReady(config)) throw new ProjectApiError(503,'A compatible durable photo worker is unavailable. No run was started.');
    if (!record(input) || !Array.isArray(input.assetIds) || input.assetIds.length < 1 || input.assetIds.length > PHOTO_ASSET_LIMITS.maximumAssets
      || new Set(input.assetIds).size !== input.assetIds.length) throw new ProjectApiError(400,'Select one to eight distinct verified photos.');
    input.assetIds.forEach(assertPhotoId); assertPhotoId(input.requestKey);
    const found = await this.db.from('photo_assets').select('*').eq('workspace_id',this.workspaceId).eq('project_id',projectId).in('id',input.assetIds).eq('status','ready');
    if (found.error || !Array.isArray(found.data) || found.data.length !== input.assetIds.length) throw new ProjectApiError(404,'One or more photos are unavailable in this project.');
    const rows = new Map<string,PhotoAssetRow>(found.data.map((row:PhotoAssetRow) => [row.id,row]));
    const assets = validatePhotoAssets(input.assetIds.map((id:string)=>toPhotoSourceAsset(rows.get(id)!)),{workspaceId:this.workspaceId,projectId});
    const references = this.references(input.references,assets,projectId);
    if (assets.length*config.maximumCallCostUsd>config.approvedRunBudgetUsd) throw new ProjectApiError(503,'The approved photo run/provider budget does not cover the selected batch. No run was started.');
    const saved = await this.rpc('reserve_photo_takeoff',{p_workspace_id:this.workspaceId,p_project_id:projectId,p_user_id:this.userId,
      p_request_key:input.requestKey,p_assets:assets,p_references:references,p_profile_hash:config.profileHash,p_provider:config.provider,p_model:config.model,
      p_approved_budget_usd:config.approvedRunBudgetUsd,p_budget_approval_ref:config.runBudgetApprovalRef});
    let enqueued = false;
    if (saved.run?.status === 'queued') {
      try { await enqueuePhotoRun(this.deps.queue,saved.run.id); enqueued = true; } catch { /* Saved queued run can be explicitly resumed without re-reserving. */ }
    }
    return {...saved,enqueued,version:PHOTO_TAKEOFF_VERSION};
  }
  private async run(projectId:string,runId:string):Promise<any> {
    assertPhotoId(runId);
    const found = await this.db.from('photo_takeoff_runs').select(RUN_COLUMNS).eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',runId).maybeSingle();
    if (found.error || !found.data) throw new ProjectApiError(404,'Photo run not found.');
    return found.data;
  }
  async list(projectId:string) {
    await this.access(projectId);
    const result = await this.db.from('photo_takeoff_runs').select(RUN_LIST_COLUMNS).eq('workspace_id',this.workspaceId).eq('project_id',projectId).order('created_at',{ascending:false}).limit(25);
    if (result.error) throw new ProjectApiError(503,'Photo run history is unavailable.');
    return {runs:(result.data??[]).map((row:any)=>safeRun(row))};
  }
  async get(projectId:string,runId:string) {
    await this.access(projectId); const run = await this.run(projectId,runId);
    const steps = await this.db.from('photo_takeoff_steps').select('photo_asset_id,status,completed_at').eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('run_id',runId).order('created_at');
    if (steps.error) throw new ProjectApiError(503,'Photo checkpoints are unavailable.');
    return {run:safeRun(run,true),steps:steps.data??[],assets:run.manifest?.assets??[],references:run.manifest?.references??[]};
  }
  async checkpoint(projectId:string,runId:string,assetId:string) {
    await this.access(projectId);assertPhotoId(assetId);const run=await this.run(projectId,runId);
    const asset=run.manifest?.assets?.find((source:any)=>source.id===assetId);
    if (!asset) throw new ProjectApiError(404,'Photo is not part of this run.');
    const found=await this.db.from('photo_takeoff_steps').select('photo_asset_id,status,result,completed_at').eq('workspace_id',this.workspaceId)
      .eq('project_id',projectId).eq('run_id',runId).eq('photo_asset_id',assetId).maybeSingle();
    if (found.error||!found.data) throw new ProjectApiError(404,'Photo checkpoint not found.');
    return {runId,photo_asset_id:assetId,status:found.data.status,checkpoint:found.data.result,completed_at:found.data.completed_at,asset};
  }
  async cancel(projectId:string,runId:string) {
    await this.access(projectId,true); await this.run(projectId,runId);
    return this.rpc('cancel_photo_takeoff',{p_run_id:runId,p_workspace_id:this.workspaceId,p_user_id:this.userId});
  }
  async resume(projectId:string,runId:string) {
    await this.access(projectId,true,true); const config=this.requireConfig(); await this.run(projectId,runId);
    if (!this.deps.queue || !await this.workerReady(config)) throw new ProjectApiError(503,'The durable photo worker is unavailable.');
    const result=await this.rpc('resume_photo_takeoff',{p_run_id:runId,p_workspace_id:this.workspaceId,p_user_id:this.userId,p_profile_hash:config.profileHash});
    let enqueued=false;
    if (result.status==='queued') { try {await enqueuePhotoRun(this.deps.queue,runId);enqueued=true;}catch {} }
    return {...result,enqueued};
  }
  async review(projectId:string,runId:string,input:unknown) {
    await this.access(projectId,true); const run=await this.run(projectId,runId);
    if (run.status!=='needs_review' || !record(run.result) || !record(input) || !Array.isArray(input.decisions)
      || input.decisions.length>100 || input.decisions.some(item=>!record(item))) throw new ProjectApiError(409,'A completed photo run and bounded human decisions are required.');
    if (!Number.isSafeInteger(input.expectedReviewRevision) || input.expectedReviewRevision<0) {
      throw new ProjectApiError(400,'The saved photo review revision is required. Reload the run before reviewing.');
    }
    assertPhotoId(input.reviewRequestKey);
    const assets=validatePhotoAssets(run.manifest.assets,{workspaceId:this.workspaceId,projectId});
    const references=this.references(input.references,assets,projectId);
    const decisions=input.decisions.map(item=>({observationId:item.observationId,disposition:item.disposition,reviewerId:this.userId,
      quantity:item.quantity,unit:item.unit,method:item.method,calculationMethod:item.calculationMethod,referenceId:item.referenceId,
      objectIdentityKey:item.objectIdentityKey,identityAssetIds:Array.isArray(item.identityAssetIds)?[...new Set(item.identityAssetIds)].sort():item.identityAssetIds,
      crossViewIdentityReviewed:item.crossViewIdentityReviewed,uncertaintyResolved:item.uncertaintyResolved,
      ...(item.planarMeasurement===undefined?{}:{planarMeasurement:planarMeasurementInput(item.planarMeasurement)})})) as PhotoReviewDecision[];
    // The request identity describes the human intent, independent of timestamp,
    // JSON property order and the current optimistic-lock revision. A retry must
    // return its own stored receipt even after a later review has been saved.
    const requestHash=createHash('sha256').update(JSON.stringify(canonicalReviewValue({workspaceId:this.workspaceId,projectId,runId,
      reviewerId:this.userId,references:[...references].sort((a,b)=>a.id.localeCompare(b.id)),
      decisions:[...decisions].sort((a,b)=>a.observationId.localeCompare(b.observationId))}))).digest('hex');
    const review=reviewPhotoEvidence({assets,workspaceId:this.workspaceId,projectId,observations:run.result.observations,references,decisions});
    const result={...review,releaseStatus:'blocked',blockers:[...new Set([...review.blockers,'independent_photo_review_pending'])],
      independentReview:'pending',stageStatus:run.result.stageStatus,photoQuality:run.result.photoQuality,
      reviewed_by:this.userId,reviewed_at:new Date().toISOString(),references,decisions};
    return this.rpc('save_photo_takeoff_review',{p_run_id:runId,p_workspace_id:this.workspaceId,p_project_id:projectId,p_user_id:this.userId,
      p_request_key:input.reviewRequestKey,p_request_sha256:requestHash,p_expected_revision:input.expectedReviewRevision,p_result:result});
  }
}
