import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingOrderContract,hashReadingOrder,readingOrderFiles,readingOrderStatus,openReadingOrderCheckout,savedReadingOrder,reconcileReadingOrder } from '../src/billing/full-reading-orders.ts';
import { buildPaidFullContract,hashPaidFullContract } from '../src/billing/full-takeoff-pricing.ts';
import { pricingEnv,testManifest } from './full-takeoff-pricing.test.ts';
import { projectChargeCents } from '../../../packages/domain/src/project-charge.ts';

function fixture() {
  const env={...pricingEnv(),PROJECT_PAYMENT_FIXED_CENTS:'30',PROJECT_PAYMENT_FEE_BPS:'290',STRIPE_SECRET_KEY:'rk_live_fixture',
    STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_EXPECTED_ACCOUNT_ID:'acct_fixture',APP_URL:'https://roughbid.test'};
  const scope={workspace_id:'workspace',project_id:'project',user_id:'user'};
  const quotes=[1,2].map(n=>{const manifest=testManifest(n);manifest.fileSha256=String(n).repeat(64);
    const full_contract=buildPaidFullContract({manifest,membership:'standard',env});
    return {id:`quote-${n}`,file_id:`00000000-0000-4000-8000-00000000000${n}`,...scope,mode:'full_v2',livemode:true,currency:'usd',status:'quoted',
      full_contract,full_contract_hash:hashPaidFullContract(full_contract),cost_cents:full_contract.pricing.costCents,amount_cents:full_contract.pricing.amountCents,
      file_sha256:manifest.fileSha256,page_count:n,purchase_order_id:'order',full_run_id:null};});
  const contract=buildReadingOrderContract(quotes,scope);
  const order:any={id:'order',...scope,contract,contract_hash:hashReadingOrder(contract),amount_cents:contract.pricing.amountCents,
    cost_cents:contract.pricing.costCents,currency:'usd',status:'quoted',livemode:true,expires_at:new Date(Date.now()+3600_000).toISOString(),paid_at:null};
  const items=contract.items.map(item=>({...item,order_id:order.id}));
  const runs:any[]=[]; const calls:Array<{fn:string;args:any}>=[];const requests:Array<{url:string;init?:RequestInit}>=[];
  const db={from(table:string){const filters:Array<(row:any)=>boolean>=[];let single=false;
    const query:any={select:()=>query,eq:(key:string,value:any)=>{filters.push(row=>row[key]===value);return query;},
      in:(key:string,value:any[])=>{filters.push(row=>value.includes(row[key]));return query;},order:()=>query,limit:()=>query,
      maybeSingle:()=>{single=true;return query;},then:(resolve:any,reject:any)=>{
        const tableRows=table==='full_reading_orders'?[order]:table==='full_reading_order_items'?items:table==='project_reading_quotes'?quotes:
          table==='workspaces'?[{id:'workspace',ai_processing_consented_at:'2026-10-01'}]:table==='takeoff_runs'?runs:[];
        const rows=tableRows.filter(row=>filters.every(filter=>filter(row)));
        return Promise.resolve({data:single?rows[0]??null:rows,error:null}).then(resolve,reject);}};return query;},
    async rpc(fn:string,args:any){calls.push({fn,args});return {data:fn==='paid_full_capacity_policy'?{
      enabled:true,spend_cap_usd:25,rolling_window_seconds:86400,call_reservation_usd:2.5}:order,error:null};}};
  const fetcher=(async(url:any,init?:RequestInit)=>{requests.push({url:String(url),init});
    if(String(url).endsWith('/account'))return Response.json({id:'acct_fixture',charges_enabled:true});
    return Response.json({id:'cs_order',url:'https://checkout.stripe.com/fixture'});}) as typeof fetch;
  const input={db,env,fetcher,ready:async()=>{},userId:'user',workspaceId:'workspace',projectId:'project',orderId:order.id,
    consent:{confirmed:true,contract_hash:order.contract_hash}};
  return {env,scope,quotes,contract,order,items,runs,db,calls,requests,input};
}
test('batch charges one fixed fee and allocates exact cents deterministically without duplicated files',()=>{
  const f=fixture(),p=f.contract.pricing;
  assert.equal(p.amountCents,projectChargeCents(p.costCents,30,290,'standard'));
  assert.ok(p.amountCents<f.quotes.reduce((s,q)=>s+q.amount_cents,0));
  assert.equal(f.contract.items.reduce((s,i)=>s+i.amount_cents,0),p.amountCents);
  assert.deepEqual(buildReadingOrderContract([...f.quotes].reverse(),f.scope),f.contract);
  assert.equal(hashReadingOrder(JSON.parse(JSON.stringify(f.contract,(key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value))),hashReadingOrder(f.contract));
  assert.throws(()=>buildReadingOrderContract([f.quotes[0],{...f.quotes[1],file_sha256:f.quotes[0]!.file_sha256}],f.scope),/same PDF/);
  assert.throws(()=>buildReadingOrderContract([{...f.quotes[0],user_id:'other'}],f.scope),/policy/);
  for(const files of [[],[f.quotes[0]!.file_id,f.quotes[0]!.file_id],['bad'],Array(21).fill('bad')])assert.throws(()=>readingOrderFiles(files));
});
test('one order checkout binds one Stripe payment to all PDFs and consent before Stripe POST',async()=>{
  const f=fixture();await openReadingOrderCheckout(f.input);
  assert.deepEqual(f.calls.map(c=>c.fn),['paid_full_capacity_policy','accept_full_reading_order','save_full_reading_order_session']);
  assert.equal(f.requests.length,2);
  const init=f.requests[1]!.init!,params=init.body as URLSearchParams;
  assert.equal(params.get('line_items[0][price_data][unit_amount]'),String(f.order.amount_cents));
  assert.equal(params.get('metadata[roughbid_order_id]'),'order');assert.equal(params.has('metadata[roughbid_quote_id]'),false);
  assert.equal(new Headers(init.headers).get('idempotency-key'),'roughbid-full-order-order');
  for(const key of ['success_url','cancel_url']){const url=new URL(params.get(key)!);assert.equal(url.searchParams.get('reading_mode'),'full_order');
    assert.equal(url.searchParams.get('order_id'),'order');assert.equal(url.searchParams.get('workspace_id'),'workspace');}
});
test('batch mismatch and stale consent fail before accepting holds or opening payment',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.input.consent.confirmed=false;},
    (f:ReturnType<typeof fixture>)=>{f.order.amount_cents++;},(f:ReturnType<typeof fixture>)=>{f.items[0]!.amount_cents++;},
    (f:ReturnType<typeof fixture>)=>{f.quotes[0]!.purchase_order_id='other';},(f:ReturnType<typeof fixture>)=>{f.order.user_id='other';},
    (f:ReturnType<typeof fixture>)=>{f.order.expires_at=new Date(Date.now()+15*60_000).toISOString();}]){
    const f=fixture();mutate(f);await assert.rejects(openReadingOrderCheckout(f.input));assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
  }
});
test('saved order and aggregate status are GET-only and never sum unverified physical quantities',async()=>{
  const f=fixture();assert.equal((await savedReadingOrder(f.db,'user','workspace','project','order'))?.items.length,2);
  assert.equal((await savedReadingOrder(f.db,'user','workspace','project',undefined,f.quotes.map(q=>q.file_id)))?.id,'order');
  assert.equal(await savedReadingOrder(f.db,'other','workspace','project','order'),null);
  assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
  assert.equal(await savedReadingOrder(f.db,'user','workspace','project',undefined,undefined,f.quotes[0]!.file_id),null);
  f.order.paid_at='2026-10-03';
  assert.equal((await savedReadingOrder(f.db,'user','workspace','project',undefined,undefined,f.quotes[0]!.file_id))?.items.length,2);
  f.order.paid_at='2026-10-03';assert.equal(readingOrderStatus(f.order,f.quotes,[{status:'waiting_budget'}]),'waiting');
  assert.equal(readingOrderStatus(f.order,f.quotes,[{status:'needs_review'},{status:'processing'}]),'processing');
  assert.equal(readingOrderStatus(f.order,f.quotes,[{status:'needs_review'},{status:'needs_review'}]),'ready_for_review');
  assert.equal(readingOrderStatus(f.order,f.quotes,[{status:'failed'}]),'needs_attention');
});
function paidEvent(f:ReturnType<typeof fixture>):any {f.order.stripe_session_id='cs_order';return {id:'evt_order',type:'checkout.session.completed',livemode:true,
  data:{object:{id:'cs_order',mode:'payment',payment_status:'paid',payment_intent:'pi_order',amount_total:f.order.amount_cents,currency:'usd',client_reference_id:'user',
    metadata:{roughbid_order_id:'order',roughbid_mode:'full_order',roughbid_contract_hash:f.order.contract_hash,workspace_id:'workspace',project_id:'project'}}}};}
test('signed live payment fans out every child and webhook retry recovers partial enqueue without new quote',async()=>{
  const f=fixture(),event=paidEvent(f),started=new Set<string>();let outage=true;
  const start=async(id:string)=>{if(id==='quote-2'&&outage)throw new Error('queue offline');started.add(id);};
  await assert.rejects(reconcileReadingOrder(f.db,event,start),/offline/);assert.deepEqual([...started],['quote-1']);
  outage=false;await reconcileReadingOrder(f.db,event,start);assert.deepEqual([...started],['quote-1','quote-2']);
  assert.deepEqual(f.calls.map(c=>c.fn),['confirm_full_reading_order_payment','confirm_full_reading_order_payment']);assert.equal(f.requests.length,0);
});
test('unpaid, test, Connect, stale scope and refund events cannot grant the batch',async()=>{
  const f=fixture(),event=paidEvent(f),started:string[]=[];const start=async(id:string)=>{started.push(id);};
  await reconcileReadingOrder(f.db,{...event,livemode:false},start);await reconcileReadingOrder(f.db,{...event,account:'acct_other'},start);
  await reconcileReadingOrder(f.db,{...event,data:{object:{...event.data.object,payment_status:'unpaid'}}},start);
  await assert.rejects(reconcileReadingOrder(f.db,{...event,data:{object:{...event.data.object,amount_total:1}}},start));
  await assert.rejects(reconcileReadingOrder(f.db,{...event,data:{object:{...event.data.object,metadata:{...event.data.object.metadata,workspace_id:'other'}}}},start));
  assert.equal(f.calls.length,0);assert.deepEqual(started,[]);
  f.order.stripe_payment_intent='pi_order';await reconcileReadingOrder(f.db,{...event,type:'charge.refunded',data:{object:{payment_intent:'pi_order',amount_refunded:1}}},start);
  assert.equal(f.calls[0]!.fn,'close_full_reading_order_payment');assert.equal(f.calls[0]!.args.p_reason,'refund');
  assert.deepEqual(started,[]);
});
test('dispute delivered before paid confirmation resolves authenticated Charge and prevents late fanout',async()=>{
  const f=fixture(),paid=paidEvent(f),started:string[]=[];const start=async(id:string)=>{started.push(id);};
  const event:any={id:'evt_disputed_first',type:'charge.dispute.created',livemode:true,
    data:{object:{id:'dp_fixture',charge:'ch_fixture',payment_intent:'pi_order',metadata:{}}}};
  const gateway={env:f.env,fetcher:(async(url:any,init:any)=>{
    assert.equal(url,'https://api.stripe.com/v1/charges/ch_fixture');assert.equal(init.redirect,'error');assert.equal(init.body,undefined);
    return Response.json({id:'ch_fixture',livemode:true,payment_intent:'pi_order',metadata:paid.data.object.metadata});
  })as typeof fetch};
  await reconcileReadingOrder(f.db,event,start,gateway);
  assert.equal(f.calls[0]!.fn,'close_full_reading_order_payment');assert.equal(f.calls[0]!.args.p_reason,'dispute');
  assert.equal(f.calls[0]!.args.p_session_id,'cs_order');assert.deepEqual(started,[]);
  // The SQL regression separately proves the terminal transition and replay.
  f.order.status='revoked';await reconcileReadingOrder(f.db,paid,start,gateway);assert.deepEqual(started,[]);
  const unavailable=fixture();paidEvent(unavailable);
  await assert.rejects(reconcileReadingOrder(unavailable.db,event,start,{env:f.env,fetcher:async()=>Response.json({}, {status:503})}),/does not match/);
  assert.equal(unavailable.calls.length,0);
});
