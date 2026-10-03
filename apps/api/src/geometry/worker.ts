import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import type {DocumentDb,DocumentObjectStorage} from '../documents/service.ts';
import {assertPlanStoragePath} from '../projects/service.ts';
import {downloadPlan} from '../billing/project-preflight.ts';
import {KamaiTakeoffAdapter,type KamaiCheckpoint,type KamaiCheckpointStore} from '../takeoff-v2/kamai-provider.ts';
import {ApsModelDerivativeAdapter,type ApsTranslationCheckpoint,type ApsCheckpointStore} from '../takeoff-v2/aps-provider.ts';
import {GEOMETRY_VERSION,type GeometryProfile} from './config.ts';
import {kamaiCandidates,apsPropertyCandidates,type GeometryCandidate} from './candidates.ts';
import {enqueueGeometryRun,type GeometryQueue,type GeometryJob} from './queue.ts';
/** One persisted tick, then delayed durable polling. No whole-job deadline and no automatic upload retry. */
export class GeometryProcessor {
  private db:DocumentDb;private storage:DocumentObjectStorage;private profile:GeometryProfile;private workerId:string;
  private queue:GeometryQueue;private fetcher:typeof fetch;private now:()=>Date;
  constructor(db:DocumentDb,storage:DocumentObjectStorage,profile:GeometryProfile,workerId:string,queue:GeometryQueue,fetcher:typeof fetch=fetch,now:()=>Date=()=>new Date()){
    this.db=db;this.storage=storage;this.profile=profile;this.workerId=workerId;this.queue=queue;this.fetcher=fetcher;this.now=now;}
  private async rpc(name:string,args:Record<string,unknown>):Promise<any>{if(!this.db.rpc)throw new Error('geometry_persistence_unavailable');const r=await this.db.rpc(name,args);
    if(r.error){const text=String((r.error as any)?.message??'');throw new Error(/Company AI spend/i.test(text)?'company_spend_blocked':/Geometry run spend/i.test(text)?'geometry_run_spend_blocked':'geometry_persistence_blocked');}return r.data;}
  async touch():Promise<void>{if(await this.rpc('touch_geometry_provider_worker',{p_worker_id:this.workerId,p_profile_hash:this.profile.profileHash})!==true)throw new Error('geometry_worker_unavailable');}
  /** Reconcile the saved→queue acknowledgement gap without invoking a provider. */
  async recover():Promise<number>{
    const rows=await this.rpc('recoverable_geometry_provider_jobs',{p_profile_hash:this.profile.profileHash});
    if(!Array.isArray(rows)||rows.length>50)throw new Error('geometry_recovery_response_invalid');
    let enqueued=0;for(const row of rows){
      if(typeof row.id!=='string'||typeof row.updated_at!=='string')throw new Error('geometry_recovery_identity_invalid');
      const tick=createHash('sha256').update(`${row.id}|${row.updated_at}`).digest('hex').slice(0,20);
      await this.queue.add('read-geometry',{runId:row.id,version:GEOMETRY_VERSION},{jobId:`${row.id}-recovery-${tick}`,attempts:1,delay:0,removeOnComplete:1000,removeOnFail:true});enqueued++;
    }return enqueued;
  }
  async process(job:{data:GeometryJob}):Promise<unknown>{
    if(job.data.version!==GEOMETRY_VERSION)throw new Error('geometry_job_version_invalid');
    const claim=await this.rpc('claim_geometry_provider_job',{p_run_id:job.data.runId,p_worker_id:this.workerId,p_profile_hash:this.profile.profileHash});if(claim.skip)return claim;
    const run=claim.run,leaseId=run.lease_id,controller=new AbortController();let busy=false;
    const heartbeat=async()=>{if(busy||controller.signal.aborted)return;busy=true;try{if(await this.rpc('heartbeat_geometry_provider_job',{p_run_id:run.id,p_lease_id:leaseId})!==true)controller.abort();}catch{controller.abort();}finally{busy=false;}};
    const timer=setInterval(()=>void heartbeat(),15_000);timer.unref?.();let reservationFailure:string|null=null;
    // Every provider HTTP operation, including polling/OAuth, reserves exposure first.
    const transport:typeof fetch=async(input,init)=>{
      await heartbeat();if(controller.signal.aborted)throw new Error('geometry_cancelled_or_lease_lost');
      const url=new URL(input instanceof Request?input.url:String(input));
      if(run.provider==='kamai'&&url.origin!=='https://api.kamai.io'||run.provider==='aps'&&url.origin!=='https://developer.api.autodesk.com')throw new Error('geometry_provider_origin_invalid');
      try{await this.rpc('reserve_geometry_provider_spend',{p_run_id:run.id,p_lease_id:leaseId,p_operation:`${init?.method??'GET'} ${url.pathname}`.slice(0,200)});}
      catch(error){reservationFailure=error instanceof Error?error.message:'geometry_persistence_blocked';throw error;}
      if(controller.signal.aborted)throw new Error('geometry_cancelled_or_lease_lost');
      return this.fetcher(input,{...init,redirect:'manual',signal:AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])])});
    };
    const load=async()=>{const found=await this.db.from('geometry_provider_jobs').select('checkpoint').eq('id',run.id).eq('workspace_id',run.workspace_id).eq('project_id',run.project_id).maybeSingle();if(found.error||!found.data)throw new Error('geometry_checkpoint_unavailable');return found.data.checkpoint;};
    const save=async(checkpoint:any,initial=false)=>this.rpc('save_geometry_provider_checkpoint',{p_run_id:run.id,p_lease_id:leaseId,p_checkpoint:checkpoint,p_initial:initial});
    let status:'waiting'|'needs_review'|'blocked'='waiting',errorCode:string|null=null,artifact:any=run.artifact??null,candidates:GeometryCandidate[]=[],nextPollAt:string|null=null;
    try{
      if(run.provider==='kamai'){
        if(!this.profile.kamai)throw new Error('geometry_provider_disabled');
        const store:KamaiCheckpointStore={load,claimInitial:c=>save(c,true),save:async c=>{await save(c);}};
        const adapter=new KamaiTakeoffAdapter(this.profile.kamai,transport,store,this.now);let checkpoint:KamaiCheckpoint;
        if(run.checkpoint)checkpoint=await adapter.poll(run.id);
        else{
          const file=await this.db.from('project_files').select('id,workspace_id,project_id,storage_path,processing_status,page_count').eq('id',run.file_id).eq('workspace_id',run.workspace_id).eq('project_id',run.project_id).maybeSingle();
          if(file.error||!file.data||file.data.processing_status!=='ready')throw new Error('geometry_source_unavailable');
          assertPlanStoragePath(file.data.storage_path,run.workspace_id,run.project_id,run.file_id);
          const signed=await this.storage.presign('GET',file.data.storage_path,{expiresIn:60});const bytes=await downloadPlan(signed.url,this.fetcher);
          if(createHash('sha256').update(bytes).digest('hex')!==run.file_sha256)throw new Error('geometry_source_revision_changed');
          const pdf=await PDFDocument.load(bytes,{updateMetadata:false});if(pdf.getPageCount()!==run.expected_pages||run.physical_page_number<1||run.physical_page_number>pdf.getPageCount())throw new Error('geometry_page_revision_changed');
          const single=await PDFDocument.create();const [page]=await single.copyPages(pdf,[run.physical_page_number-1]);single.addPage(page!);const pageBytes=await single.save();
          await heartbeat();if(controller.signal.aborted)throw new Error('geometry_cancelled_or_lease_lost');
          checkpoint=await adapter.submit({runId:run.id,fileSha256:createHash('sha256').update(pageBytes).digest('hex'),expectedPageCount:1,filename:`page-${run.physical_page_number}.pdf`,fileBytes:pageBytes});
        }
        if(reservationFailure)throw new Error(reservationFailure);nextPollAt=checkpoint.nextPollAt;
        if(checkpoint.evidence&&checkpoint.state==='review_required'&&checkpoint.evidence.textTotal!==null&&checkpoint.textOffset===checkpoint.evidence.textTotal){candidates=kamaiCandidates(checkpoint,{runId:run.id,fileSha256:run.file_sha256,physicalPageNumber:run.physical_page_number});
          status='needs_review';errorCode=checkpoint.errorCode;artifact={provider:'kamai',blueprintId:checkpoint.blueprintId,revision:checkpoint.evidence.revision,
            coverage:{physicalPageNumber:run.physical_page_number,expectedPages:run.expected_pages,complete:false},text:checkpoint.evidence.text,textTotal:checkpoint.evidence.textTotal};}
        else if(['review_required','failed','upload_uncertain','submitting'].includes(checkpoint.state)){status='blocked';errorCode=checkpoint.errorCode??'provider_artifact_unverified';}
      }else{
        const config=this.profile.aps;if(!config)throw new Error('geometry_provider_disabled');
        if(!run.source_binding_proof_ref||!this.profile.apsSourceBindings?.some(v=>v.projectId===run.project_id&&v.objectId===run.source_object_id
          &&v.sourceVersion===run.source_version&&v.fileSha256===run.file_sha256&&v.proofRef===run.source_binding_proof_ref&&v.reviewed===true))throw new Error('aps_source_binding_unverified');
        const store:ApsCheckpointStore={load,claimInitial:c=>save(c,true),save:async c=>{await save(c);}};
        const adapter=new ApsModelDerivativeAdapter(config,transport,store,this.now);const checkpoint:ApsTranslationCheckpoint=run.checkpoint?await adapter.poll(run.id):await adapter.start({runId:run.id,sourceFormat:run.source_format,objectId:run.source_object_id});
        if(reservationFailure)throw new Error(reservationFailure);nextPollAt=checkpoint.nextPollAt;
        if(checkpoint.state==='translation_ready'){
          const tokenResponse=await transport('https://developer.api.autodesk.com/authentication/v2/token',{method:'POST',headers:{Authorization:`Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
            'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',scope:'data:read'}),signal:AbortSignal.timeout(30_000)});
          const token=await this.json(tokenResponse);if(typeof token.access_token!=='string'||token.token_type!=='Bearer')throw new Error('aps_property_authorization_unverified');
          const headers={Authorization:`Bearer ${token.access_token}`,Accept:'application/json'};const base=`https://developer.api.autodesk.com/modelderivative/v2/designdata/${encodeURIComponent(checkpoint.sourceUrn)}/metadata`;
          if(!artifact?.views){const metadata=await this.json(await transport(base,{headers,signal:AbortSignal.timeout(30_000)}));
            const views=metadata?.data?.metadata;if(!Array.isArray(views)||views.length<1||views.length>50||views.some((v:any)=>typeof v.guid!=='string'||v.guid.length>200))throw new Error('aps_views_unverified');
            artifact={provider:'aps',views:views.map((v:any)=>({guid:v.guid,name:v.name??null})),processedViews:[],candidates:[],coverage:{complete:false}};
          }else{
            const view=artifact.views.find((v:any)=>!artifact.processedViews.includes(v.guid));
            if(view){const properties=await this.json(await transport(`${base}/${encodeURIComponent(view.guid)}/properties`,{headers,signal:AbortSignal.timeout(30_000)}));
              const extracted=apsPropertyCandidates(properties,{runId:run.id,fileSha256:run.file_sha256,sourceUrn:checkpoint.sourceUrn,sourceVersion:run.source_version,viewGuid:view.guid});
              const existingIds=new Set(artifact.candidates.map((c:GeometryCandidate)=>`${c.source.sourceUrn}|${c.source.sourceVersion}|${c.source.dbId}|${c.source.propertyCategory}|${c.source.propertyName}`));
              const scoped=extracted.map(c=>existingIds.has(`${c.source.sourceUrn}|${c.source.sourceVersion}|${c.source.dbId}|${c.source.propertyCategory}|${c.source.propertyName}`)
                ?{...c,status:'blocked' as const,reviewReasons:[...c.reviewReasons,'duplicate_native_object_across_views']}:c);
              artifact={...artifact,processedViews:[...artifact.processedViews,view.guid],candidates:[...artifact.candidates,...scoped]};}
            if(artifact.processedViews.length===artifact.views.length){candidates=artifact.candidates;status='needs_review';errorCode=candidates.length?null:'aps_typed_measurement_properties_missing';}
          }
          nextPollAt=this.now().toISOString();
        }else if(['review_required','failed','submission_uncertain','submitting'].includes(checkpoint.state)){status='blocked';errorCode=checkpoint.errorCode??'aps_translation_unverified';}
      }
      if(candidates.length>3000){status='blocked';candidates=[];errorCode='geometry_candidate_capacity_exceeded';}
      if(controller.signal.aborted)throw new Error('geometry_cancelled_or_lease_lost');
      await this.rpc('finish_geometry_provider_tick',{p_run_id:run.id,p_lease_id:leaseId,p_status:status,p_error_code:errorCode,p_artifact:artifact,p_candidates:candidates});
      if(status==='waiting')await enqueueGeometryRun(this.queue,run.id,Math.max(1000,nextPollAt?Date.parse(nextPollAt)-this.now().getTime():this.profile.pollIntervalMs));
      return {runId:run.id,status,candidateCount:candidates.length,errorCode};
    }catch(error){const code=error instanceof Error&&['company_spend_blocked','geometry_run_spend_blocked','geometry_source_revision_changed','geometry_source_unavailable','geometry_candidate_capacity_exceeded'].includes(error.message)?error.message:'geometry_provider_or_persistence_blocked';
      await this.rpc('finish_geometry_provider_tick',{p_run_id:run.id,p_lease_id:leaseId,p_status:'blocked',p_error_code:code,p_artifact:artifact,p_candidates:[]}).catch(()=>{});throw new Error(code);
    }finally{clearInterval(timer);controller.abort();}
  }
  private async json(response:Response):Promise<any>{if(!response.ok)throw new Error('aps_property_request_failed');const text=await response.text();if(Buffer.byteLength(text)>4_000_000)throw new Error('aps_property_capacity_exceeded');return JSON.parse(text);}
}
