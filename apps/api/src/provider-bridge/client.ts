import { ProviderSpendLimitError } from '../owner-usage/meter.ts';
import type { StageRuntimeSources, ProviderResponse } from '../takeoff-v2/stage-provider.ts';
import { BRIDGE_HEADER_NAMES, BRIDGE_PROTOCOL, BridgeError, type BridgeCommand, type OperationView, type WorkerProof } from './protocol.ts';
import { signBridgeCommand, verifyBridgeSignature, verifyBridgeResponseProof } from './auth.ts';
import type { BridgeAuthConfig } from './auth.ts';
import { BRIDGE_PROBE_ID, BRIDGE_PROFILE_HEADER, BRIDGE_RESPONSE_HEADER, bridgeObjectHash, type BridgeRuntimeConfig } from './config.ts';
import { bridgeRpc, type BridgeDatabase, type BridgeOperation } from './persistence.ts';

const states=['planned','waiting_budget','reserved','dispatching','provider_pending','dispatch_unknown','result_pending','completed','failed_final','cancelled_unsent'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
async function boundedReply(response:Response):Promise<string>{
  if(!response.body)throw new BridgeError('bridge_result_unavailable',503);
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>16_384){void reader.cancel().catch(()=>{});throw new BridgeError('bridge_result_unavailable',503);}parts.push(value);}}
  finally{reader.releaseLock();}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts));
}
export function parsedView(value:any,operationId:string):OperationView {
  if(!value||value.operation_id!==operationId||!states.includes(value.state)||!uuid.test(value.event_id)
    ||!/^\d+$/.test(value.state_version)||!/^([a-f0-9]{64})$/.test(value.operation_spec_sha256)
    ||value.result_ref!==null&&!uuid.test(value.result_ref))throw new BridgeError('bridge_result_unavailable',503);
  return value as OperationView;
}
export async function sendBridgeCommand(config:{auth:BridgeAuthConfig;endpoint:string;requestTimeoutMs:number},fetcher:typeof fetch,
  command:BridgeCommand,signal?:AbortSignal):Promise<{status:number;value:any;profile:string|null}>{
  const now=Math.floor(Date.now()/1000),signed=signBridgeCommand(command,config.auth,now);
  const proof=verifyBridgeSignature(command,signed.headers,config.auth,now);
  const response=await fetcher(config.endpoint,{method:'POST',redirect:'error',headers:{'content-type':'application/json',
    [BRIDGE_HEADER_NAMES.timestamp]:signed.headers.timestamp,[BRIDGE_HEADER_NAMES.nonce]:signed.headers.nonce,
    [BRIDGE_HEADER_NAMES.signature]:signed.headers.signature},body:signed.canonical_body,
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(config.requestTimeoutMs+30_000)]):AbortSignal.timeout(config.requestTimeoutMs+30_000)});
  const body=await boundedReply(response);
  verifyBridgeResponseProof(body,proof.command_body_sha256,proof.nonce_sha256,response.headers.get(BRIDGE_RESPONSE_HEADER)??'',config.auth);
  let value:unknown;try{value=JSON.parse(body);}catch{throw new BridgeError('bridge_result_unavailable',503);}
  return {status:response.status,value,profile:response.headers.get(BRIDGE_PROFILE_HEADER)};
}
/** Commands carry selectors/proofs only. Provider documents, prompts and secrets never cross this transport. */
export class ProviderBridgeClient {
  private readonly db:BridgeDatabase;private readonly config:BridgeRuntimeConfig;private readonly workerId:string;
  private readonly generation:string;private readonly fetcher:typeof fetch;private ready=false;
  constructor(db:BridgeDatabase,config:BridgeRuntimeConfig,workerId:string,generation:string,fetcher:typeof fetch=fetch){
    if(!uuid.test(workerId)||!uuid.test(generation))throw new BridgeError('bridge_auth_unconfigured',503);
    this.db=db;this.config=config;this.workerId=workerId;this.generation=generation;this.fetcher=fetcher;
  }
  private async send(command:BridgeCommand,signal?:AbortSignal):Promise<{status:number;value:any;profile:string|null}>{
    return sendBridgeCommand({...this.config,requestTimeoutMs:this.config.stages.requestTimeoutMs},this.fetcher,command,signal);
  }
  async handshake():Promise<void>{
    const command:BridgeCommand={action:'get_operation',protocol:BRIDGE_PROTOCOL,run_id:BRIDGE_PROBE_ID,operation_id:BRIDGE_PROBE_ID,
      worker:{worker_id:this.workerId,worker_generation:this.generation,lease_id:BRIDGE_PROBE_ID,fence:'1'}};
    const response=await this.send(command,AbortSignal.timeout(10_000));
    if(response.status!==403||response.value?.error!=='bridge_authority_denied'||response.profile!==this.config.profileHash)throw new BridgeError('bridge_adapter_unavailable',503);
    this.ready=true;
  }
  readonly evidenceTransport:NonNullable<StageRuntimeSources['evidenceTransport']>=async(input,request,evidence,beforeCheckpoint)=>{
    if(!this.ready||!input.leaseId)throw new BridgeError('bridge_adapter_unavailable',503);
    const regional=this.config.stages.regionalReview.enabled&&['discipline','conflict_detection','completeness'].includes(request.passType);
    const imageRegion=evidence.kind==='images'&&regional&&evidence.images.length===1?evidence.images[0]?.region:undefined;
    const region=evidence.kind==='pdf'?evidence.region?.id??null:imageRegion?`r${imageRegion.row}c${imageRegion.column}g${imageRegion.rows}`:null;
    const planned=await bridgeRpc<{operation:BridgeOperation;worker:WorkerProof}>(this.db,'prepare_provider_bridge_full_operation',{
      p_run_id:input.runId,p_lease_id:input.leaseId,p_worker_id:this.workerId,p_generation:this.generation,
      p_page_number:request.sheet.physicalPageNumber,p_pass_type:request.passType,p_region_key:region,p_profile:this.config.profile});
    const operation=planned.operation;
    if(!operation||operation.run_id!==input.runId||operation.spec.sheet.physicalPageNumber!==request.sheet.physicalPageNumber
      ||operation.spec.pass_type!==request.passType||operation.spec.region_key!==region||planned.worker.lease_id!==input.leaseId
      ||planned.worker.worker_id!==this.workerId||planned.worker.worker_generation!==this.generation)throw new BridgeError('bridge_identity_conflict',409);
    const base={protocol:BRIDGE_PROTOCOL,run_id:input.runId,operation_id:operation.id,worker:planned.worker} as const;
    const command:Extract<BridgeCommand,{action:'submit_stage'}>={...base,action:'submit_stage',expected_stage_version:1,
      expected_approved_contract_sha256:bridgeObjectHash(operation.spec.approved_contract),expected_operation_spec_sha256:bridgeObjectHash(operation.spec)};
    let response:Awaited<ReturnType<ProviderBridgeClient['send']>>;
    try{response=await this.send(command,input.signal);}
    catch{input.signal?.throwIfAborted();response=await this.send({...base,action:'get_operation'},input.signal);}
    const deadline=Date.now()+this.config.stages.requestTimeoutMs+30_000;
    let safeResumeAttempts=0;
    while(true){
      if(response.profile!==this.config.profileHash||![200,202].includes(response.status))throw new BridgeError('bridge_result_unavailable',503);
      const view=parsedView(response.value,operation.id);
      if(view.operation_spec_sha256!==command.expected_operation_spec_sha256)throw new BridgeError('bridge_identity_conflict',409);
      if(view.state==='waiting_budget')throw new ProviderSpendLimitError('company',view.event_id);
      if(view.state==='failed_final'&&view.error_code==='run_budget_exhausted')throw new ProviderSpendLimitError('run',view.event_id);
      if(view.state==='completed'){
        const result=await bridgeRpc<{result:ProviderResponse;result_sha256:string}>(this.db,'read_provider_bridge_result',{p_command:{...base,action:'get_operation'}});
        if(!result?.result?.raw||bridgeObjectHash(result.result)!==result.result_sha256)throw new BridgeError('bridge_identity_conflict',409);
        // The external operation has already been saved durably. This attaches
        // its funded result to the existing page/region checkpoint, never dispatches.
        await beforeCheckpoint?.(view.event_id);
        return result.result;
      }
      if(['dispatch_unknown','failed_final','cancelled_unsent','result_pending','provider_pending'].includes(view.state))throw new BridgeError('bridge_result_unavailable',503);
      if(Date.now()>deadline)throw new BridgeError('bridge_result_unavailable',503);
      if(['planned','reserved'].includes(view.state)&&safeResumeAttempts++<2){response=await this.send(command,input.signal);continue;}
      input.signal?.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,2_000));
      response=await this.send({...base,action:'get_operation'},input.signal);
    }
  };
}
