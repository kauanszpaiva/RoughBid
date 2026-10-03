import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {isPlatformAdmin} from '../access/platform-admin.ts';
import {ProjectApiError,assertPlanStoragePath} from '../projects/service.ts';
import type {DocumentDb,DocumentObjectStorage} from '../documents/service.ts';
import {downloadPlan} from '../billing/project-preflight.ts';
import type {GeometryProfile} from './config.ts';
import {enqueueGeometryRun,type GeometryQueue} from './queue.ts';
export interface GeometryDependencies{writer:DocumentDb;storage:DocumentObjectStorage;profile?:GeometryProfile;queue?:GeometryQueue;fetcher?:typeof fetch;}
export const geometryUuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=(v:unknown):v is Record<string,any>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const listColumns='id,provider,file_id,physical_page_number,file_sha256,status,error_code,created_at,profile_hash,expected_pages';
export class GeometryTakeoffService {
  private db:DocumentDb;private deps:GeometryDependencies;private userId:string;private workspaceId:string;
  constructor(db:DocumentDb,deps:GeometryDependencies,userId:string,workspaceId:string){this.db=db;this.deps=deps;this.userId=userId;this.workspaceId=workspaceId;}
  private async access(projectId:string,write=false,consent=write):Promise<void>{
    if(![projectId,this.userId,this.workspaceId].every(geometryUuid))throw new ProjectApiError(400,'Valid project and workspace identifiers are required.');
    const member=await this.db.from('workspace_members').select('role').eq('workspace_id',this.workspaceId).eq('user_id',this.userId).maybeSingle();
    if(member.error||!member.data||write&&!['admin','estimator'].includes(member.data.role))throw new ProjectApiError(403,'Your workspace role cannot process geometry.');
    const project=await this.db.from('projects').select('id').eq('id',projectId).eq('workspace_id',this.workspaceId).maybeSingle();
    if(project.error||!project.data)throw new ProjectApiError(404,'Project not found.');
    if(!await isPlatformAdmin(this.db,this.userId))throw new ProjectApiError(403,'Geometry processing is restricted to the platform owner during validation.');
    if(consent){const scope=await this.db.from('workspaces').select('ai_processing_consented_at').eq('id',this.workspaceId).maybeSingle();
      if(scope.error||!scope.data?.ai_processing_consented_at)throw new ProjectApiError(403,'Workspace data-processing consent is required.');}
  }
  private async rpc(name:string,args:Record<string,unknown>):Promise<any>{
    if(!this.deps.writer.rpc)throw new ProjectApiError(503,'Geometry persistence is unavailable.');
    const result=await this.deps.writer.rpc(name,args);if(result.error)throw new ProjectApiError(409,'Geometry operation conflicted or was blocked. Reload saved state before continuing.');return result.data;
  }
  async capability(projectId:string){await this.access(projectId);const p=this.deps.profile;
    const ready=p&&this.deps.queue&&await this.deps.queue.isWorkerAvailable()&&await this.rpc('geometry_provider_worker_available',{p_profile_hash:p.profileHash});
    return {enabled:Boolean(p),workerReady:Boolean(ready),providerAvailability:{kamai:Boolean(p?.kamai),aps:Boolean(p?.aps)},reason:p?ready?null:'durable_worker_unavailable':'geometry_processing_disabled'};
  }
  async reserve(projectId:string,input:unknown){
    await this.access(projectId,true);const profile=this.deps.profile;
    if(!profile||!this.deps.queue)throw new ProjectApiError(503,'Geometry processing is disabled. No provider request was sent.');
    if(!await this.deps.queue.isWorkerAvailable())throw new ProjectApiError(503,'A connected geometry queue consumer is unavailable. No provider request was sent.');
    if(!object(input)||!geometryUuid(input.requestKey)||!['kamai','aps'].includes(input.provider)||!profile[input.provider as 'kamai'|'aps'])throw new ProjectApiError(400,'An authorized provider and request identity are required.');
    let pinned:Record<string,unknown>;
    if(input.provider==='kamai'){
      if(!geometryUuid(input.fileId)||!Number.isSafeInteger(input.physicalPageNumber)||input.physicalPageNumber<1)throw new ProjectApiError(400,'Select a verified PDF and its physical page.');
      const source=await this.db.from('project_files').select('id,workspace_id,project_id,storage_path,page_count,processing_status').eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',input.fileId).maybeSingle();
      if(source.error||!source.data||source.data.processing_status!=='ready'||input.physicalPageNumber>source.data.page_count)throw new ProjectApiError(409,'The PDF page has not completed private upload validation.');
      assertPlanStoragePath(source.data.storage_path,this.workspaceId,projectId,input.fileId);
      let fileSha256=input.fileSha256;
      if(fileSha256!==undefined&&!/^[a-f0-9]{64}$/.test(fileSha256))throw new ProjectApiError(400,'Invalid PDF revision hash.');
      if(!fileSha256){const signed=await this.deps.storage.presign('GET',source.data.storage_path,{expiresIn:60});const bytes=await downloadPlan(signed.url,this.deps.fetcher??fetch);
        const pdf=await PDFDocument.load(bytes,{updateMetadata:false});if(pdf.getPageCount()!==source.data.page_count)throw new ProjectApiError(409,'Private PDF revision changed.');
        fileSha256=createHash('sha256').update(bytes).digest('hex');}
      if(input.parentRunId!==undefined&&!geometryUuid(input.parentRunId))throw new ProjectApiError(400,'Invalid parent analysis.');
      pinned={provider:'kamai',fileId:input.fileId,physicalPageNumber:input.physicalPageNumber,fileSha256,...(input.parentRunId?{parentRunId:input.parentRunId}:{})};
    }else{
      if(!['rvt','ifc','dwg','dxf','dgn','nwd','nwc','skp'].includes(input.sourceFormat)||typeof input.objectId!=='string'
        ||!/^urn:adsk\.objects:os\.object:[^/\s]+\/[^\r\n]+$/.test(input.objectId)||input.objectId.length>2048||/\.pdf$/i.test(input.objectId)
        ||typeof input.sourceVersion!=='string'||input.sourceVersion.trim().length<1||input.sourceVersion.length>200||!/^[a-f0-9]{64}$/.test(input.fileSha256??''))throw new ProjectApiError(422,'Native CAD/BIM needs an authorized existing object, documented source version and file hash.');
      pinned={provider:'aps',sourceFormat:input.sourceFormat,objectId:input.objectId,sourceVersion:input.sourceVersion,fileSha256:input.fileSha256};
      const sourceBinding=profile.apsSourceBindings?.find(v=>v.projectId===projectId&&v.objectId===input.objectId&&v.sourceVersion===input.sourceVersion&&v.fileSha256===input.fileSha256&&v.reviewed===true);
      if(!sourceBinding)throw new ProjectApiError(503,'This CAD/BIM source needs a reviewed project/version binding before translation. No provider request was sent.');
      pinned.sourceBindingProofRef=sourceBinding.proofRef;
    }
    const result=await this.rpc('reserve_geometry_provider_job',{p_user_id:this.userId,p_workspace_id:this.workspaceId,p_project_id:projectId,p_request_key:input.requestKey,
      p_profile_hash:profile.profileHash,p_input:pinned,p_budget:{approvedRunBudgetUsd:profile.approvedRunBudgetUsd,maximumCallCostUsd:profile.maximumCallCostUsd,maximumCalls:profile.maximumCalls,approvalRef:profile.approvalRef}});
    let enqueued=false;if(['queued','waiting'].includes(result.run?.status)){try{await enqueueGeometryRun(this.deps.queue,result.run.id);enqueued=true;}catch{}}
    // Public response never exposes credentials or a signed provider/source URL.
    return {run:this.safeRun(result.run),replayed:result.replayed,enqueued};
  }
  private safeRun(run:any){const {checkpoint,artifact,source_object_id,...safe}=run;return safe;}
  async list(projectId:string,filters:{fileId?:string;physicalPageNumber?:number}={}){
    await this.access(projectId);let query=this.db.from('geometry_provider_jobs').select(listColumns).eq('workspace_id',this.workspaceId).eq('project_id',projectId).order('created_at',{ascending:false});
    if(filters.fileId){if(!geometryUuid(filters.fileId))throw new ProjectApiError(400,'Invalid file filter.');query=query.eq('file_id',filters.fileId);}
    if(filters.physicalPageNumber!==undefined){if(!Number.isSafeInteger(filters.physicalPageNumber)||filters.physicalPageNumber<1)throw new ProjectApiError(400,'Invalid page filter.');query=query.eq('physical_page_number',filters.physicalPageNumber);}
    const result=await query.limit(201);if(result.error)throw new ProjectApiError(503,'Geometry history is unavailable.');return {runs:(result.data??[]).slice(0,200),hasMore:(result.data??[]).length>200};
  }
  private async run(projectId:string,runId:string){if(!geometryUuid(runId))throw new ProjectApiError(400,'Invalid geometry run.');
    const result=await this.db.from('geometry_provider_jobs').select('*').eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('id',runId).maybeSingle();
    if(result.error||!result.data)throw new ProjectApiError(404,'Geometry run not found.');return result.data;}
  async get(projectId:string,runId:string){await this.access(projectId);const run=await this.run(projectId,runId);
    const found=await this.db.from('geometry_provider_candidates').select('candidate,status,review_revision').eq('workspace_id',this.workspaceId).eq('project_id',projectId).eq('run_id',runId).limit(501);
    if(found.error)throw new ProjectApiError(503,'Geometry evidence is unavailable.');const rows=found.data??[];
    return {run:{...this.safeRun(run),checkpoint:run.checkpoint?{state:run.checkpoint.state,providerStatus:run.checkpoint.providerStatus,nextPollAt:run.checkpoint.nextPollAt,pollAttempts:run.checkpoint.pollAttempts}:null},
      candidates:rows.slice(0,500).map((row:any)=>({...row.candidate,status:row.status,reviewRevision:row.review_revision})),hasMore:rows.length>500,
      coverage:{expectedPages:run.expected_pages,verifiedPages:run.status==='needs_review'&&run.provider==='kamai'?[run.physical_page_number]:[],complete:false,
        reasons:['provider_detection_benchmark_pending','cross_sheet_coverage_requires_all_page_jobs']}};
  }
  async control(projectId:string,runId:string,action:'cancel'|'resume'){await this.access(projectId,true,action!=='cancel');await this.run(projectId,runId);
    const run=await this.rpc('control_geometry_provider_job',{p_run_id:runId,p_user_id:this.userId,p_workspace_id:this.workspaceId,p_action:action});
    let enqueued=false;if(action==='resume'&&run.status==='queued'&&this.deps.profile&&this.deps.queue){try{await enqueueGeometryRun(this.deps.queue,run.id);enqueued=true;}catch{}}
    return {run:this.safeRun(run),enqueued};}
  async review(projectId:string,runId:string,input:unknown){await this.access(projectId,true);await this.run(projectId,runId);
    if(!object(input)||!/^[a-f0-9]{64}$/.test(input.candidateId??'')||!geometryUuid(input.requestKey)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
      ||!['accepted','rejected'].includes(input.decision)||typeof input.reviewNote!=='string'||!input.reviewNote.trim()||input.reviewNote.length>1200)throw new ProjectApiError(422,'A candidate decision, review note and current revision are required.');
    const review={decision:input.decision,expectedRevision:input.expectedRevision,reviewNote:input.reviewNote.trim(),identityReviewed:input.identityReviewed===true,
      geometryReviewed:input.geometryReviewed===true,duplicateReviewComplete:input.duplicateReviewComplete===true};
    return this.rpc('review_geometry_provider_candidate',{p_run_id:runId,p_candidate_id:input.candidateId,p_user_id:this.userId,p_workspace_id:this.workspaceId,p_request_key:input.requestKey,p_review:review});}
}
