import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { databaseValue, type ServerDatabase } from './project-payments.ts';
import { hashPaidFullContract, validatePaidFullContract, PAID_FULL_EXECUTION_POLICY, type PaidFullContract } from './full-takeoff-pricing.ts';
import { FULL_CHECKOUT_STRIPE_VERSION, preparePaidFullQuote, requirePaidFullBatchScheduling } from './full-takeoff-payments.ts';
import { projectChargeCents, type ProjectMembership } from '../../../../packages/domain/src/project-charge.ts';
import type { AiPlanObjectStorage } from '../ai-plan/service.ts';
import type { StripeEvent } from './stripe.ts';

type Env = Record<string, string | undefined>;
type OrderItem = { quote_id: string; file_id: string; file_sha256: string; full_contract_hash: string; amount_cents: number };
export interface ReadingOrderContract {
  version: 'paid-full-order-v1'; workspace_id: string; project_id: string; user_id: string;
  items: OrderItem[]; executionPolicy: typeof PAID_FULL_EXECUTION_POLICY;
  pricing: { currency: 'usd'; costCents: number; amountCents: number; membership: ProjectMembership;
    marginBps: number; paymentFixedCents: number; paymentFeeBps: number; version: string;
    overheadBaseCents?: number; overheadPageCents?: number; overheadBasePolicy?: 'purchase' };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined)
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashReadingOrder(contract: ReadingOrderContract): string {
  return createHash('sha256').update(canonical(contract)).digest('hex');
}
export function readingOrderFiles(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(id=>typeof id!=='string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) || new Set(value).size !== value.length) {
    throw new ProjectApiError(400, 'Select 1 to 20 different uploaded PDFs.');
  }
  return [...value].sort();
}
/** One fixed payment fee, exact cents allocated by cost using largest remainders. */
export function buildReadingOrderContract(quotes: any[], scope: {workspace_id:string;project_id:string;user_id:string}): ReadingOrderContract {
  if (!quotes.length || quotes.length > 20) throw new ProjectApiError(400, 'Select 1 to 20 PDFs.');
  const sorted = [...quotes].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const p = sorted[0].full_contract.pricing as PaidFullContract['pricing'];
  const first = sorted[0].full_contract as PaidFullContract;
  const same = ['membership','marginBps','paymentFixedCents','paymentFeeBps','version'] as const;
  if (new Set(sorted.map(q=>q.file_sha256)).size !== sorted.length || new Set(sorted.map(q=>q.file_id)).size !== sorted.length) {
    throw new ProjectApiError(409, 'The selection contains the same PDF more than once. Remove its duplicate before paying.');
  }
  if (sorted.some(q=>q.workspace_id!==scope.workspace_id || q.project_id!==scope.project_id || q.user_id!==scope.user_id
    || q.mode!=='full_v2' || q.livemode!==true || q.currency!=='usd' || !Number.isSafeInteger(q.cost_cents) || q.cost_cents<=0
    || !['paid-full-v1','paid-full-v2'].includes(q.full_contract.version) || q.full_contract.version!==first.version
    || q.full_contract.executionPolicy!==PAID_FULL_EXECUTION_POLICY || same.some(key=>q.full_contract.pricing[key]!==p[key])
    || q.full_contract_hash!==hashPaidFullContract(q.full_contract) || q.cost_cents!==q.full_contract.pricing.costCents
    || q.amount_cents!==q.full_contract.pricing.amountCents || q.file_sha256!==q.full_contract.manifest.fileSha256
    || q.page_count!==q.full_contract.manifest.physicalPageCount
    || first.version==='paid-full-v2' && (q.full_contract.policyId!==first.policyId
      || q.full_contract.profile?.profileHash!==first.profile.profileHash || q.full_contract.pricing.callReservationUsd!==first.pricing.callReservationUsd
      || q.full_contract.pricing.overheadBasePolicy!=='purchase'
      || !Number.isSafeInteger(q.full_contract.pricing.overheadBaseCents) || q.full_contract.pricing.overheadBaseCents<0
      || !Number.isSafeInteger(q.full_contract.pricing.overheadPageCents) || q.full_contract.pricing.overheadPageCents<0
      || q.full_contract.pricing.overheadBaseCents!==first.pricing.overheadBaseCents
      || q.full_contract.pricing.overheadPageCents!==first.pricing.overheadPageCents))) {
    throw new ProjectApiError(409, 'The selected PDF prices do not share the current purchase policy. Refresh all prices.');
  }
  const allocationWeightCents=sorted.reduce((sum,q)=>sum+q.cost_cents,0);
  // Each standalone quote includes its base overhead. A v2 purchase applies
  // that frozen base once while retaining the original child allocation weights.
  const costCents=allocationWeightCents-(first.version==='paid-full-v2'?(sorted.length-1)*first.pricing.overheadBaseCents:0);
  if(!Number.isSafeInteger(allocationWeightCents) || !Number.isSafeInteger(costCents) || costCents<=0) {
    throw new ProjectApiError(409, 'The selected PDF prices do not share a valid purchase policy. Refresh all prices.');
  }
  const amountCents=projectChargeCents(costCents,p.paymentFixedCents,p.paymentFeeBps,p.membership);
  const allocation=sorted.map(q=>{const numerator=BigInt(amountCents)*BigInt(q.cost_cents);return {
    q, amount:Number(numerator/BigInt(allocationWeightCents)), remainder:numerator%BigInt(allocationWeightCents)};});
  const remainderOrder=[...allocation].sort((a,b)=>a.remainder>b.remainder?-1:a.remainder<b.remainder?1:a.q.id<b.q.id?-1:1);
  const remaining=amountCents-allocation.reduce((sum,row)=>sum+row.amount,0);
  for(let index=0;index<remaining;index++) remainderOrder[index]!.amount++;
  return {version:'paid-full-order-v1',...scope,executionPolicy:PAID_FULL_EXECUTION_POLICY,
    items:allocation.map(({q,amount})=>({quote_id:q.id,file_id:q.file_id,file_sha256:q.file_sha256,full_contract_hash:q.full_contract_hash,amount_cents:amount})),
    pricing:{currency:'usd',costCents,amountCents,membership:p.membership,marginBps:p.marginBps,
      paymentFixedCents:p.paymentFixedCents,paymentFeeBps:p.paymentFeeBps,version:p.version,
      ...(first.version==='paid-full-v2'?{overheadBaseCents:first.pricing.overheadBaseCents,
        overheadPageCents:first.pricing.overheadPageCents,overheadBasePolicy:'purchase' as const}:{})}};
}
/** Database row order is not execution order. Use the immutable quote-id order
 * for indivisible capacity scheduling and recoverable webhook fanout. */
function quotesInOrder(quotes:any[], contract:ReadingOrderContract):any[] {
  if (!Array.isArray(contract?.items) || contract.items.length!==quotes.length
    || new Set(contract.items.map(item=>item.quote_id)).size!==quotes.length
    || new Set(quotes.map(quote=>quote.id)).size!==quotes.length) throw new ProjectApiError(503,'The saved purchase scope is unavailable.');
  return contract.items.map(item=>{
    const quote=quotes.find(q=>q.id===item.quote_id);
    if(!quote)throw new ProjectApiError(503,'The saved purchase scope is unavailable.');
    return quote;
  });
}
export function readingOrderStatus(order: any, quotes: any[], runs: any[]): string {
  if (order.status==='revoked' || quotes.some(q=>q.status==='revoked')) return 'revoked';
  if (!order.paid_at) return 'quoted';
  if (runs.some(r=>['failed','cancelled'].includes(r.status))) return 'needs_attention';
  if (runs.some(r=>r.status==='processing')) return 'processing';
  if (runs.some(r=>r.status==='waiting_budget')) return 'waiting';
  if (runs.length===quotes.length && runs.every(r=>['needs_review','ready'].includes(r.status))) return 'ready_for_review';
  return 'starting';
}
type Context = { db:ServerDatabase; env:Env; fetcher:typeof fetch; ready:()=>Promise<void> };
async function loadOrder(db:ServerDatabase, id:string, workspaceId?:string, projectId?:string, userId?:string) {
  let query=db.from('full_reading_orders').select('*').eq('id',id);
  if(workspaceId)query=query.eq('workspace_id',workspaceId);
  if(projectId)query=query.eq('project_id',projectId);
  if(userId)query=query.eq('user_id',userId);
  const order=databaseValue(await query.maybeSingle());
  if(!order)return null;
  const items=databaseValue(await db.from('full_reading_order_items').select('*').eq('order_id',order.id));
  if(!Array.isArray(items)||!items.length)throw new ProjectApiError(503,'The saved purchase scope is unavailable.');
  const quotes=databaseValue(await db.from('project_reading_quotes').select('*').in('id',items.map((item:any)=>item.quote_id)));
  if(!Array.isArray(quotes)||quotes.length!==items.length)throw new ProjectApiError(503,'The saved purchase scope is unavailable.');
  return {order,items,quotes:quotesInOrder(quotes,order.contract)};
}
async function presentOrder(db:ServerDatabase, loaded:NonNullable<Awaited<ReturnType<typeof loadOrder>>>) {
  const {order,items,quotes}=loaded;
  const runIds=quotes.map(q=>q.full_run_id).filter(Boolean);
  const runs=runIds.length?databaseValue(await db.from('takeoff_runs').select('id,status,not_before').in('id',runIds)):[];
  return {id:order.id,workspace_id:order.workspace_id,project_id:order.project_id,amount_cents:order.amount_cents,currency:order.currency,
    status:readingOrderStatus(order,quotes,runs),expires_at:order.expires_at,contract_hash:order.contract_hash,
    items:items.map((item:any)=>{const q=quotes.find(q=>q.id===item.quote_id)!; const c=q.full_contract;
      return {quote_id:q.id,file_id:q.file_id,page_count:q.page_count,amount_cents:item.amount_cents,
        status:q.status,full_run_id:q.full_run_id??null,full_contract_hash:q.full_contract_hash,
        full_summary:{physicalPageCount:c.manifest.physicalPageCount,regionGrid:c.regionGrid,stages:c.stages,
          providers:c.providers.map((p:any)=>({provider:p.provider,models:p.models,maximumCalls:p.maximumCalls})),
          maximumCalls:c.maximumCalls,executionPolicy:c.executionPolicy,pricingVersion:c.pricing.version,pricingExpiresAt:c.pricing.expiresAt}};})};
}
export async function savedReadingOrder(db:ServerDatabase,userId:string,workspaceId:string,projectId:string,orderId?:string,fileIds?:unknown,containsFileId?:string) {
  if(orderId){const loaded=await loadOrder(db,orderId,workspaceId,projectId,userId);return loaded?presentOrder(db,loaded):null;}
  const files=containsFileId?readingOrderFiles([containsFileId]):readingOrderFiles(fileIds);
  const candidates=databaseValue(await db.from('full_reading_orders').select('*').eq('workspace_id',workspaceId)
    .eq('project_id',projectId).eq('user_id',userId).eq('livemode',true).order('created_at',{ascending:false}).limit(100));
  for(const order of candidates??[]) {
    const selected=order.contract?.items?.map((i:any)=>i.file_id).sort();
    if(Array.isArray(selected)&&(containsFileId ? !!order.paid_at&&selected.includes(containsFileId) : selected.join(',')===files.join(','))) {
      const loaded=await loadOrder(db,order.id,workspaceId,projectId,userId);if(loaded)return presentOrder(db,loaded);
    }
  }
  return null;
}
export async function prepareReadingOrder(input:Context&{userId:string;workspaceId:string;projectId:string;fileIds:unknown;
  storage:AiPlanObjectStorage;membership:()=>Promise<ProjectMembership>}) {
  const files=readingOrderFiles(input.fileIds);
  const existing=await savedReadingOrder(input.db,input.userId,input.workspaceId,input.projectId,undefined,files);
  if(existing && existing.status!=='revoked' && (existing.status!=='quoted'||Date.parse(existing.expires_at)>Date.now()+31*60_000))return existing;
  const quotes=[];
  for(const fileId of files) quotes.push(await preparePaidFullQuote({...input,fileId,newOrderChild:true}));
  const contract=buildReadingOrderContract(quotes,{workspace_id:input.workspaceId,project_id:input.projectId,user_id:input.userId});
  await requirePaidFullBatchScheduling(input.db,quotesInOrder(quotes,contract).map(q=>q.full_contract));
  const order=databaseValue(await input.db.rpc('create_full_reading_order',{p_input:{workspace_id:input.workspaceId,
    project_id:input.projectId,user_id:input.userId,contract,contract_hash:hashReadingOrder(contract)}}));
  const loaded=await loadOrder(input.db,order.id,input.workspaceId,input.projectId,input.userId);
  if(!loaded)throw new ProjectApiError(503,'Unable to load the saved purchase.');
  return presentOrder(input.db,loaded);
}
export async function openReadingOrderCheckout(input:Context&{userId:string;workspaceId:string;projectId:string;orderId:string;consent:unknown}) {
  const {db,env,fetcher,userId,workspaceId,projectId}=input;
  const loaded=await loadOrder(db,input.orderId,workspaceId,projectId,userId);
  if(!loaded)throw new ProjectApiError(404,'Purchase not found.');
  const {order,quotes,items}=loaded;
  if(env.PAID_FULL_ENABLED!=='true'||env.STRIPE_MODE!=='live'||!order.livemode||order.status!=='quoted'
    || Date.parse(order.expires_at)<=Date.now()+30_000)throw new ProjectApiError(409,'Refresh this purchase or check its payment status.');
  const consent=input.consent as any;
  if(consent?.confirmed!==true||consent.contract_hash!==order.contract_hash)throw new ProjectApiError(400,'Review and explicitly accept this purchase before paying.');
  const workspace=databaseValue(await db.from('workspaces').select('ai_processing_consented_at').eq('id',workspaceId).maybeSingle());
  if(!workspace?.ai_processing_consented_at)throw new ProjectApiError(403,'Workspace AI processing consent is required before purchasing a reading.');
  for(const q of quotes){const current=validatePaidFullContract(q.full_contract,env);
    if(q.purchase_order_id!==order.id||q.status!=='quoted'||q.stripe_session_id||q.payment_intent_id||q.full_run_id
      ||hashPaidFullContract(current)!==q.full_contract_hash||q.amount_cents!==current.pricing.amountCents
      ||q.cost_cents!==current.pricing.costCents||q.file_sha256!==current.manifest.fileSha256||q.page_count!==current.manifest.physicalPageCount) {
      throw new ProjectApiError(409,'The saved purchase does not match its PDF execution contracts.');
    }
  }
  const rebuilt=buildReadingOrderContract(quotes,{workspace_id:workspaceId,project_id:projectId,user_id:userId});
  if(hashReadingOrder(rebuilt)!==order.contract_hash||hashReadingOrder(order.contract)!==order.contract_hash
    ||order.amount_cents!==rebuilt.pricing.amountCents||order.cost_cents!==rebuilt.pricing.costCents||order.currency!=='usd'
    ||items.some((item:any)=>{const expected=rebuilt.items.find(i=>i.quote_id===item.quote_id);return !expected||Object.entries(expected).some(([k,v])=>item[k]!==v);})) {
    throw new ProjectApiError(409,'The selected files or price changed. Review the purchase again.');
  }
  const expiry=Date.parse(order.expires_at);
  if(!order.stripe_session_id&&(!Number.isFinite(expiry)||expiry<Date.now()+30*60_000||expiry>Date.now()+24*60*60_000
    ||quotes.some(q=>expiry>=Date.parse(q.full_contract.pricing.expiresAt))))throw new ProjectApiError(409,'Refresh the purchase price before paying.');
  await input.ready();
  await requirePaidFullBatchScheduling(db,quotes.map(q=>q.full_contract));
  const key=env.STRIPE_SECRET_KEY;
  let appUrl:URL;try{appUrl=new URL(env.APP_URL??'');}catch{throw new ProjectApiError(503,'Checkout is not configured.');}
  if(!/^(?:sk|rk)_live_/.test(key??'')||!env.STRIPE_WEBHOOK_SECRET||!/^acct_[A-Za-z0-9]+$/.test(env.STRIPE_EXPECTED_ACCOUNT_ID??'')
    ||appUrl.protocol!=='https:'||appUrl.username||appUrl.password)throw new ProjectApiError(503,'Live checkout is not configured.');
  const headers={authorization:`Bearer ${key}`,'Stripe-Version':FULL_CHECKOUT_STRIPE_VERSION};
  const accountResponse=await fetcher('https://api.stripe.com/v1/account',{headers,signal:AbortSignal.timeout(10000),redirect:'error'});
  const account=await accountResponse.json() as any;
  if(!accountResponse.ok||account.id!==env.STRIPE_EXPECTED_ACCOUNT_ID||account.charges_enabled!==true)throw new ProjectApiError(503,'Live checkout is not configured for this application.');
  databaseValue(await db.rpc('accept_full_reading_order',{p_order_id:order.id,p_user_id:userId,p_workspace_id:workspaceId,p_project_id:projectId,p_contract_hash:order.contract_hash}));
  if(order.stripe_session_id){
    const response=await fetcher(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(order.stripe_session_id)}`,{headers,redirect:'error'});
    const session=await response.json() as any;
    if(!response.ok||session.status!=='open'||!session.url||session.livemode!==true||session.mode!=='payment'
      ||session.amount_total!==order.amount_cents||session.currency!==order.currency||session.metadata?.roughbid_order_id!==order.id
      ||session.metadata?.roughbid_contract_hash!==order.contract_hash)throw new ProjectApiError(409,'Checkout has closed or changed. Check the saved purchase status.');
    return {url:session.url as string};
  }
  const returnUrl=(payment:string)=>{const url=new URL('/app/',appUrl);for(const[k,v]of Object.entries({payment,reading_mode:'full_order',workspace_id:workspaceId,project_id:projectId,order_id:order.id}))url.searchParams.set(k,v);return url.href;};
  const params=new URLSearchParams({mode:'payment',integration_identifier:'roughbid_full_order_qvlnsrta',
    'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(order.amount_cents),
    'line_items[0][price_data][product_data][name]':`RoughBid — ${quotes.length} PDFs, ${quotes.reduce((sum,q)=>sum+q.page_count,0)} pages`,'line_items[0][quantity]':'1',
    'metadata[roughbid_order_id]':order.id,'metadata[roughbid_mode]':'full_order','metadata[roughbid_contract_hash]':order.contract_hash,
    'metadata[workspace_id]':workspaceId,'metadata[project_id]':projectId,
    'payment_intent_data[metadata][roughbid_order_id]':order.id,'payment_intent_data[metadata][roughbid_mode]':'full_order',
    'payment_intent_data[metadata][roughbid_contract_hash]':order.contract_hash,client_reference_id:userId,
    expires_at:String(Math.floor(expiry/1000)),success_url:returnUrl('returned'),cancel_url:returnUrl('canceled')});
  const response=await fetcher('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{...headers,
    'content-type':'application/x-www-form-urlencoded','idempotency-key':`roughbid-full-order-${order.id}`},body:params,redirect:'error'});
  const session=await response.json() as any;
  if(!response.ok||!session.id||!session.url)throw new ProjectApiError(502,'Could not open secure checkout. Please try again.');
  databaseValue(await db.rpc('save_full_reading_order_session',{p_order_id:order.id,p_session_id:session.id}));
  return {url:session.url as string};
}
/** Called only after the shared endpoint verifies the Stripe signature. GET never calls this. */
export async function reconcileReadingOrder(db:ServerDatabase,event:StripeEvent,start:(quoteId:string)=>Promise<void>,
  gateway?:{env:Env;fetcher:typeof fetch}):Promise<boolean> {
  if(event.account||event.livemode!==true)return false;
  let obj=event.data.object as any;
  const isCheckout=event.type.startsWith('checkout.session.');
  const isRevoke=['charge.refunded','charge.dispute.created'].includes(event.type);
  let orderId=isCheckout?obj.metadata?.roughbid_order_id:undefined;
  if(isRevoke&&typeof obj.payment_intent==='string') {
    const found=databaseValue(await db.from('full_reading_orders').select('id').eq('stripe_payment_intent',obj.payment_intent).maybeSingle());
    orderId=found?.id??obj.metadata?.roughbid_order_id;
  }
  // A Dispute does not inherit PaymentIntent metadata. Stripe may deliver it
  // before payment confirmation; resolve its Charge rather than acknowledging
  // an unlinked revocation that a later paid event could silently undo.
  if(!orderId&&event.type==='charge.dispute.created') {
    const chargeId=typeof obj.charge==='string'?obj.charge:obj.charge?.id;
    if(typeof chargeId==='string'&&/^ch_[A-Za-z0-9_]+$/.test(chargeId)) {
      const key=gateway?.env.STRIPE_SECRET_KEY;
      if(!gateway||gateway.env.STRIPE_MODE!=='live'||!/^(?:sk|rk)_live_/.test(key??''))throw new Error('Dispute reconciliation is temporarily unavailable.');
      const response=await gateway.fetcher(`https://api.stripe.com/v1/charges/${encodeURIComponent(chargeId)}`,{
        headers:{authorization:`Bearer ${key}`,'Stripe-Version':FULL_CHECKOUT_STRIPE_VERSION},redirect:'error',signal:AbortSignal.timeout(10000)});
      const charge=await response.json() as any;
      if(!response.ok||charge.id!==chargeId||charge.livemode!==true||typeof charge.payment_intent!=='string'
        ||typeof obj.payment_intent==='string'&&obj.payment_intent!==charge.payment_intent)throw new Error('Dispute charge does not match its signed event.');
      obj={...obj,payment_intent:charge.payment_intent,metadata:charge.metadata};
      const found=databaseValue(await db.from('full_reading_orders').select('id').eq('stripe_payment_intent',obj.payment_intent).maybeSingle());
      orderId=found?.id??obj.metadata?.roughbid_order_id;
    }
  }
  if(!orderId)return false;
  const loaded=await loadOrder(db,orderId);if(!loaded)return true;
  const {order,quotes}=loaded;
  if(event.livemode!==true||order.livemode!==true)return true;
  if(isRevoke){
    if(typeof obj.payment_intent!=='string'||(event.type==='charge.refunded'&&!(obj.amount_refunded>0)))return true;
    const boundIntent=order.stripe_payment_intent===obj.payment_intent;
    if(!boundIntent&&(order.stripe_payment_intent||!order.stripe_session_id||obj.metadata?.roughbid_mode!=='full_order'
      ||obj.metadata?.roughbid_contract_hash!==order.contract_hash||obj.metadata?.roughbid_order_id!==order.id))return true;
    databaseValue(await db.rpc('close_full_reading_order_payment',{p_event_id:event.id,p_order_id:order.id,p_session_id:order.stripe_session_id,
      p_payment_intent:obj.payment_intent,p_livemode:true,p_reason:event.type==='charge.refunded'?'refund':'dispute'}));return true;
  }
  if(!isCheckout||obj.metadata?.roughbid_mode!=='full_order')return true;
  if(order.stripe_session_id!==obj.id||order.contract_hash!==obj.metadata.roughbid_contract_hash
    ||order.workspace_id!==obj.metadata.workspace_id||order.project_id!==obj.metadata.project_id||order.user_id!==obj.client_reference_id)throw new Error('Reading order event does not match its saved purchase.');
  if(['checkout.session.expired','checkout.session.async_payment_failed'].includes(event.type)) {
    databaseValue(await db.rpc('close_full_reading_order_payment',{p_event_id:event.id,p_order_id:order.id,p_session_id:obj.id,
      p_payment_intent:null,p_livemode:true,p_reason:event.type==='checkout.session.expired'?'expired':'failed'}));return true;
  }
  if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type)||obj.mode!=='payment'||obj.payment_status!=='paid')return true;
  if(typeof obj.payment_intent!=='string'||obj.amount_total!==order.amount_cents||typeof obj.currency!=='string'
    ||obj.currency.trim().toLowerCase()!==order.currency)throw new Error('Reading order payment amount does not match its purchase.');
  const confirmed=databaseValue(await db.rpc('confirm_full_reading_order_payment',{p_event_id:event.id,p_order_id:order.id,p_session_id:obj.id,
    p_payment_intent:obj.payment_intent,p_amount:obj.amount_total,p_currency:obj.currency.trim().toLowerCase(),p_livemode:true}));
  if(confirmed?.status==='revoked')return true;
  // A partial enqueue failure makes the webhook retry. Each child owns its
  // immutable quote/run identity, so already queued siblings are not duplicated.
  for(const q of quotes)await start(q.id);
  return true;
}
