import { projectChargeCents, PROJECT_MARGIN_BPS, type ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import { ProjectApiError } from '../projects/service.ts';
import { validatePhotoAssets, type PhotoSourceAsset } from '../photo-evidence.ts';
import { PHOTO_COMPLETE_VERSION, PHOTO_EXECUTION_POLICY, assertCompletePhotoPayload, photoHash, planCompletePhotoOperations,
  requireCompletePhotoProfile, type CompletePhotoProfile, type PhotoOperation } from '../photos/complete-profile.ts';
export interface PhotoPurchaseContract {
  version:'paid-photo-v1';executionPolicy:typeof PHOTO_EXECUTION_POLICY;workspaceId:string;projectId:string;userId:string;
  assets:readonly PhotoSourceAsset[];operations:PhotoOperation[];profile:CompletePhotoProfile;maximumCalls:number;
  providers:Array<{provider:string;models:string[];maximumCalls:number;approvedUsd:number}>;
  pricing:{version:string;currency:'usd';costCents:number;amountCents:number;membership:ProjectMembership;marginBps:number;
    paymentFixedCents:number;paymentFeeBps:number;overheadBatchCents:number;overheadAssetCents:number;providerCostUpperBoundUsd:number;operatingReserveUsd:number;callReservationUsd:number;expiresAt:string};
}
const unavailable=():never=>{throw new ProjectApiError(503,'Photo reading prices are temporarily unavailable. Please contact support. No payment was started.');};
const micros=(n:number)=>Math.round(n*1e6);
const validMoney=(n:number)=>Number.isFinite(n)&&n>0&&Number.isSafeInteger(micros(n))&&Math.abs(n*1e6-micros(n))<.000001;
const sumMoney=(values:number[])=>{const total=values.reduce((sum,n)=>sum+micros(n),0);if(!Number.isSafeInteger(total))return unavailable();return total;};
const integer=(env:Record<string,string|undefined>,key:string,max:number)=>{const s=env[key];if(!s||!/^\d+$/.test(s))return unavailable();const n=Number(s);if(!Number.isSafeInteger(n)||n<0||n>max)return unavailable();return n;};
export function buildPhotoPurchaseContract(input:{assets:unknown;workspaceId:string;projectId:string;userId:string;membership:ProjectMembership;env:Record<string,string|undefined>},now=Date.now()):PhotoPurchaseContract{
  if(input.env.PAID_PHOTO_ENABLED!=='true'||input.env.STRIPE_MODE!=='live')return unavailable();
  const profile=requireCompletePhotoProfile(input.env,now),assets=validatePhotoAssets(input.assets,input);
  const reservation=Number(input.env.TAKEOFF_V2_CALL_RESERVATION_USD),maximumReserve=Number(input.env.PAID_PHOTO_MAXIMUM_RESERVE_USD);
  if(!validMoney(reservation)||!validMoney(maximumReserve)||maximumReserve>100_000)return unavailable();
  const operations=planCompletePhotoOperations(assets,profile,reservation),operatingReserveMicros=sumMoney(operations.map(op=>op.reservationUsd!)),operatingReserveUsd=operatingReserveMicros/1e6;
  assertCompletePhotoPayload(profile,assets,operations);
  const maxCalls=integer(input.env,'PAID_PHOTO_MAXIMUM_CALLS',10000),fixed=integer(input.env,'PROJECT_PAYMENT_FIXED_CENTS',1_000_000),fee=integer(input.env,'PROJECT_PAYMENT_FEE_BPS',4999);
  const overheadBatchCents=integer(input.env,'PAID_PHOTO_BATCH_OVERHEAD_CENTS',1_000_000),overheadAssetCents=integer(input.env,'PAID_PHOTO_ASSET_OVERHEAD_CENTS',1_000_000),version=input.env.PAID_PHOTO_PRICING_VERSION;
  if(!version||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{1,119}$/.test(version)||!Number.isFinite(reservation)||reservation<=0
    ||!Number.isFinite(maximumReserve)||maximumReserve<=0||operations.length>maxCalls||operatingReserveUsd>maximumReserve)return unavailable();
  const providerCostMicros=sumMoney(operations.map(operation=>profile.routes[operation.stage].maximumCallCostUsd)),providerCostUpperBoundUsd=providerCostMicros/1e6;
  const costCents=Math.ceil(providerCostMicros/10000)+overheadBatchCents+assets.length*overheadAssetCents,amountCents=projectChargeCents(costCents,fixed,fee,input.membership);
  const providers=[...new Set(operations.map(op=>profile.routes[op.stage].provider))].sort().map(provider=>{
    const selected=operations.filter(op=>profile.routes[op.stage].provider===provider);return {provider,models:[...new Set(selected.map(op=>profile.routes[op.stage].model))].sort(),maximumCalls:selected.length,approvedUsd:sumMoney(selected.map(op=>op.reservationUsd!))/1e6};});
  return {version:'paid-photo-v1',executionPolicy:PHOTO_EXECUTION_POLICY,workspaceId:input.workspaceId,projectId:input.projectId,userId:input.userId,
    assets,operations,profile,maximumCalls:operations.length,providers,pricing:{version,currency:'usd',costCents,amountCents,membership:input.membership,
      marginBps:PROJECT_MARGIN_BPS[input.membership],paymentFixedCents:fixed,paymentFeeBps:fee,overheadBatchCents,overheadAssetCents,providerCostUpperBoundUsd,
      operatingReserveUsd,callReservationUsd:reservation,expiresAt:profile.expiresAt}};
}
export function validatePhotoPurchaseContract(contract:PhotoPurchaseContract,env:Record<string,string|undefined>,now=Date.now()):PhotoPurchaseContract{
  const current=buildPhotoPurchaseContract({assets:contract.assets,workspaceId:contract.workspaceId,projectId:contract.projectId,userId:contract.userId,membership:contract.pricing.membership,env},now);
  if(photoHash(contract)!==photoHash(current))throw new ProjectApiError(409,'The saved photo scope or processing policy changed. Review a new price before paying.');
  return current;
}
export function photoCompleteManifest(contract:PhotoPurchaseContract){return {completeVersion:PHOTO_COMPLETE_VERSION,assets:contract.assets,references:[],operations:contract.operations,
  profile:contract.profile,executionPolicy:contract.executionPolicy,maximumCalls:contract.maximumCalls,providers:contract.providers,
  callReservationUsd:contract.pricing.callReservationUsd,expiresAt:contract.pricing.expiresAt};}
