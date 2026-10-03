import { HttpPhotoReader,type PhotoReader } from '../photos/provider.ts';
import { completeStageContext,type PhotoStageResult } from '../photos/stages.ts';
import { loadVerifiedPhoto,toPhotoSourceAsset } from '../photos/assets.ts';
import type { DocumentObjectStorage } from '../documents/service.ts';
import { withReservedProviderExecution } from '../owner-usage/meter.ts';
import { bridgeUsage,reviewedBridgePayload } from './usage.ts';
import { BridgeError,PHOTO_BRIDGE_PROTOCOL,type BridgeCommand } from './protocol.ts';
import { authenticateBridgeRequest } from './request.ts';
import { bridgeResponseProof,bridgeSha256 } from './auth.ts';
import { BRIDGE_PROBE_ID,BRIDGE_PROFILE_HEADER,BRIDGE_RESPONSE_HEADER,BRIDGE_RESERVATION_CAPABILITY,bridgeCanonical,bridgeObjectHash } from './config.ts';
import { bridgeRpc,operationView,type BridgeDatabase } from './persistence.ts';
import type { PhotoBridgeConfig } from './photo-config.ts';
import type { PhotoBridgeAuthorization,PhotoBridgeOperation } from './photo-persistence.ts';
export interface PhotoBridgeDependencies{db:BridgeDatabase;storage:DocumentObjectStorage;config:PhotoBridgeConfig;fetcher?:typeof fetch}
function assertPhotoAuthority(command:BridgeCommand,a:PhotoBridgeAuthorization,d:PhotoBridgeDependencies):void{
  const o=a.operation,s=o.spec,r=a.run,m=r.manifest;
  if(o.id!==command.operation_id||o.run_id!==command.run_id||s.run_id!==command.run_id||s.protocol!==PHOTO_BRIDGE_PROTOCOL||s.schema_version!==1
    ||s.stage_version!==1||s.authorized_attempt!==1||s.workspace_id!==r.workspace_id||s.project_id!==r.project_id||s.user_id!==r.requested_by||s.operation_key!==s.operation.key
    ||bridgeObjectHash(s.profile)!==bridgeObjectHash(m.profile)||bridgeObjectHash(s.profile)!==bridgeObjectHash(d.config.profile.complete)
    ||bridgeObjectHash(s.references)!==bridgeObjectHash(m.references??[]))throw new BridgeError('bridge_identity_conflict',409);
  const frozen=m.operations.filter(op=>op.key===s.operation_key);
  if(frozen.length!==1||bridgeObjectHash(frozen[0])!==bridgeObjectHash(s.operation)||s.assets.length!==s.operation.assetIds.length
    ||s.assets.some((asset,index)=>asset.id!==s.operation.assetIds[index]||bridgeObjectHash(asset)!==bridgeObjectHash(m.assets.find(a=>a.id===asset.id))))throw new BridgeError('bridge_identity_conflict',409);
  const approval=r.photo_quote_id?{quoteId:r.photo_quote_id,paymentRevision:r.payment_revision,contractHash:m.purchaseContractHash}:m.includedAuthorization;
  if(!approval||bridgeObjectHash(approval)!==bridgeObjectHash(s.approved_contract))throw new BridgeError('bridge_authority_denied',403);
  if(command.action==='submit_stage'&&(command.expected_stage_version!==1||command.expected_operation_spec_sha256!==bridgeObjectHash(s)
    ||command.expected_approved_contract_sha256!==bridgeObjectHash(approval)))throw new BridgeError('bridge_identity_conflict',409);
}
async function submitPhoto(command:Extract<BridgeCommand,{action:'submit_stage'}>,authority:PhotoBridgeAuthorization,d:PhotoBridgeDependencies):Promise<PhotoBridgeOperation>{
  let o=authority.operation;
  if(!['planned','waiting_budget','reserved'].includes(o.state)||o.not_before&&Date.parse(o.not_before)>Date.now())return o;
  o=await bridgeRpc<PhotoBridgeOperation>(d.db,'reserve_photo_bridge_operation',{p_command:command});if(o.state!=='reserved')return o;
  const s=o.spec,route=s.profile.routes[s.operation.stage],sources:Parameters<NonNullable<PhotoReader['readStage']>>[0]['sources']=[];
  for(const asset of s.assets){
    const found=await d.db.from('photo_assets').select('*').eq('id',asset.id).eq('workspace_id',s.workspace_id).eq('project_id',s.project_id).eq('status','ready').maybeSingle();
    if(found.error||!found.data||bridgeObjectHash(toPhotoSourceAsset(found.data))!==bridgeObjectHash(asset))throw new BridgeError('bridge_identity_conflict',409);
    const bytes=await loadVerifiedPhoto(found.data,d.storage,d.fetcher??fetch,true,AbortSignal.timeout(30_000));
    sources.push({asset,bytes});
  }
  const prior=s.previous_stage_keys.length?await d.db.from('photo_stage_checkpoints').select('operation_key,status,result').eq('run_id',s.run_id).in('operation_key',s.previous_stage_keys):{data:[],error:null};
  if(prior.error||!Array.isArray(prior.data)||prior.data.length!==s.previous_stage_keys.length
    ||prior.data.some((p:any)=>p.status!=='completed'||!p.result||!s.previous_stage_keys.includes(p.operation_key)))throw new BridgeError('bridge_identity_conflict',409);
  const results=new Map<string,PhotoStageResult>(s.previous_stage_keys.map(key=>[key,prior.data.find((p:any)=>p.operation_key===key).result]));
  const context=completeStageContext(s.operation,results);
  let dispatchToken:string|undefined,wonOperation:PhotoBridgeOperation|undefined,networkCount=0,meterCount=0,telemetry:unknown,dispatchPayload:unknown,dispatchedAt=0;
  const guardedFetch=(async(url:any,init?:RequestInit)=>{
    const expected=route.provider==='openai'?'https://api.openai.com/v1/responses':route.provider==='claude'?'https://api.anthropic.com/v1/messages':`https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent`;
    if(++networkCount!==1||String(url)!==expected||init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string')throw new BridgeError('bridge_identity_conflict',409);
    dispatchPayload=JSON.parse(init.body);dispatchedAt=Date.now();
    if(!reviewedBridgePayload(route,dispatchPayload))throw new BridgeError('bridge_identity_conflict',409);
    const claim=await bridgeRpc<{won:boolean;operation:PhotoBridgeOperation;dispatch_token?:string}>(d.db,'claim_photo_bridge_dispatch',{p_command:command,
      p_expected_state_version:o.state_version,p_operation_spec_sha256:bridgeObjectHash(s),p_dispatch_payload_sha256:bridgeSha256(init.body),
      p_source_hashes:{assets:sources.map(source=>({id:source.asset.id,sha256:bridgeSha256(source.bytes)}))}});
    wonOperation=claim.operation;if(!claim.won||!claim.dispatch_token)throw new BridgeError('bridge_identity_conflict',409);dispatchToken=claim.dispatch_token;
    return (d.fetcher??fetch)(url,init);
  }) as typeof fetch;
  try{
    if(!d.config.providerConfig)throw new BridgeError('bridge_adapter_unavailable',503);
    const reader=new HttpPhotoReader(d.config.providerConfig,guardedFetch);
    const result=await withReservedProviderExecution({writer:d.db,userId:s.user_id,workspaceId:s.workspace_id,projectId:s.project_id,jobId:s.run_id,billing:'paid'},
      async(provider,model,kind,call)=>{if(++meterCount!==1||provider!==route.provider||model!==route.model||kind!=='generate')throw new BridgeError('bridge_identity_conflict',409);telemetry=await call();return telemetry;},
      ()=>reader.readStage({operation:s.operation,sources,references:s.references,context,signal:AbortSignal.timeout(route.timeoutMs+15_000),beforeDispatch:async()=>{throw new BridgeError('bridge_identity_conflict',409);}}));
    if(!dispatchToken||networkCount!==1||Buffer.byteLength(bridgeCanonical(result))>500_000)throw new BridgeError('bridge_result_unavailable',503);
    return await bridgeRpc<PhotoBridgeOperation>(d.db,'finalize_photo_bridge_operation',{p_operation_id:o.id,p_dispatch_token:dispatchToken,p_result:result,
      p_result_sha256:bridgeObjectHash(result),p_usage:bridgeUsage(telemetry,route,dispatchPayload,dispatchedAt),p_outcome:'result'});
  }catch(error){
    if(!dispatchToken){if(wonOperation)return wonOperation;throw error;}
    try{return await bridgeRpc<PhotoBridgeOperation>(d.db,'finalize_photo_bridge_operation',{p_operation_id:o.id,p_dispatch_token:dispatchToken,p_result:null,p_result_sha256:null,p_usage:{},p_outcome:'unknown'});}
    catch{throw new BridgeError('bridge_result_unavailable',503);}
  }
}
export async function handlePhotoBridge(request:Request,d:PhotoBridgeDependencies,verified?:Awaited<ReturnType<typeof authenticateBridgeRequest>>):Promise<Response>{
  let proof:{command_body_sha256:string;nonce_sha256:string}|undefined;
  const reply=(value:unknown,status:number)=>{const body=bridgeCanonical(value),headers:Record<string,string>={'content-type':'application/json','cache-control':'no-store'};
    if(proof){headers[BRIDGE_RESPONSE_HEADER]=bridgeResponseProof(body,proof.command_body_sha256,proof.nonce_sha256,d.config.auth);headers[BRIDGE_PROFILE_HEADER]=d.config.profileHash;}return new Response(body,{status,headers});};
  try{
    const authenticated=verified??await authenticateBridgeRequest(request,d.config.auth,Math.floor(Date.now()/1000));proof=authenticated;const command=authenticated.command;
    if(command.protocol!==PHOTO_BRIDGE_PROTOCOL)throw new BridgeError('bridge_request_invalid',400);
    if(command.action==='get_operation'&&command.run_id===BRIDGE_PROBE_ID&&command.operation_id===BRIDGE_PROBE_ID){
      const ready=await bridgeRpc<{ready:boolean;reservationCapability:string;photoCapability:string}>(d.db,'photo_provider_bridge_schema_ready');
      if(!ready?.ready||ready.reservationCapability!==BRIDGE_RESERVATION_CAPABILITY||ready.photoCapability!=='photo-bridge-v1')throw new BridgeError('bridge_adapter_unavailable',503);
      return reply({error:'bridge_authority_denied'},403);
    }
    const authority=await bridgeRpc<PhotoBridgeAuthorization>(d.db,'authorize_photo_bridge_command',{p_command:command,p_auth_context:d.config.auth.trustedEnvironmentContext,
      p_nonce_sha256:proof.nonce_sha256,p_body_sha256:proof.command_body_sha256,p_signed_at:Number(request.headers.get('x-rb-bridge-timestamp'))});
    assertPhotoAuthority(command,authority,d);
    const operation=command.action==='submit_stage'&&!authority.replay?await submitPhoto(command,authority,d):authority.operation;
    const view=operationView({...operation,operation_spec_sha256:bridgeObjectHash(operation.spec)});
    return reply(view,['completed','failed_final','cancelled_unsent'].includes(view.state)?200:202);
  }catch(error){return reply({error:error instanceof BridgeError?error.code:'bridge_adapter_unavailable'},error instanceof BridgeError?error.status:503);}
}
