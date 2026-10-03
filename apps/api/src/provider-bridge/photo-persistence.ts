import type { BridgeOperation } from './persistence.ts';
import type { CompletePhotoProfile,PhotoOperation } from '../photos/complete-profile.ts';
import type { PhotoSourceAsset,PhotoDimensionReference } from '../photo-evidence.ts';
export interface PhotoBridgeSpec{
  schema_version:1;protocol:'photo-complete-v1';stage_version:1;authorized_attempt:1;run_id:string;workspace_id:string;project_id:string;user_id:string;
  operation_key:string;operation:PhotoOperation;assets:PhotoSourceAsset[];profile:CompletePhotoProfile;approved_contract:unknown;
  references:PhotoDimensionReference[];previous_stage_keys:string[];
}
export interface PhotoBridgeOperation extends Omit<BridgeOperation,'spec'>{spec:PhotoBridgeSpec}
export interface PhotoBridgeAuthorization{replay:boolean;operation:PhotoBridgeOperation;run:{workspace_id:string;project_id:string;requested_by:string;
  manifest:{assets:PhotoSourceAsset[];profile:CompletePhotoProfile;operations:PhotoOperation[];references?:PhotoDimensionReference[];
    includedAuthorization?:unknown;purchaseContractHash?:string};photo_quote_id:string|null;payment_revision:number|null}}
