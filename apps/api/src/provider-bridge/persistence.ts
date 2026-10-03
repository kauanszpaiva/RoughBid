import { BridgeError, type BridgeCommand, type OperationView } from './protocol.ts';
import type { DeepPassType, PlanSetManifest, PlanSheetManifestEntry } from '../takeoff-v2/types.ts';
import type { publicBridgeProfile } from './config.ts';
export interface BridgeDatabase { from(table:string):any; rpc(name:string,args?:Record<string,unknown>):PromiseLike<{data:any;error:{message?:string}|null}> }
export interface BridgeOperation {
  id:string;run_id:string;event_id:string;state:OperationView['state'];state_version:string;
  spec:{schema_version:1;protocol:string;run_id:string;workspace_id:string;project_id:string;user_id:string;file_id:string;file_sha256:string;
    sheet:PlanSheetManifestEntry;pass_type:DeepPassType;region_key:string|null;stage_version:1;authorized_attempt:1;
    approved_contract:unknown;profile:ReturnType<typeof publicBridgeProfile>;previous_pass_ids:string[]};
  operation_spec_sha256:string|null;dispatch_payload_sha256:string|null;result_ref:string|null;result_sha256:string|null;
  cost_state:OperationView['cost_state']|'captured';captured_usd_micros:string|null;reservation_id?:string|null;not_before:string|null;error_code:string|null;
}
export interface BridgeAuthorization { replay:boolean;operation:BridgeOperation;
  run:{workspace_id:string;project_id:string;file_id:string;requested_by:string;manifest:PlanSetManifest;storage_path:string} }
export async function bridgeRpc<T>(db:BridgeDatabase,name:string,args:Record<string,unknown>={}):Promise<T>{
  try{const result=await db.rpc(name,args);if(result.error)throw new BridgeError('bridge_authority_denied',403);return result.data as T;}
  catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError('bridge_result_unavailable',503);}
}
export function operationView(o:Omit<BridgeOperation,'spec'>):OperationView {
  const next:OperationView['next_action']=o.state==='waiting_budget'?'wait_budget':o.state==='completed'?'read_result'
    :o.state==='provider_pending'||o.state==='dispatch_unknown'||o.state==='result_pending'?'reconcile_only'
    :o.state==='planned'||o.state==='reserved'||o.state==='dispatching'?'get_operation':'none';
  const errors:OperationView['error_code'][]=['run_budget_exhausted','company_budget','source_changed','provider_result_uncertain'];
  const error=o.error_code==='dispatch_outcome_unknown'?'provider_result_uncertain':o.error_code;
  return {operation_id:o.id,state:o.state,state_version:String(o.state_version),event_id:o.event_id,
    operation_spec_sha256:o.operation_spec_sha256??'',next_action:next,not_before:o.not_before??null,
    reservation_id:o.reservation_id??null,cost_state:o.cost_state==='captured'?'captured_estimated':o.cost_state,captured_usd_micros:o.captured_usd_micros==null?null:String(o.captured_usd_micros),
    result_ref:o.result_ref??null,error_code:errors.includes(error as OperationView['error_code'])?error as OperationView['error_code']:null};
}
export const commandArgs=(command:BridgeCommand)=>({p_command:command});
