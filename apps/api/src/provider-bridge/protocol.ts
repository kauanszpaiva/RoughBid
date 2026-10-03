/** A signed command is never dispatch authority; the durable database grant is required. */
export const BRIDGE_PATH = '/api/internal/provider-bridge/v1';
export const BRIDGE_DOMAIN = 'roughbid-provider-bridge-v1';
export const BRIDGE_PROTOCOL = 'takeoff-v2.2-durable';
export const PHOTO_BRIDGE_PROTOCOL='photo-complete-v1';
export const BRIDGE_HEADER_NAMES = { timestamp: 'x-rb-bridge-timestamp', nonce: 'x-rb-bridge-nonce', signature: 'x-rb-bridge-signature' } as const;
export interface WorkerProof {
  worker_id: string;
  worker_generation: string;
  lease_id: string;
  /** Positive PostgreSQL bigint serialized without floating-point conversion. */
  fence: string;
}
interface CommandBase { protocol: typeof BRIDGE_PROTOCOL|typeof PHOTO_BRIDGE_PROTOCOL; run_id: string; operation_id: string; worker: WorkerProof }
export type BridgeCommand =
  | (CommandBase & { action: 'submit_stage'; expected_stage_version: number;
      expected_approved_contract_sha256: string; expected_operation_spec_sha256: string })
  | (CommandBase & { action: 'get_operation' | 'reconcile_operation' });
export type OperationState = 'planned' | 'waiting_budget' | 'reserved' | 'dispatching' | 'provider_pending' | 'dispatch_unknown'
  | 'result_pending' | 'completed' | 'failed_final' | 'cancelled_unsent';
export type CostState = 'unreserved' | 'reserved' | 'held_unknown' | 'captured_estimated' | 'released_no_charge';
export type BridgeErrorCode = 'bridge_request_invalid' | 'bridge_body_too_large' | 'bridge_auth_unconfigured'
  | 'bridge_auth_invalid' | 'bridge_auth_expired' | 'bridge_authority_denied' | 'bridge_identity_conflict'
  | 'bridge_adapter_unavailable' | 'bridge_result_unavailable';
export type OperationErrorCode = BridgeErrorCode | 'run_budget_exhausted' | 'company_budget' | 'source_changed' | 'provider_result_uncertain';
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status: number;
  constructor(code: BridgeErrorCode, status: number) { super(code); this.name = 'BridgeError'; this.code = code; this.status = status; }
}
export interface OperationView {
  operation_id: string; state: OperationState; state_version: string; event_id: string;
  operation_spec_sha256: string;
  next_action: 'wait_budget' | 'get_operation' | 'reconcile_only' | 'read_result' | 'none';
  not_before: string | null; reservation_id: string | null; cost_state: CostState;
  captured_usd_micros: string | null; result_ref: string | null; error_code: OperationErrorCode | null;
}
