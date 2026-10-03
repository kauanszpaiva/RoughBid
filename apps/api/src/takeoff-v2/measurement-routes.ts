import { isPlatformAdmin } from '../access/platform-admin.ts';
import { assertFullTakeoffRunAccess } from './paid-access.ts';
import { downloadPlan } from '../billing/project-preflight.ts';
import { ProjectApiError, assertPlanStoragePath, type SupabaseLike } from '../projects/service.ts';
import type { AiPlanObjectStorage, PlanReadingFindingsWriter } from '../ai-plan/service.ts';
import { FULL_TAKEOFF_V2_DURABLE_VERSION } from './durable.ts';
import { MEASUREMENT_REVIEW_VERSION, displayedPageDimensions, geometryMatchesNativeExtent, nativeMeasurementCandidates, reviewMeasurement, type MeasurementScope } from './measurement-review.ts';

export interface MeasurementReviewDependencies {writer:PlanReadingFindingsWriter;storage?:AiPlanObjectStorage;fetcher?:typeof fetch;}
const columns='id,takeoff_run_id,file_id,file_sha256,physical_page_number,page_sha256,region_key,region_bounds,canonical_element_key,canonical_trade,label,geometry,source_kind,source_candidate_id,quantity,unit,calibration,proof,formula,method,uncertainty,review_status,review_revision,reviewed_by,reviewed_at,updated_at';
function value<T>(result:{data:T;error:unknown},message:string):T {if(result.error)throw new ProjectApiError(503,message);return result.data;}

export class MeasurementReviewService {
  private readonly db:SupabaseLike;
  private readonly deps:MeasurementReviewDependencies;
  private readonly userId:string;
  private readonly workspaceId:string;
  constructor(db:SupabaseLike,deps:MeasurementReviewDependencies,userId:string,workspaceId:string){this.db=db;this.deps=deps;this.userId=userId;this.workspaceId=workspaceId;}
  private async authorize(runId:string,write=false) {
    const member=value<any>(await this.db.from('workspace_members').select('role').eq('workspace_id',this.workspaceId).eq('user_id',this.userId).maybeSingle(),'Could not verify measurement access.');
    if(!member||!['admin','estimator'].includes(member.role))throw new ProjectApiError(403,'Admin or estimator access is required for measurement review.');
    const run=value<any>(await this.db.from('takeoff_runs').select('id,workspace_id,project_id,file_id,file_sha256,orchestrator_version,mode,manifest,payment_kind')
      .eq('id',runId).eq('workspace_id',this.workspaceId).eq('mode','full').eq('orchestrator_version',FULL_TAKEOFF_V2_DURABLE_VERSION).maybeSingle(),'Could not read the measurement run.');
    if(!run)throw new ProjectApiError(404,'Full Takeoff run not found.');
    if(run.payment_kind==='paid')await assertFullTakeoffRunAccess(this.db,this.deps.writer,runId,this.userId,this.workspaceId);
    else if(!await isPlatformAdmin(this.db,this.userId))throw new ProjectApiError(403,'Full Takeoff measurement review is restricted to the platform owner during validation.');
    const project=value<any>(await this.db.from('projects').select('id').eq('id',run.project_id).eq('workspace_id',this.workspaceId).maybeSingle(),'Could not verify the measurement project.');
    if(!project)throw new ProjectApiError(404,'Measurement project not found.');
    if(write){
      const workspace=value<any>(await this.db.from('workspaces').select('ai_processing_consented_at').eq('id',this.workspaceId).maybeSingle(),'Could not verify measurement consent.');
      if(!workspace?.ai_processing_consented_at)throw new ProjectApiError(403,'Workspace AI processing consent is required for this Full Takeoff review.');
    }
    return run;
  }
  private async scope(run:any,page:number):Promise<MeasurementScope> {
    if(!Number.isSafeInteger(page)||page<1||page>200)throw new ProjectApiError(400,'Select one physical page from 1 to 200.');
    const sheet=value<any>(await this.db.from('plan_sheets').select('physical_page_number,page_sha256,width_points,height_points,rotation_degrees')
      .eq('takeoff_run_id',run.id).eq('workspace_id',this.workspaceId).eq('project_id',run.project_id).eq('file_id',run.file_id).eq('physical_page_number',page).maybeSingle(),'Could not read the measurement sheet.');
    if(!sheet)throw new ProjectApiError(404,'Physical measurement page not found.');
    return {runId:run.id,workspaceId:this.workspaceId,projectId:run.project_id,fileId:run.file_id,fileSha256:run.file_sha256,
      physicalPageNumber:page,pageSha256:sheet.page_sha256,widthPoints:Number(sheet.width_points),heightPoints:Number(sheet.height_points),rotationDegrees:Number(sheet.rotation_degrees)};
  }
  private async native(scope:MeasurementScope) {
    if(!this.deps.storage)throw new ProjectApiError(503,'Private plan storage is unavailable for local vector extraction.');
    const file=value<any>(await this.db.from('project_files').select('storage_path').eq('id',scope.fileId).eq('workspace_id',this.workspaceId).eq('project_id',scope.projectId).maybeSingle(),'Could not verify the measurement source file.');
    if(!file)throw new ProjectApiError(404,'Measurement source file not found.');
    assertPlanStoragePath(file.storage_path,this.workspaceId,scope.projectId,scope.fileId);
    const signed=await this.deps.storage.presign('GET',file.storage_path,{expiresIn:300});
    const bytes=await downloadPlan(signed.url,this.deps.fetcher??fetch);
    return nativeMeasurementCandidates(bytes,scope);
  }
  async list(runId:string,page:number|undefined,offset=0,native=false,measurementId?:string) {
    const run=await this.authorize(runId);
    if(!Number.isSafeInteger(offset)||offset<0||offset>100_000)throw new ProjectApiError(400,'Invalid measurement pagination offset.');
    if(measurementId!==undefined&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(measurementId)||offset!==0||native))throw new ProjectApiError(400,'Select one valid measurement identity without a pagination offset or native-candidate query.');
    const scope=page!==undefined?await this.scope(run,page):undefined;
    const dimensions=scope?displayedPageDimensions(scope):undefined;
    const context={projectId:run.project_id,fileId:run.file_id,fileSha256:run.file_sha256,physicalPageCount:run.manifest?.physicalPageCount??null,
      ...(scope?{sheet:{physicalPageNumber:scope.physicalPageNumber,pageSha256:scope.pageSha256,pageWidthPoints:scope.widthPoints,
        pageHeightPoints:scope.heightPoints,rotationDegrees:scope.rotationDegrees,displayWidthPoints:dimensions!.width,displayHeightPoints:dimensions!.height}}:{})};
    if(native){if(!scope)throw new ProjectApiError(400,'Native candidates require one explicit physical page.');return {...await this.native(scope),...context,version:MEASUREMENT_REVIEW_VERSION};}
    let query=this.db.from('takeoff_measurement_reviews').select(columns).eq('takeoff_run_id',runId).eq('workspace_id',this.workspaceId).eq('project_id',run.project_id).eq('file_id',run.file_id).eq('file_sha256',run.file_sha256);
    if(page!==undefined)query=query.eq('physical_page_number',page);
    if(measurementId)query=query.eq('id',measurementId);
    const rows=value<any[]>(await query.order('physical_page_number').order('id').range(offset,offset+49),'Could not read reviewed measurements.');
    return {runId,...context,version:MEASUREMENT_REVIEW_VERSION,measurements:rows,offset,nextOffset:rows.length===50?offset+50:null,humanReviewRequired:true,
      scopeCoverage:'selected_elements_only',pricingStatus:'awaiting_compositions_and_price_sources'};
  }
  async save(runId:string,body:unknown) {
    const run=await this.authorize(runId,true);
    if(!body||typeof body!=='object'||Array.isArray(body))throw new ProjectApiError(400,'A measurement review object is required.');
    const scope=await this.scope(run,Number((body as any).physicalPageNumber));
    const reviewed=reviewMeasurement(body,scope);
    let nativeCandidate:unknown=null;
    if(reviewed.input.sourceKind==='native_vector_candidate'){
      const found=await this.native(scope);nativeCandidate=found.candidates.find(candidate=>candidate.id===reviewed.input.sourceCandidateId)??null;
      if(!nativeCandidate)throw new ProjectApiError(422,'Native candidate was not reproduced from this file/page revision.');
      const candidate=nativeCandidate as any,g=reviewed.input.geometry;
      if(reviewed.input.decision==='accepted'&&geometryMatchesNativeExtent(g,candidate.bbox)
        &&reviewed.input.boundaryEvidence?.method!=='verified_rectangular_surface')throw new ProjectApiError(422,'A native bounding box is an extent, not a surface boundary. Trace the actual boundary or verify a rectangular surface explicitly.');
    }
    if(!this.deps.writer.rpc)throw new ProjectApiError(503,'Measurement review persistence is unavailable.');
    const saved=await this.deps.writer.rpc('record_takeoff_measurement_review',{p_run_id:runId,p_workspace_id:this.workspaceId,p_user_id:this.userId,
      p_review:{...reviewed.input,nativeCandidate}});
    if(saved.error)throw new ProjectApiError(409,'Measurement review conflicted or its evidence could not be verified. Reload its saved revision.');
    return {measurement:saved.data,version:MEASUREMENT_REVIEW_VERSION,humanReviewRequired:true,pricingStatus:'awaiting_compositions_and_price_sources'};
  }
}

export async function handleMeasurementReviewRequest(request:Request,db:SupabaseLike,deps:MeasurementReviewDependencies):Promise<Response> {
  try {
    const auth=await db.auth.getUser();if(auth.error||!auth.data.user)throw new ProjectApiError(401,'Authentication required.');
    const workspaceId=request.headers.get('x-workspace-id');if(!workspaceId)throw new ProjectApiError(400,'x-workspace-id header is required.');
    const url=new URL(request.url),parts=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean);
    if(parts[0]!=='takeoff-runs'||!parts[1]||parts[2]!=='measurements'||parts.length!==3)return Response.json({error:'Not found'},{status:404});
    const service=new MeasurementReviewService(db,deps,auth.data.user.id,workspaceId);
    if(request.method==='GET')return Response.json(await service.list(parts[1],url.searchParams.has('page_number')?Number(url.searchParams.get('page_number')):undefined,
      url.searchParams.has('offset')?Number(url.searchParams.get('offset')):0,url.searchParams.get('native_candidates')==='true',url.searchParams.get('measurement_id')??undefined),{headers:{'cache-control':'private, no-store'}});
    if(request.method==='POST'){
      const raw=await request.text();if(Buffer.byteLength(raw)>50_000)throw new ProjectApiError(413,'Measurement review exceeds its evidence bound.');
      let input:unknown;try{input=JSON.parse(raw);}catch{throw new ProjectApiError(400,'A JSON measurement review is required.');}
      return Response.json(await service.save(parts[1],input),{status:201,headers:{'cache-control':'private, no-store'}});
    }
    return Response.json({error:'Method not allowed'},{status:405});
  } catch(error){return Response.json({error:error instanceof ProjectApiError?error.message:'Measurement review failed. Existing evidence was preserved.'},{status:error instanceof ProjectApiError?error.status:500});}
}
