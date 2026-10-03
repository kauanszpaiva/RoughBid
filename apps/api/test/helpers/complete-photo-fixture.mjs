import {createHash} from 'node:crypto';
import {USER,WORKSPACE,PROJECT,PHOTO,PNG} from './photo-db.mjs';
import {photoStoragePath,toPhotoSourceAsset} from '../../src/photos/assets.ts';
import {buildPhotoPurchaseContract} from '../../src/billing/photo-pricing.ts';
import {photoHash} from '../../src/photos/complete-profile.ts';
import {requirePhotoTakeoffConfig} from '../../src/photos/config.ts';
// Synthetic pricing is confined to isolated tests; it is not a real tariff attestation.
export function completePhotoEnvironment(){
 const route={provider:'openai',model:'gpt-6-astra',accountVerified:true,imageCompatibilityVerified:true,priceVersion:'synthetic-test-only',maximumCallCostUsd:1,
 requestPolicy:{serviceTier:'default',promptCacheMode:'explicit'},reasoningEffort:'max',maxOutputTokens:64000,timeoutMs:10000,tariff:{standardUncached:true,reasoningIncluded:true,maximumAcceptedInput:true,inputUsdPerMillion:0.1,outputUsdPerMillion:0.1,inputTokenLimit:1048576,outputTokenLimit:65536,
 additionalRequestUsd:0,source:'https://openai.com/api/pricing/',verifiedAt:'2026-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'}};
 return {PHOTO_TAKEOFF_ENABLED:'true',PHOTO_TAKEOFF_SCHEMA_VERSION:'photo-takeoff-v1',PHOTO_COMPLETE_ENABLED:'true',PRIVATE_PHOTO_DATA_APPROVED:'true',
 PHOTO_COMPLETE_PROFILE_JSON:JSON.stringify({version:'photo-complete-v1',maximumContextBytes:1000000,routes:{observation:route,reconciliation:route,risk_review:route}}),
 OPENAI_API_KEY:'local-synthetic',PHOTO_TAKEOFF_APPROVED_RUN_BUDGET_USD:'110',PHOTO_TAKEOFF_RUN_BUDGET_APPROVAL_REF:'synthetic-test-only',
 PAID_PHOTO_ENABLED:'true',STRIPE_MODE:'live',TAKEOFF_V2_CALL_RESERVATION_USD:'2.50',PAID_PHOTO_MAXIMUM_RESERVE_USD:'110',PAID_PHOTO_MAXIMUM_CALLS:'44',
 PROJECT_PAYMENT_FIXED_CENTS:'30',PROJECT_PAYMENT_FEE_BPS:'290',PAID_PHOTO_BATCH_OVERHEAD_CENTS:'0',PAID_PHOTO_ASSET_OVERHEAD_CENTS:'0',PAID_PHOTO_PRICING_VERSION:'synthetic-test-only',
 STRIPE_SECRET_KEY:'rk_live_synthetic_only',STRIPE_WEBHOOK_SECRET:'synthetic-only',STRIPE_EXPECTED_ACCOUNT_ID:'acct_test',APP_URL:'https://roughbid.invalid'};
}
export async function seedCompletePhoto(fixture,env=completePhotoEnvironment()){
 const sha=createHash('sha256').update(PNG).digest('hex');
 await fixture.sql.query(`insert into photo_assets(id,workspace_id,project_id,uploaded_by,storage_path,original_name,mime_type,byte_size)values($1,$2,$3,$4,$5,'synthetic.png','image/png',$6)`,[PHOTO,WORKSPACE,PROJECT,USER,photoStoragePath(WORKSPACE,PROJECT,PHOTO,'image/png'),PNG.length]);
 await fixture.sql.query(`update photo_assets set status='ready',sha256=$1,width_pixels=1,height_pixels=1,completed_at=now()where id=$2`,[sha,PHOTO]);
 const row=(await fixture.sql.query('select * from photo_assets where id=$1',[PHOTO])).rows[0],asset=toPhotoSourceAsset(row),config=requirePhotoTakeoffConfig(env);
 await fixture.sql.query('select touch_photo_takeoff_worker($1,$2,$3)',['synthetic-worker',config.profileHash,'photo-takeoff-v1']);
 const contract=buildPhotoPurchaseContract({assets:[asset],workspaceId:WORKSPACE,projectId:PROJECT,userId:USER,membership:'standard',env});
 return {asset,config,contract,env};
}
export const scalar=async(sql,query,args=[])=>Object.values((await sql.query(query,args)).rows[0])[0];
export const createPhotoQuote=(sql,c)=>scalar(sql,'select create_photo_reading_quote($1)',[JSON.stringify({contract:c,contract_hash:photoHash(c)})]);
export async function payPhotoQuote(sql,c){
 let q=await createPhotoQuote(sql,c);q=await scalar(sql,'select accept_photo_reading_quote($1,$2,$3,$4,$5)',[q.id,USER,WORKSPACE,PROJECT,q.contract_hash]);
 q=await scalar(sql,'select save_photo_reading_session($1,$2)',[q.id,'cs_synthetic']);
 return scalar(sql,'select confirm_photo_reading_payment($1,$2,$3,$4,$5,$6,true)',['evt_synthetic',q.id,q.stripe_session_id,'pi_synthetic',q.amount_cents,'usd']);
}
export function syntheticPhotoObservation(assetId){return {quality:{usable:true,limitations:[],additionalViewsNeeded:false},blockers:[],observations:[{
 id:assetId+':wall',label:'Visible wall',regions:[{sourceAssetId:assetId,surfaceKey:'wall',bbox:[0,0,1,1]}],proposedQuantity:null,proposedUnit:null,referenceId:null,
 method:'visual_estimate',confidence:0.8,uncertainty:['A verified dimension is required.']}]};}
