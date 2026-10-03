import type { AiPlanObjectStorage } from '../ai-plan/service.ts';
import { assertPlanStoragePath } from '../projects/service.ts';
import { downloadPlan } from '../billing/project-preflight.ts';
import { paidFullRunLimits } from '../takeoff-v2/paid-access.ts';
import { fullTakeoffApprovalProfile, userApprovedFullRunLimits } from '../takeoff-v2/user-spend-approval.ts';
import { requireFullRunSpendLimits } from '../takeoff-v2/run-spend-policy.ts';
import { splitPhysicalPages } from '../takeoff-v2/claude-provider.ts';
import { isolateStageRegions } from '../takeoff-v2/stage-regions.ts';
import { STAGE_MODEL_REGISTRY } from '../takeoff-v2/stage-config.ts';
import { buildPriorEvidenceContext,priorEvidenceNeedsReview } from '../takeoff-v2/prior-context.ts';
import { requestEvidence, type ProviderResponse, type StageEvidenceInput } from '../takeoff-v2/stage-provider.ts';
import { extractSheetText } from '../ai-plan/sheet-text.ts';
import { renderBridgeRegion, verifyBridgeRenderer } from './renderer.ts';
import type { DeepPassRequest } from '../takeoff-v2/types.ts';
import { withReservedProviderExecution } from '../owner-usage/meter.ts';
import { bridgeUsage,reviewedBridgePayload } from './usage.ts';
import { BridgeError, type BridgeCommand } from './protocol.ts';
import { authenticateBridgeRequest } from './request.ts';
import { bridgeResponseProof, bridgeSha256 } from './auth.ts';
import { BRIDGE_PROBE_ID, BRIDGE_PROFILE_HEADER, BRIDGE_RESPONSE_HEADER, BRIDGE_RESERVATION_CAPABILITY, bridgeCanonical, bridgeObjectHash, type BridgeRuntimeConfig } from './config.ts';
import { bridgeRpc, operationView, type BridgeAuthorization, type BridgeDatabase, type BridgeOperation } from './persistence.ts';

export interface BridgeServiceDependencies {db:BridgeDatabase;storage:AiPlanObjectStorage;config:BridgeRuntimeConfig;
  env:Record<string,string|undefined>;fetcher?:typeof fetch;now?:()=>number}
function assertOperation(command:BridgeCommand,authority:BridgeAuthorization,deps:BridgeServiceDependencies):void {
  const {operation:o,run}=authority,s=o.spec;
  if(!o||s.run_id!==command.run_id||o.id!==command.operation_id||o.run_id!==command.run_id||s.schema_version!==1
    ||s.protocol!==command.protocol||s.stage_version!==1||s.authorized_attempt!==1||s.workspace_id!==run.workspace_id
    ||s.project_id!==run.project_id||s.file_id!==run.file_id||s.user_id!==run.requested_by
    ||s.file_sha256!==run.manifest.fileSha256||bridgeObjectHash(s.profile)!==deps.config.profileHash
    ||bridgeObjectHash(s.sheet)!==bridgeObjectHash(run.manifest.sheets[s.sheet.physicalPageNumber-1]))throw new BridgeError('bridge_identity_conflict',409);
  const approval=run.manifest.paidAuthorization??run.manifest.spendApproval;
  if(!approval||approval.approvedBy!==run.requested_by||bridgeObjectHash(approval)!==bridgeObjectHash(s.approved_contract))throw new BridgeError('bridge_authority_denied',403);
  if(run.manifest.paidAuthorization){
    paidFullRunLimits(run.manifest,deps.env);
    const contract=run.manifest.paidAuthorization.contract;
    if(contract.version==='paid-full-v2'){
      const frozen=contract.profile;
      if(frozen.transport!=='bridge'||frozen.templateVersion!==s.profile.template_version||frozen.maximumPageBytes!==10*1024*1024
        ||frozen.maximumContextCharacters!==24_000||bridgeObjectHash(frozen.regionalReview)!==bridgeObjectHash(s.profile.regionalReview)
        ||frozen.renderer&&bridgeObjectHash(frozen.renderer)!==bridgeObjectHash(s.profile.renderer))throw new BridgeError('bridge_identity_conflict',409);
      for(const [pass,stage] of Object.entries(s.profile.stages)){
        const route=frozen.routes[pass as keyof typeof frozen.routes];
        if(!route||route.timeoutMs!==s.profile.requestTimeoutMs||route.inputKind!==STAGE_MODEL_REGISTRY[stage.model].inputKind
          ||bridgeObjectHash(stage)!==bridgeObjectHash({provider:route.provider,model:route.model,reasoningEffort:route.reasoningEffort,
            maxOutputTokens:route.maxOutputTokens,attestation:route.attestation,...(route.baseUrl?{baseUrl:route.baseUrl}:{}),
            ...(route.requestPolicy?{requestPolicy:route.requestPolicy}:{})}))throw new BridgeError('bridge_identity_conflict',409);
      }
      const matches=contract.operations.filter(op=>op.physicalPageNumber===s.sheet.physicalPageNumber&&op.passType===s.pass_type&&op.regionKey===s.region_key);
      const stage=s.profile.stages[s.pass_type];
      if(matches.length!==1||!stage||matches[0]!.provider!==stage.provider||matches[0]!.model!==stage.model
        ||matches[0]!.maximumCallCostUsd!==stage.attestation.maximumCallCostUsd
        ||matches[0]!.reservationUsd!==Math.max(contract.pricing.callReservationUsd,stage.attestation.maximumCallCostUsd))throw new BridgeError('bridge_identity_conflict',409);
    }
  }
  else userApprovedFullRunLimits(run.manifest.spendApproval,fullTakeoffApprovalProfile(deps.env),requireFullRunSpendLimits(deps.env,deps.config.stages));
  const specHash=bridgeObjectHash(s);
  if(o.operation_spec_sha256&&o.operation_spec_sha256!==specHash)throw new BridgeError('bridge_identity_conflict',409);
  if(command.action==='submit_stage'&&(command.expected_stage_version!==s.stage_version
    ||command.expected_operation_spec_sha256!==specHash||command.expected_approved_contract_sha256!==bridgeObjectHash(approval)))throw new BridgeError('bridge_identity_conflict',409);
}
export function previousContext(rows:any[],ids:readonly string[]):string {
  if(rows.length!==ids.length||rows.some(r=>!ids.includes(r.id)||!['succeeded','blocked'].includes(r.status)))throw new BridgeError('bridge_identity_conflict',409);
  const ordered=ids.map(id=>rows.find(r=>r.id===id));
  return buildPriorEvidenceContext(ordered);
}
async function materialize(authority:BridgeAuthorization,deps:BridgeServiceDependencies):Promise<{
  request:DeepPassRequest;evidence:StageEvidenceInput;context:string;sourceHashes:Record<string,string>;
}> {
  const {run,operation:o}=authority,s=o.spec;
  const stage=deps.config.stages.stages[s.pass_type];
  if(!stage)throw new BridgeError('bridge_adapter_unavailable',503);
  const kind=STAGE_MODEL_REGISTRY[stage.model].inputKind;
  assertPlanStoragePath(run.storage_path,run.workspace_id,run.project_id,run.file_id);
  const signed=await deps.storage.presign('GET',run.storage_path,{expiresIn:300});
  const bytes=await downloadPlan(signed.url,deps.fetcher??fetch);
  if(bridgeSha256(bytes)!==s.file_sha256)throw new BridgeError('bridge_identity_conflict',409);
  const pages=await splitPhysicalPages(bytes,run.manifest),page=pages.get(s.sheet.physicalPageNumber);
  if(!page||page.byteLength>10*1024*1024)throw new BridgeError('bridge_identity_conflict',409);
  const request:DeepPassRequest={runId:s.run_id,sheet:s.sheet,passType:s.pass_type,attempt:1,reasoningEffort:'high',
    idempotencyKey:bridgeSha256(`${s.run_id}:${s.sheet.physicalPageNumber}:${s.pass_type}:1`)};
  let context='[]';
  if(s.previous_pass_ids.length){
    const found=await deps.db.from('takeoff_passes').select('id,status,checkpoint').eq('takeoff_run_id',s.run_id)
      .eq('workspace_id',s.workspace_id).eq('project_id',s.project_id).in('id',s.previous_pass_ids);
    if(found.error||!Array.isArray(found.data))throw new BridgeError('bridge_result_unavailable',503);
    context=previousContext(found.data,s.previous_pass_ids);
  }
  let evidence:StageEvidenceInput;
  const regional=deps.config.stages.regionalReview.enabled&&['discipline','conflict_detection','completeness'].includes(s.pass_type);
  const deadline=AbortSignal.timeout(45_000);
  if(regional||kind==='images'){
    const regions=await isolateStageRegions(page,deps.config.stages.regionalReview.grid);
    const selected=regional?regions.filter(r=>r.id===s.region_key):regions;
    if(!selected.length||selected.some(r=>r.rotationDegrees!==s.sheet.rotationDegrees)||!regional&&s.region_key!==null)throw new BridgeError('bridge_identity_conflict',409);
    if(kind==='text')throw new BridgeError('bridge_adapter_unavailable',503);
    if(kind==='pdf')evidence={kind:'pdf',page:selected[0]!.pdfBytes,region:selected[0]!};
    else{
      const images=[];for(const region of selected)images.push(await renderBridgeRegion(region,s.sheet.physicalPageNumber,deadline));
      evidence={kind:'images',images};
    }
  }else if(s.region_key!==null)throw new BridgeError('bridge_identity_conflict',409);
  else if(kind==='text'){
    const text=await extractSheetText(page,{maxPages:1,maxCharacters:6_000,maxCharactersPerPage:6_000});
    const transcript=text.pages[0]?.text??'';
    if(!transcript.trim()&&context==='[]')throw new BridgeError('bridge_adapter_unavailable',503);
    evidence={kind:'text',text:`NATIVE TRANSCRIPT:\n${transcript}\nPRIOR UNTRUSTED SHEET EVIDENCE:\n${context}`,
      truncated:text.truncated||text.pages[0]?.truncated===true||context.includes('context_capacity_reached')};
  }else evidence={kind:'pdf',page};
  const inputHash=evidence.kind==='pdf'?bridgeSha256(evidence.page):bridgeObjectHash(evidence);
  return {request,evidence,context,sourceHashes:{file_sha256:bridgeSha256(bytes),page_bytes_sha256:bridgeSha256(page),input_bytes_sha256:inputHash}};
}
async function submit(command:Extract<BridgeCommand,{action:'submit_stage'}>,authority:BridgeAuthorization,deps:BridgeServiceDependencies):Promise<BridgeOperation>{
  let operation=authority.operation;
  if(!['planned','waiting_budget','reserved'].includes(operation.state)||operation.not_before&&Date.parse(operation.not_before)>Date.now())return operation;
  operation=await bridgeRpc<BridgeOperation>(deps.db,'reserve_provider_bridge_operation',{p_command:command});
  if(operation.state!=='reserved')return operation;
  // Private source materialization happens only after database authority and admission.
  const input=await materialize({...authority,operation},deps),stage=deps.config.stages.stages[operation.spec.pass_type]!;
  const contract=authority.run.manifest.paidAuthorization?.contract;
  const usageRoute=contract?.version==='paid-full-v2'?contract.profile.routes[operation.spec.pass_type]!:stage;
  let dispatchToken:string|undefined,wonOperation:BridgeOperation|undefined,callCount=0,transportCount=0,dispatchPayload:unknown,dispatchedAt=0;
  const guardedFetch=(async(url:any,init?:RequestInit)=>{
    if(++transportCount!==1||init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string')throw new BridgeError('bridge_identity_conflict',409);
    // Endpoint and payload are built exclusively by the reviewed internal adapter.
    const allowed=stage.provider==='gemini'?`https://generativelanguage.googleapis.com/v1beta/models/${stage.model}:generateContent`
      :stage.provider==='openai'?'https://api.openai.com/v1/responses':stage.provider==='claude'?'https://api.anthropic.com/v1/messages'
      :stage.provider==='kimi'||stage.provider==='deepseek'?`${stage.baseUrl}/chat/completions`:null;
    if(!allowed||String(url)!==allowed)throw new BridgeError('bridge_adapter_unavailable',503);
    dispatchPayload=JSON.parse(init.body);dispatchedAt=Date.now();
    if('tariff'in usageRoute&&!reviewedBridgePayload(usageRoute,dispatchPayload))throw new BridgeError('bridge_identity_conflict',409);
    const claim=await bridgeRpc<{won:boolean;operation:BridgeOperation;dispatch_token?:string}>(deps.db,'claim_provider_bridge_dispatch',{
      p_command:command,p_expected_state_version:operation.state_version,p_operation_spec_sha256:bridgeObjectHash(operation.spec),
      p_dispatch_payload_sha256:bridgeSha256(init.body),p_source_hashes:input.sourceHashes});
    wonOperation=claim.operation;if(!claim.won||!claim.dispatch_token)throw new BridgeError('bridge_identity_conflict',409);
    dispatchToken=claim.dispatch_token;
    return (deps.fetcher??fetch)(url,init);
  }) as typeof fetch;
  try{
    const response=await withReservedProviderExecution({writer:deps.db,userId:operation.spec.user_id,workspaceId:operation.spec.workspace_id,
      projectId:operation.spec.project_id,jobId:operation.run_id,billing:'paid'},async(provider,model,kind,call)=>{
        if(++callCount!==1||provider!==stage.provider||model!==stage.model||kind!=='generate')throw new BridgeError('bridge_identity_conflict',409);
        return call();
      },()=>requestEvidence(guardedFetch,deps.config.stages,stage,input.request,input.evidence,input.context));
    response.bridgeSource={inputKind:input.evidence.kind,textTruncated:input.evidence.kind==='text'&&input.evidence.truncated,
      contextTruncated:input.context.includes('context_capacity_reached'),priorReviewRequired:priorEvidenceNeedsReview(input.context,input.request.sheet.physicalPageNumber)};
    if(!dispatchToken||transportCount!==1||Buffer.byteLength(bridgeCanonical(response))>500_000)throw new BridgeError('bridge_result_unavailable',503);
    return await bridgeRpc<BridgeOperation>(deps.db,'finalize_provider_bridge_operation',{p_operation_id:operation.id,p_dispatch_token:dispatchToken,
      p_result:response,p_result_sha256:bridgeObjectHash(response),p_usage:bridgeUsage(response,usageRoute,dispatchPayload,dispatchedAt),p_outcome:'result'});
  }catch(error){
    if(!dispatchToken){if(wonOperation)return wonOperation;throw error;}
    // Never reissue a paid call after network/timeout/output/storage uncertainty.
    try{return await bridgeRpc<BridgeOperation>(deps.db,'finalize_provider_bridge_operation',{p_operation_id:operation.id,p_dispatch_token:dispatchToken,
      p_result:null,p_result_sha256:null,p_usage:{},p_outcome:'unknown'});}catch{throw new BridgeError('bridge_result_unavailable',503);}
  }
}

/** Fixed endpoint, no provider/model/prompt/source URL selected by the request. */
export async function handleProviderBridge(request:Request,deps:BridgeServiceDependencies,verified?:Awaited<ReturnType<typeof authenticateBridgeRequest>>):Promise<Response>{
  let proof:{command_body_sha256:string;nonce_sha256:string}|undefined;
  const reply=(value:unknown,status:number)=>{
    const body=bridgeCanonical(value),headers:Record<string,string>={'content-type':'application/json','cache-control':'no-store'};
    if(proof){headers[BRIDGE_RESPONSE_HEADER]=bridgeResponseProof(body,proof.command_body_sha256,proof.nonce_sha256,deps.config.auth);
      headers[BRIDGE_PROFILE_HEADER]=deps.config.profileHash;}
    return new Response(body,{status,headers});
  };
  try{
    const authenticated=verified??await authenticateBridgeRequest(request,deps.config.auth,Math.floor((deps.now?.()??Date.now())/1000));proof=authenticated;
    const command=authenticated.command;
    if(command.protocol!=='takeoff-v2.2-durable')throw new BridgeError('bridge_request_invalid',400);
    if(command.action==='get_operation'&&command.run_id===BRIDGE_PROBE_ID&&command.operation_id===BRIDGE_PROBE_ID){
      const ready=await bridgeRpc<{ready?:boolean;reservationCapability?:string}>(deps.db,'provider_bridge_schema_ready');
      if(ready?.ready!==true||ready.reservationCapability!==BRIDGE_RESERVATION_CAPABILITY)throw new BridgeError('bridge_adapter_unavailable',503);
      if(Object.values(deps.config.stages.stages).some(stage=>STAGE_MODEL_REGISTRY[stage.model].inputKind==='images'))await verifyBridgeRenderer();
      return reply({error:'bridge_authority_denied'},403); // Auth proved; no real run was authorized or mutated.
    }
    const authority=await bridgeRpc<BridgeAuthorization>(deps.db,'authorize_provider_bridge_command',{p_command:command,
      p_auth_context:deps.config.auth.trustedEnvironmentContext,p_nonce_sha256:proof.nonce_sha256,p_body_sha256:proof.command_body_sha256,
      p_signed_at:Number(request.headers.get('x-rb-bridge-timestamp'))});
    assertOperation(command,authority,deps);
    const operation=command.action==='submit_stage'&&!authority.replay?await submit(command,authority,deps):authority.operation;
    const view=operationView({...operation,operation_spec_sha256:bridgeObjectHash(operation.spec)});
    return reply(view,['completed','failed_final','cancelled_unsent'].includes(view.state)?200:202);
  }catch(error){return reply({error:error instanceof BridgeError?error.code:'bridge_adapter_unavailable'},error instanceof BridgeError?error.status:503);}
}
