import type { PhotoReader } from '../photos/provider.ts';
import type { PhotoStageResult } from '../photos/stages.ts';
import { PhotoBridgeRecoveryError,PhotoBridgeOutcomeUnknownError } from '../photos/bridge-state.ts';
import { ProviderSpendLimitError } from '../owner-usage/meter.ts';
import { BridgeError,PHOTO_BRIDGE_PROTOCOL,type BridgeCommand,type WorkerProof } from './protocol.ts';
import { bridgeObjectHash,BRIDGE_PROBE_ID } from './config.ts';
import { bridgeRpc,type BridgeDatabase } from './persistence.ts';
import type { PhotoBridgeOperation } from './photo-persistence.ts';
import type { PhotoBridgeConfig } from './photo-config.ts';
import { sendBridgeCommand,parsedView } from './client.ts';
export class PhotoBridgeReader implements PhotoReader{
  private readonly db:BridgeDatabase;private readonly config:PhotoBridgeConfig;private readonly workerId:string;
  private readonly generation:string;private readonly fetcher:typeof fetch;private ready=false;
  constructor(db:BridgeDatabase,config:PhotoBridgeConfig,workerId:string,generation:string,fetcher:typeof fetch=fetch){
    this.db=db;this.config=config;this.workerId=workerId;this.generation=generation;this.fetcher=fetcher;
  }
  private send(command:BridgeCommand,signal?:AbortSignal){return sendBridgeCommand(this.config,this.fetcher,command,signal);}
  async handshake():Promise<void>{
    const command:BridgeCommand={action:'get_operation',protocol:PHOTO_BRIDGE_PROTOCOL,run_id:BRIDGE_PROBE_ID,operation_id:BRIDGE_PROBE_ID,
      worker:{worker_id:this.workerId,worker_generation:this.generation,lease_id:BRIDGE_PROBE_ID,fence:'1'}};
    const reply=await this.send(command,AbortSignal.timeout(10_000));
    if(reply.status!==403||reply.value?.error!=='bridge_authority_denied'||reply.profile!==this.config.profileHash)throw new BridgeError('bridge_adapter_unavailable',503);
    this.ready=true;
  }
  async read():Promise<never>{throw new BridgeError('bridge_adapter_unavailable',503);}
  async readStage(input:Parameters<NonNullable<PhotoReader['readStage']>>[0]):Promise<PhotoStageResult>{
    if(!this.ready||!input.execution)throw new BridgeError('bridge_adapter_unavailable',503);
    const planned=await bridgeRpc<{operation:PhotoBridgeOperation;worker:WorkerProof}>(this.db,'prepare_photo_bridge_operation',{
      p_run_id:input.execution.runId,p_lease_id:input.execution.leaseId,p_worker_id:this.workerId,p_generation:this.generation,
      p_operation_key:input.operation.key,p_profile:this.config.profile.complete});
    const o=planned.operation,s=o.spec;
    if(o.run_id!==input.execution.runId||s.operation_key!==input.operation.key||s.operation.key!==input.operation.key
      ||bridgeObjectHash(s.assets)!==bridgeObjectHash(input.sources.map(source=>source.asset))
      ||planned.worker.lease_id!==input.execution.leaseId||planned.worker.worker_id!==this.workerId||planned.worker.worker_generation!==this.generation)throw new BridgeError('bridge_identity_conflict',409);
    const base={protocol:PHOTO_BRIDGE_PROTOCOL,run_id:o.run_id,operation_id:o.id,worker:planned.worker}as const;
    const command:Extract<BridgeCommand,{action:'submit_stage'}>={...base,action:'submit_stage',expected_stage_version:1,
      expected_operation_spec_sha256:bridgeObjectHash(s),expected_approved_contract_sha256:bridgeObjectHash(s.approved_contract)};
    const deadline=Date.now()+this.config.requestTimeoutMs+60_000;let unsafe=false,attempts=0;
    try{
      let reply:Awaited<ReturnType<PhotoBridgeReader['send']>>;
      try{reply=await this.send(command,input.signal);}catch{input.signal.throwIfAborted();reply=await this.send({...base,action:'get_operation'},input.signal);}
      while(true){
        if(reply.profile!==this.config.profileHash||![200,202].includes(reply.status)){
          unsafe=reply.status===403||reply.status===409;throw new BridgeError('bridge_result_unavailable',503);
        }
        const view=parsedView(reply.value,o.id);
        if(view.operation_spec_sha256!==command.expected_operation_spec_sha256){unsafe=true;throw new BridgeError('bridge_identity_conflict',409);}
        if(view.state==='waiting_budget')throw new ProviderSpendLimitError('company',view.event_id);
        if(view.state==='failed_final'&&view.error_code==='run_budget_exhausted')throw new ProviderSpendLimitError('run',view.event_id);
        if(view.state==='completed'){
          const result=await bridgeRpc<{result:PhotoStageResult;result_sha256:string}>(this.db,'read_photo_bridge_result',{p_command:{...base,action:'get_operation'}});
          if(!result?.result||bridgeObjectHash(result.result)!==result.result_sha256){unsafe=true;throw new BridgeError('bridge_identity_conflict',409);}
          await input.beforeDispatch(view.event_id);return result.result;
        }
        if(view.state==='dispatch_unknown'){unsafe=true;throw new PhotoBridgeOutcomeUnknownError();}
        if(['failed_final','cancelled_unsent'].includes(view.state)){
          unsafe=true;throw new BridgeError('bridge_result_unavailable',503);
        }
        if(['result_pending','provider_pending'].includes(view.state))throw new PhotoBridgeRecoveryError();
        if(Date.now()>deadline)throw new BridgeError('bridge_result_unavailable',503);
        if(['planned','reserved'].includes(view.state)&&attempts++<2){reply=await this.send(command,input.signal);continue;}
        input.signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,2_000));reply=await this.send({...base,action:'get_operation'},input.signal);
      }
    }catch(error){if(error instanceof ProviderSpendLimitError||unsafe)throw error;throw new PhotoBridgeRecoveryError();}
  }
}
