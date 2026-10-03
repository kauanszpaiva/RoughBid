import { ProjectApiError } from '../projects/service.ts';
import { ProjectPayments, type ServerDatabase } from './project-payments.ts';
import { FULL_CHECKOUT_STRIPE_VERSION } from './full-takeoff-payments.ts';
import { buildPhotoPurchaseContract, validatePhotoPurchaseContract, type PhotoPurchaseContract } from './photo-pricing.ts';
import { photoHash } from '../photos/complete-profile.ts';
import { toPhotoSourceAsset } from '../photos/assets.ts';
import { createPhotoTakeoffQueue, enqueuePhotoRun, type PhotoTakeoffQueue } from '../photos/queue.ts';
import { requirePhotoTakeoffProfile, type PhotoTakeoffProfile } from '../photos/config.ts';
import { isConfiguredValue } from '../ai-plan/readiness.ts';
import type { StripeEvent } from './stripe.ts';
type Env=Record<string,string|undefined>;
export async function startPaidPhotoAfterPayment(db:ServerDatabase,env:Env,quoteId:string):Promise<void>{
 if(!isConfiguredValue(env.REDIS_URL))throw new ProjectApiError(503,'The photo payment is saved; its worker is temporarily unavailable.');
 const profile=requirePhotoTakeoffProfile(env),queue=await createPhotoTakeoffQueue(env.REDIS_URL);
 try{await ensurePaidPhotoRun(db,queue,profile,env,quoteId);}finally{await queue.close?.();}
}
export function photoPaymentValue(result:{data:any;error:any}):any{
 if(result.error?.message==='Photo already belongs to an accepted or paid purchase')throw new ProjectApiError(409,'A selected photo already belongs to an existing purchase. Open it or select only new photos.');
 if(result.error)throw new ProjectApiError(503,'Photo purchase state is temporarily unavailable. Check its saved status before continuing.');return result.data;
}
export function publicPhotoQuote(q:any){const c=q.contract as PhotoPurchaseContract;return {id:q.id,mode:'photo_batch' as const,workspace_id:q.workspace_id,project_id:q.project_id,
 amount_cents:q.amount_cents,currency:q.currency,status:q.status,expires_at:q.expires_at,contract_hash:q.contract_hash,run_id:q.run_id??null,
 consent_confirmed:q.consent?.confirmed===true&&q.consent?.contractHash===q.contract_hash,assets:c.assets,
 summary:{assetIds:c.assets.map(a=>a.id),assetCount:c.assets.length,stages:['observation','reconciliation','risk_review'],
 providers:c.providers.map(p=>({provider:p.provider,models:p.models})),maximumCalls:c.maximumCalls,pricingExpiresAt:c.pricing.expiresAt,executionPolicy:c.executionPolicy}};}
async function load(db:ServerDatabase,id:string,userId?:string,workspaceId?:string,projectId?:string){let query=db.from('photo_reading_quotes').select('*').eq('id',id);
 if(userId)query=query.eq('user_id',userId);if(workspaceId)query=query.eq('workspace_id',workspaceId);if(projectId)query=query.eq('project_id',projectId);
 return photoPaymentValue(await query.maybeSingle());}
export async function savedPhotoQuote(db:ServerDatabase,userId:string,workspaceId:string,projectId:string,quoteId?:string,assetIds?:string[]){
 if(quoteId){const q=await load(db,quoteId,userId,workspaceId,projectId);return q?publicPhotoQuote(q):null;}
 const quotes=photoPaymentValue(await db.from('photo_reading_quotes').select('*').eq('user_id',userId).eq('workspace_id',workspaceId).eq('project_id',projectId).order('created_at',{ascending:false}).limit(100));
 const q=(quotes??[]).find((row:any)=>!assetIds||row.contract.assets.map((a:any)=>a.id).sort().join(',')===[...assetIds].sort().join(','));return q?publicPhotoQuote(q):null;
}
export async function requirePhotoScheduling(db:ServerDatabase,c:PhotoPurchaseContract){
 const p=photoPaymentValue(await db.rpc('paid_full_capacity_policy',{}));
 if(!p||p.enabled!==true||p.call_reservation_usd!==c.pricing.callReservationUsd||!Number.isFinite(p.spend_cap_usd)||p.spend_cap_usd<p.call_reservation_usd
 ||!Number.isFinite(p.rolling_window_seconds)||p.rolling_window_seconds<=0)throw new ProjectApiError(503,'Photo processing capacity is currently unavailable. No payment was started.');
 const capacity=p.window_capacity_usd??p.spend_cap_usd;
 if(typeof capacity!=='number'||!Number.isFinite(capacity)||capacity<0||capacity>p.spend_cap_usd)throw new ProjectApiError(503,'Photo processing capacity is currently unavailable. No payment was started.');
 const capacityMicros=Math.floor(capacity*1e6);
 let available=typeof p.available_usd==='number'&&Number.isFinite(p.available_usd)?Math.floor(Math.max(0,Math.min(capacity,p.available_usd))*1e6):0,windows=0;
 for(const op of c.operations){const reserve=op.reservationUsd;
 if(typeof reserve!=='number'||!Number.isFinite(reserve)||reserve<p.call_reservation_usd||reserve>capacity)throw new ProjectApiError(503,'A photo processing stage exceeds the available capacity. No payment was started.');
 const reserveMicros=Math.round(reserve*1e6);if(available<reserveMicros){windows++;available=capacityMicros;}available-=reserveMicros;}
 if(Date.now()+windows*p.rolling_window_seconds*1000>=Date.parse(c.pricing.expiresAt))throw new ProjectApiError(503,'This batch cannot fit within the reviewed processing period. No payment was started.');
}
type Context={db:ServerDatabase;env:Env;fetcher:typeof fetch;userId:string;workspaceId:string;projectId:string;ready:()=>Promise<void>};
export async function preparePhotoQuote(input:Context&{assets:unknown}){
 const membership=await new ProjectPayments(input.db,input.env,input.fetcher).membership(input.workspaceId);
 const contract=buildPhotoPurchaseContract({...input,membership});await input.ready();await requirePhotoScheduling(input.db,contract);
 const q=photoPaymentValue(await input.db.rpc('create_photo_reading_quote',{p_input:{contract,contract_hash:photoHash(contract)}}));return publicPhotoQuote(q);
}
function sessionMatches(session:any,q:any){return session?.livemode===true&&session.mode==='payment'&&session.amount_total===q.amount_cents&&session.currency===q.currency
 &&session.metadata?.roughbid_mode==='photo_batch'&&session.metadata?.roughbid_photo_quote_id===q.id&&session.metadata?.roughbid_contract_hash===q.contract_hash
 &&session.metadata?.workspace_id===q.workspace_id&&session.metadata?.project_id===q.project_id&&session.client_reference_id===q.user_id;}
export async function openPhotoCheckout(input:Context&{quoteId:string;consent:unknown}){
 const {db,env,fetcher,userId,workspaceId,projectId}=input,q=await load(db,input.quoteId,userId,workspaceId,projectId);
 if(!q)throw new ProjectApiError(404,'Photo purchase not found.');
 if(q.status!=='quoted'||q.livemode!==true||Date.parse(q.expires_at)<=Date.now()+30000)throw new ProjectApiError(409,'Refresh this price or check its saved payment status.');
 const consent=input.consent as any;if(consent?.confirmed!==true||consent.contract_hash!==q.contract_hash)throw new ProjectApiError(400,'Review and explicitly accept this photo purchase before paying.');
 const current=validatePhotoPurchaseContract(q.contract,env);
 if(photoHash(current)!==q.contract_hash||current.userId!==userId||current.workspaceId!==workspaceId||current.projectId!==projectId||q.amount_cents!==current.pricing.amountCents||q.cost_cents!==current.pricing.costCents||q.currency!=='usd')throw new ProjectApiError(409,'The saved photo purchase does not match its price or scope.');
 const assets=photoPaymentValue(await db.from('photo_assets').select('*').eq('workspace_id',workspaceId).eq('project_id',projectId).in('id',current.assets.map(a=>a.id)).eq('status','ready'));
 if(!Array.isArray(assets)||assets.length!==current.assets.length||assets.some(a=>!current.assets.some(expected=>photoHash(expected)===photoHash(toPhotoSourceAsset(a)))))throw new ProjectApiError(409,'A source photo changed. Review the purchase again.');
 const expiry=Date.parse(q.expires_at);
 if(!q.stripe_session_id&&(!Number.isFinite(expiry)||expiry<Date.now()+1800000||expiry>Date.now()+86400000||expiry>=Date.parse(current.pricing.expiresAt)))throw new ProjectApiError(409,'Refresh the photo price before paying.');
 await input.ready();await requirePhotoScheduling(db,current);
 const key=env.STRIPE_SECRET_KEY;let app:URL;try{app=new URL(env.APP_URL??'');}catch{throw new ProjectApiError(503,'Live checkout is not configured.');}
 if(env.PAID_PHOTO_ENABLED!=='true'||env.STRIPE_MODE!=='live'||!/^(?:sk|rk)_live_/.test(key??'')||!env.STRIPE_WEBHOOK_SECRET||!/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_EXPECTED_ACCOUNT_ID??'')||app.protocol!=='https:'||app.username||app.password)throw new ProjectApiError(503,'Live checkout is not configured.');
 const headers={authorization:`Bearer ${key}`,'Stripe-Version':FULL_CHECKOUT_STRIPE_VERSION};
 const response=await fetcher('https://api.stripe.com/v1/account',{headers,redirect:'error',signal:AbortSignal.timeout(10000)}),account=await response.json() as any;
 if(!response.ok||account.id!==env.STRIPE_EXPECTED_ACCOUNT_ID||account.charges_enabled!==true)throw new ProjectApiError(503,'Live checkout is not configured for this application.');
 photoPaymentValue(await db.rpc('accept_photo_reading_quote',{p_quote_id:q.id,p_user_id:userId,p_workspace_id:workspaceId,p_project_id:projectId,p_contract_hash:q.contract_hash}));
 if(q.stripe_session_id){const response=await fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(q.stripe_session_id)}`,{headers,redirect:'error',signal:AbortSignal.timeout(10000)}),session=await response.json() as any;
 if(!response.ok||!sessionMatches(session,q)||session.status!=='open'||typeof session.url!=='string')throw new ProjectApiError(409,'Checkout has closed or changed. Check its saved status.');return {url:session.url};}
 const returnUrl=(payment:string)=>{const url=new URL('/app/',app);for(const[k,v]of Object.entries({payment,reading_mode:'photo_batch',workspace_id:workspaceId,project_id:projectId,photo_quote_id:q.id}))url.searchParams.set(k,v);return url.href;};
 const metadata={roughbid_mode:'photo_batch',roughbid_photo_quote_id:q.id,roughbid_contract_hash:q.contract_hash,workspace_id:workspaceId,project_id:projectId};
 const params=new URLSearchParams({mode:'payment',integration_identifier:'roughbid_photo_qvlnsrta','line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(q.amount_cents),
 'line_items[0][price_data][product_data][name]':`RoughBid — reading of ${current.assets.length} photos`,'line_items[0][quantity]':'1',client_reference_id:userId,
 expires_at:String(Math.floor(expiry/1000)),success_url:returnUrl('returned'),cancel_url:returnUrl('canceled')});
 for(const[k,v]of Object.entries(metadata)){params.set(`metadata[${k}]`,v);params.set(`payment_intent_data[metadata][${k}]`,v);}
 const checkout=await fetcher('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{...headers,'content-type':'application/x-www-form-urlencoded','idempotency-key':`roughbid-photo-${q.id}`},body:params,redirect:'error',signal:AbortSignal.timeout(20000)}),session=await checkout.json() as any;
 if(!checkout.ok||typeof session.id!=='string'||!/^cs_[A-Za-z0-9_]+$/.test(session.id)||typeof session.url!=='string'||!sessionMatches(session,q))throw new ProjectApiError(502,'Could not confirm secure checkout. Retry this saved purchase.');
 photoPaymentValue(await db.rpc('save_photo_reading_session',{p_quote_id:q.id,p_session_id:session.id}));return {url:session.url};
}
export async function ensurePaidPhotoRun(db:ServerDatabase,queue:PhotoTakeoffQueue,profile:PhotoTakeoffProfile,env:Env,quoteId:string,actor?:{userId:string;workspaceId:string;projectId:string}){
 const q=await load(db,quoteId,actor?.userId,actor?.workspaceId,actor?.projectId);if(!q)throw new ProjectApiError(404,'Photo purchase not found.');
 if(!profile.complete||q.status==='revoked'||q.livemode!==true||!q.paid_at||q.consent?.confirmed!==true||q.consent?.contractHash!==q.contract_hash)throw new ProjectApiError(409,'A confirmed photo payment and consent are required.');
 // Completed evidence remains readable after tariff expiry. New dispatch still
 // checks the immutable current profile and the payment revision in SQL.
 if(!q.run_id){const current=validatePhotoPurchaseContract(q.contract,env);if(photoHash(current)!==q.contract_hash||current.profile.profileHash!==profile.profileHash)throw new ProjectApiError(409,'Photo processing needs review. The paid purchase is preserved.');}
 const ready=photoPaymentValue(await db.rpc('photo_takeoff_worker_available',{p_profile_hash:profile.profileHash}));if(ready!==true)throw new ProjectApiError(503,'The durable photo worker is unavailable. Payment is preserved.');
 const saved=photoPaymentValue(await db.rpc('reserve_paid_photo_takeoff',{p_quote_id:q.id}));
 if(saved.run?.status==='queued'||saved.run?.status==='waiting_budget'&&Date.parse(saved.run.not_before)<=Date.now())await enqueuePhotoRun(queue,saved.run.id);
 return {run:{id:saved.run.id,status:saved.run.status,progress:saved.run.progress},reused:saved.reused,enqueued:['queued','waiting_budget'].includes(saved.run.status)};
}
/** Only the signature-verified shared webhook invokes this. */
export async function reconcilePhotoPayment(db:ServerDatabase,event:StripeEvent,start:(quoteId:string)=>Promise<void>,gateway?:{env:Env;fetcher:typeof fetch}):Promise<boolean>{
 if(event.account||event.livemode!==true)return false;let obj=event.data.object as any;
 const checkout=event.type.startsWith('checkout.session.'),revoke=['charge.refunded','charge.dispute.created'].includes(event.type);
 let id=checkout?obj.metadata?.roughbid_photo_quote_id:undefined;
 if(revoke&&typeof obj.payment_intent==='string'){
 const lookup=await db.from('photo_reading_quotes').select('id').eq('stripe_payment_intent',obj.payment_intent).maybeSingle();
 // During the migration rollout an unrelated product must retain its webhook
 // routing. Never swallow a missing table for an explicitly tagged photo event.
 if(!obj.metadata?.roughbid_photo_quote_id&&['42P01','PGRST205'].includes(lookup.error?.code)&&String(lookup.error?.message??'').includes('photo_reading_quotes'))return false;
 const q=photoPaymentValue(lookup);id=q?.id??obj.metadata?.roughbid_photo_quote_id;}
 if(!id&&event.type==='charge.dispute.created'){
 const chargeId=typeof obj.charge==='string'?obj.charge:obj.charge?.id;if(typeof chargeId==='string'&&/^ch_[A-Za-z0-9_]+$/.test(chargeId)){
 const key=gateway?.env.STRIPE_SECRET_KEY;if(!gateway||gateway.env.STRIPE_MODE!=='live'||!/^(?:sk|rk)_live_/.test(key??''))throw new Error('Photo dispute reconciliation unavailable.');
 const response=await gateway.fetcher(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`,{headers:{authorization:`Bearer ${key}`,'Stripe-Version':FULL_CHECKOUT_STRIPE_VERSION},redirect:'error',signal:AbortSignal.timeout(10000)}),charge=await response.json() as any;
 if(!response.ok||charge.id!==chargeId||charge.livemode!==true||typeof charge.payment_intent!=='string'||typeof obj.payment_intent==='string'&&obj.payment_intent!==charge.payment_intent)throw new Error('Photo dispute charge mismatch.');
 obj={...obj,payment_intent:charge.payment_intent,metadata:charge.metadata};id=charge.metadata?.roughbid_photo_quote_id;}}
 if(!id)return false;if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))return true;
 const q=await load(db,id);if(!q)return true;
 if(revoke){if(typeof obj.payment_intent!=='string'||event.type==='charge.refunded'&&!(obj.amount_refunded>0))return true;
 if(q.stripe_payment_intent!==obj.payment_intent&&(q.stripe_payment_intent||!q.stripe_session_id||obj.metadata?.roughbid_mode!=='photo_batch'||obj.metadata?.roughbid_photo_quote_id!==q.id||obj.metadata?.roughbid_contract_hash!==q.contract_hash))return true;
 photoPaymentValue(await db.rpc('close_photo_reading_payment',{p_event_id:event.id,p_quote_id:q.id,p_session_id:q.stripe_session_id,p_payment_intent:obj.payment_intent,p_livemode:true,p_reason:event.type==='charge.refunded'?'refund':'dispute'}));return true;}
 if(!checkout||obj.metadata?.roughbid_mode!=='photo_batch')return true;
 if(q.stripe_session_id!==obj.id||obj.metadata.roughbid_contract_hash!==q.contract_hash||obj.metadata.workspace_id!==q.workspace_id||obj.metadata.project_id!==q.project_id||obj.client_reference_id!==q.user_id)throw new Error('Photo payment event scope mismatch.');
 if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)){photoPaymentValue(await db.rpc('close_photo_reading_payment',{p_event_id:event.id,p_quote_id:q.id,p_session_id:obj.id,p_payment_intent:null,p_livemode:true,p_reason:event.type==='checkout.session.expired'?'expired':'failed'}));return true;}
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)||obj.mode!=='payment'||obj.payment_status!=='paid')return true;
 if(typeof obj.payment_intent!=='string'||!sessionMatches(obj,q))throw new Error('Photo payment amount or mode mismatch.');
 const confirmed=photoPaymentValue(await db.rpc('confirm_photo_reading_payment',{p_event_id:event.id,p_quote_id:q.id,p_session_id:obj.id,p_payment_intent:obj.payment_intent,p_amount:obj.amount_total,p_currency:obj.currency,p_livemode:true}));
 if(confirmed?.status!=='revoked')await start(q.id);return true;
}
