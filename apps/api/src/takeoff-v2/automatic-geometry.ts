import { createHash } from 'node:crypto';
import type { DocumentDb } from '../documents/service.ts';
import { GeometryTakeoffService, type GeometryDependencies } from '../geometry/service.ts';
import type { PlanSetManifest } from './types.ts';
import { ProjectApiError } from '../projects/service.ts';

export interface AutomaticGeometryScope { runId:string; workspaceId:string; projectId:string; fileId:string; userId:string; manifest:PlanSetManifest; signal?:AbortSignal; }
export interface AutomaticGeometryCoordinator {
  prepare(input:AutomaticGeometryScope):Promise<Record<string,unknown>>;
  summary(input:{workspaceId:string;projectId:string;fileId:string;fileSha256:string;expectedPages:number}):Promise<Record<string,unknown>>;
  cancel(input:{runId:string;workspaceId:string;userId:string}):Promise<Record<string,unknown>>;
}
/** One durable child per pinned physical page; APS is never selected for PDF. */
export function createAutomaticGeometryCoordinator(db:DocumentDb,deps:GeometryDependencies):AutomaticGeometryCoordinator {
  return {
    async prepare(input) {
      if(!deps.profile?.kamai)return {state:'not_configured',requestedPages:0,coverage:'pending',reason:'PDF geometry requires the explicitly authorized Kamai route.'};
      const service=new GeometryTakeoffService(db,deps,input.userId,input.workspaceId);
      const jobs:Array<{pageNumber:number;runId?:string;state:string}>=[];
      for(const sheet of input.manifest.sheets){
        input.signal?.throwIfAborted();
        const hex=createHash('sha256').update(`${input.runId}:${input.manifest.fileSha256}:${sheet.physicalPageNumber}:kamai`).digest('hex').slice(0,32);
        const requestKey=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
        try{
          const result=await service.reserve(input.projectId,{provider:'kamai',fileId:input.fileId,fileSha256:input.manifest.fileSha256,
            physicalPageNumber:sheet.physicalPageNumber,parentRunId:input.runId,requestKey});
          jobs.push({pageNumber:sheet.physicalPageNumber,runId:result.run.id,state:result.enqueued?'queued':String(result.run.status)});
        }catch(error){
          jobs.push({pageNumber:sheet.physicalPageNumber,state:'blocked'});
          return {state:'partially_reserved',jobs,requestedPages:input.manifest.physicalPageCount,coverage:'pending',
            pendingPages:input.manifest.sheets.filter(value=>value.physicalPageNumber>sheet.physicalPageNumber).map(value=>value.physicalPageNumber),
            reason:error instanceof ProjectApiError?error.message:'Automatic geometry reservation is unavailable; no unsaved child was dispatched.'};
        }
      }
      return {state:'reserved',jobs,requestedPages:input.manifest.physicalPageCount,coverage:'pending',
        evidenceEndpoint:`/api/projects/${input.projectId}/geometry/runs?file_id=${input.fileId}`};
    },
    async cancel(input){
      const found=await deps.writer.from('geometry_provider_jobs').select('id,project_id,status').eq('workspace_id',input.workspaceId)
        .eq('parent_takeoff_run_id',input.runId).limit(201);
      if(found.error)throw new ProjectApiError(503,'Child geometry cancellation could not be read. The parent cancellation is saved.');
      let cancelled=0;
      for(const job of found.data??[]){
        if(!['queued','processing','waiting','blocked'].includes(job.status))continue;
        const service=new GeometryTakeoffService(db,deps,input.userId,input.workspaceId);
        await service.control(job.project_id,job.id,'cancel');cancelled++;
      }
      return {cancelledChildren:cancelled,countsPartial:(found.data??[]).length>200,uncertainRemoteCostPreserved:true};
    },
    async summary(input){
      const found=await db.from('geometry_provider_jobs').select('id,physical_page_number,status,error_code')
        .eq('workspace_id',input.workspaceId).eq('project_id',input.projectId).eq('file_id',input.fileId)
        .eq('file_sha256',input.fileSha256).eq('provider','kamai').limit(201);
      if(found.error)throw new ProjectApiError(503,'Automatic geometry progress could not be read. Existing checkpoints were preserved.');
      const jobs=found.data??[],visited=[...new Set<number>(jobs.filter((job:any)=>job.status==='needs_review').map((job:any)=>Number(job.physical_page_number)))].sort((a,b)=>a-b);
      return {jobs:jobs.slice(0,200),expectedPages:input.expectedPages,artifactPages:visited,
        pendingPages:Array.from({length:input.expectedPages},(_,i)=>i+1).filter(page=>!visited.includes(page)),
        hasMore:jobs.length>200,coverage:'provider_artifacts_do_not_certify_semantic_completeness',
        evidenceEndpoint:`/api/projects/${input.projectId}/geometry/runs?file_id=${input.fileId}`};
    },
  };
}

export async function loadAutomaticGeometryForSheet(db:DocumentDb,input:{workspaceId:string;projectId:string;fileId:string;fileSha256:string;physicalPageNumber:number}) {
  const found=await db.from('geometry_provider_jobs').select('id,status,error_code').eq('workspace_id',input.workspaceId).eq('project_id',input.projectId)
    .eq('file_id',input.fileId).eq('file_sha256',input.fileSha256).eq('physical_page_number',input.physicalPageNumber).eq('provider','kamai').limit(20);
  if(found.error)throw new ProjectApiError(503,'Pinned automatic geometry jobs could not be read.');
  const jobs=found.data??[];if(!jobs.length)return {jobs:[],candidates:[],coverage:'geometry_job_not_reserved'};
  const candidates=[];
  for(const job of jobs){
    const rows=await db.from('geometry_provider_candidates').select('candidate,status,review_revision').eq('workspace_id',input.workspaceId).eq('project_id',input.projectId).eq('run_id',job.id).limit(501);
    if(rows.error)throw new ProjectApiError(503,'Pinned automatic geometry evidence could not be read.');
    for(const row of (rows.data??[]).slice(0,500))candidates.push({...row.candidate,status:row.status,reviewRevision:row.review_revision});
    if((rows.data??[]).length>500 || candidates.length>500)return {jobs,candidates:candidates.slice(0,500),coverage:'additional_candidates_require_explicit_pagination',hasMore:true};
  }
  return {jobs,candidates,coverage:'individual_provider_candidates_with_unresolved_coverage',hasMore:false};
}
