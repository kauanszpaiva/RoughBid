import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createBillingEndpointHandler, type BillingEndpointDependencies } from '../src/billing/endpoints.ts';
import { StripeHttpGateway } from '../src/billing/adapters.ts';
import { verifiedSubscriptionUpdate } from '../src/billing/stripe.ts';

function fixture() {
  const sessions: any[] = []; const updates: any[] = [];
  const deps: BillingEndpointDependencies = {
    config: { mode:'test', appUrl:'https://roughbid.test',productId:'',priceId:null,priceIds:{plan_pro:'price_Pro123',marketplace_supplier_import:'price_Addon123'} },
    membershipsEnabled:true,webhookSecret:'whsec_unit',
    authenticate:async()=>({id:'user_1',email:'user@example.test'}),
    stripe:{
      createCheckoutSession:async(input,key)=>{sessions.push({input,key});return{url:'https://checkout.stripe.com/session'};},
      createPortalSession:async()=>({url:'https://billing.stripe.com/portal'}),createCustomer:async()=> 'cus_1',
      hasBlockingSubscription:async()=>false,
      retrieveSubscription:async()=>({id:'sub_1',customer:'cus_1',status:'canceled',metadata:{user_id:'user_1'},items:{data:[{price:{id:'price_Pro123'},current_period_end:2_000_000_000}]},latest_invoice:{status:'paid',amount_paid:2900,amount_due:2900}}),
    },
    repository:{customerIdForUser:async()=>null,isPlatformAdminForUser:async()=>false,hasActivePilot:async()=>false,saveCustomer:async()=>{},
      claimCheckout:async()=>({id:'attempt_1',expiresAt:2_000_000_000}),beginSubscriptionSync:async()=>7,
      claimMarketplaceCheckout:async()=>({id:'market_attempt_1',expiresAt:2_000_000_000}),
      processStripeEvent:async(event,update)=>{updates.push({event,update});return true;},
    },
  };
  return {deps,sessions,updates};
}
const purchase = (body={priceKey:'plan_pro',successUrl:'https://roughbid.test/app/',cancelUrl:'https://roughbid.test/app/'}) => new Request('https://roughbid.test/api/billing/checkout',{method:'POST',body:JSON.stringify(body)});
function webhook(event: unknown, signature=true) {
  const body=JSON.stringify(event); const timestamp=Math.floor(Date.now()/1000);
  return new Request('https://roughbid.test/api/webhooks/stripe',{method:'POST',body,headers:{'stripe-signature':signature?`t=${timestamp},v1=${createHmac('sha256','whsec_unit').update(`${timestamp}.${body}`).digest('hex')}`:'invalid'}});
}
test('repeat membership checkout uses durable attempt, customer and exact Stripe idempotency',async()=>{
  const f=fixture(); const handler=createBillingEndpointHandler(f.deps);
  assert.equal((await handler(purchase())).status,200); assert.equal((await handler(purchase())).status,200);
  assert.equal(f.sessions[0].key,'roughbid-membership-attempt_1'); assert.deepEqual(f.sessions[0],f.sessions[1]);
  assert.equal(f.sessions[0].input.customer,'cus_1'); assert.equal(f.sessions[0].input.expires_at,2_000_000_000);
});
test('active or unsettled subscription cannot start another subscription checkout',async()=>{
  const f=fixture(); f.deps.stripe.hasBlockingSubscription=async()=>true;
  assert.equal((await createBillingEndpointHandler(f.deps)(purchase())).status,409); assert.equal(f.sessions.length,0);
});
test('sponsored pilot cannot be charged by membership checkout, including unknown access state',async()=>{
  const f=fixture();f.deps.repository.hasActivePilot=async()=>true;
  assert.equal((await createBillingEndpointHandler(f.deps)(purchase())).status,409);
  f.deps.repository.hasActivePilot=async()=>{throw new Error('database unavailable');};
  assert.equal((await createBillingEndpointHandler(f.deps)(purchase())).status,503);
  assert.equal(f.sessions.length,0);
});
test('unapproved billing redirect and marketplace purchase cannot contact Checkout',async()=>{
  const f=fixture(); const handler=createBillingEndpointHandler(f.deps);
  assert.equal((await handler(purchase({priceKey:'plan_pro',successUrl:'https://attacker.test/',cancelUrl:'https://roughbid.test/'}))).status,400);
  assert.equal((await handler(purchase({priceKey:'marketplace_supplier_import',successUrl:'https://roughbid.test/',cancelUrl:'https://roughbid.test/'}))).status,503);
  assert.equal(f.sessions.length,0);
});
test('Marketplace checkout is workspace-bound, separately enabled and idempotent',async()=>{
  const f=fixture();f.deps.marketplaceEnabled=true;
  const body={priceKey:'marketplace_supplier_import',successUrl:'https://roughbid.test/app/',cancelUrl:'https://roughbid.test/app/'};
  const buy=()=>new Request('https://roughbid.test/api/billing/checkout',{method:'POST',headers:{'x-workspace-id':'workspace_1'},body:JSON.stringify(body)});
  assert.equal((await createBillingEndpointHandler(f.deps)(buy())).status,200);
  assert.equal(f.sessions[0].key,'roughbid-marketplace-market_attempt_1');
  assert.deepEqual(f.sessions[0].input.subscription_data?.metadata,{user_id:'user_1',price_key:'marketplace_supplier_import',workspace_id:'workspace_1',marketplace_feed_id:'supplier_import'});
  assert.deepEqual(f.sessions[0].input.line_items,[{price:'price_Addon123',quantity:1}]);
});
test('Marketplace webhooks reconcile a fresh paid subscription and refund revokes it',async()=>{
  const f=fixture();f.deps.marketplaceEnabled=true;
  f.deps.stripe.retrieveSubscription=async()=>({id:'sub_market',customer:'cus_1',status:'active',metadata:{user_id:'user_1',workspace_id:'workspace_1',marketplace_feed_id:'supplier_import',price_key:'marketplace_supplier_import'},
    items:{data:[{id:'si_1',price:{id:'price_Addon123'},current_period_end:2_000_000_000}]},latest_invoice:{id:'in_market',status:'paid',amount_paid:4900,amount_due:4900,currency:'usd'}});
  f.deps.stripe.retrieveInvoiceSubscription=async id=>{assert.equal(id,'in_market');return'sub_market';};
  const paid={id:'evt_market',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_market',subscription:'sub_market'}}};
  assert.equal((await createBillingEndpointHandler(f.deps)(webhook(paid))).status,200);
  assert.equal(f.updates[0].update.kind,'marketplace');assert.equal(f.updates[0].update.invoicePaid,true);assert.equal(f.updates[0].update.checkoutSessionId,'cs_market');
  const refunded={id:'evt_refund',type:'charge.refunded',livemode:false,data:{object:{invoice:'in_market',amount_refunded:4900}}};
  assert.equal((await createBillingEndpointHandler(f.deps)(webhook(refunded))).status,200);
  assert.equal(f.updates[1].update.forceRevoke,true);assert.equal(f.updates[1].update.invoicePaid,false);
});
test('Marketplace dispute resolves charge to invoice and revokes access',async()=>{
  const f=fixture();f.deps.marketplaceEnabled=true;
  f.deps.stripe.retrieveChargeInvoice=async id=>{assert.equal(id,'ch_market');return'in_market';};
  f.deps.stripe.retrieveInvoiceSubscription=async()=> 'sub_market';
  f.deps.stripe.retrieveSubscription=async()=>({id:'sub_market',customer:'cus_1',status:'active',metadata:{user_id:'user_1',workspace_id:'workspace_1',marketplace_feed_id:'supplier_import',price_key:'marketplace_supplier_import'},items:{data:[{price:{id:'price_Addon123'},current_period_end:2_000_000_000}]},latest_invoice:{id:'in_market',status:'paid',amount_paid:4900,amount_due:4900,currency:'usd'}});
  const event={id:'evt_dispute',type:'charge.dispute.created',livemode:false,data:{object:{charge:'ch_market'}}};
  assert.equal((await createBillingEndpointHandler(f.deps)(webhook(event))).status,200);
  assert.equal(f.updates[0].update.kind,'marketplace');assert.equal(f.updates[0].update.forceRevoke,true);
});
test('invoice event reads current subscription instead of applying a stale snapshot',async()=>{
  const f=fixture(); const event={id:'evt_invoice',type:'invoice.paid',livemode:false,data:{object:{parent:{subscription_details:{subscription:'sub_1'}}}}};
  assert.equal((await createBillingEndpointHandler(f.deps)(webhook(event))).status,200);
  assert.equal(f.updates[0].update.subscriptionStatus,'canceled'); assert.equal(f.updates[0].update.invoicePaid,true);
  assert.equal(f.updates[0].update.currentPeriodEnd,new Date(2_000_000_000*1000).toISOString());
  assert.equal(f.updates[0].update.syncRevision,7);
});
test('provider reconciliation failure is retryable and invalid signature performs no reads',async()=>{
  const f=fixture();let reads=0;f.deps.stripe.retrieveSubscription=async()=>{reads++;throw new Error('temporary');};
  const event={id:'evt_x',type:'customer.subscription.updated',livemode:false,data:{object:{id:'sub_1'}}};
  const handler=createBillingEndpointHandler(f.deps);
  assert.equal((await handler(webhook(event,false))).status,400);assert.equal(reads,0);
  assert.equal((await handler(webhook(event))).status,503);assert.equal(f.updates.length,0);
});
test('active state with unpaid invoice does not manufacture payment and unrelated price is ignored',()=>{
  const sub={id:'sub_1',customer:'cus_1',status:'active',metadata:{user_id:'user_1'},items:{data:[{price:{id:'price_Pro123'},current_period_end:2_000_000_000}]},latest_invoice:{status:'open',amount_paid:0,amount_due:2900}};
  assert.equal(verifiedSubscriptionUpdate(sub,['price_Pro123'],1)?.invoicePaid,false);
  assert.equal(verifiedSubscriptionUpdate(sub,['price_other'],1),null);
});

test('webhook diagnostics identify validation stage without exposing request data or changing payment state', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => { logs.push(values); });
  const f = fixture();
  let reconciliations = 0;
  f.deps.reconcileProjectPayment = async () => { reconciliations++; };
  const handler = createBillingEndpointHandler(f.deps);
  const timestamp = Math.floor(Date.now() / 1000);
  const malformed = '{ PRIVATE_EVENT_PAYLOAD';
  const signedMalformed = new Request('https://roughbid.test/api/webhooks/stripe', { method: 'POST', body: malformed,
    headers: { 'stripe-signature': `t=${timestamp},v1=${createHmac('sha256', 'whsec_unit').update(`${timestamp}.${malformed}`).digest('hex')}` } });
  for (const request of [
    webhook({ id: 'PRIVATE_EVENT_ID', type: 'checkout.session.completed', livemode: false }, false),
    signedMalformed,
    webhook({ id: 'PRIVATE_EVENT_ID', type: 'checkout.session.completed', livemode: true }),
  ]) {
    const response = await handler(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid Stripe webhook.' });
  }
  assert.deepEqual(logs, ['signature', 'event', 'mode'].map(stage => ['Stripe webhook validation failed', { stage }]));
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|whsec_|stripe-signature/);
  assert.equal(reconciliations, 0);
  assert.deepEqual(f.updates, []);
});
test('Stripe transport passes the server idempotency key and fails closed on unknown subscription pages',async()=>{
  assert.throws(()=>new StripeHttpGateway('sk_live_unit',fetch,'test'),/mode does not match/);
  const calls:any[]=[];
  const gateway=new StripeHttpGateway('sk_test_unit',(async(url,init)=>{calls.push({url,init});return Response.json(String(url).includes('subscriptions?')?{data:[],has_more:true}:{url:'https://checkout.stripe.com/x'});}) as typeof fetch);
  await gateway.createCheckoutSession({mode:'subscription',ui_mode:'hosted',customer:'cus_1',line_items:[{price:'price_1',quantity:1}],success_url:'https://roughbid.test/',cancel_url:'https://roughbid.test/'},'attempt_1');
  assert.equal(calls[0].init.headers['idempotency-key'],'attempt_1');assert.equal(await gateway.hasBlockingSubscription('cus_1'),true);
});
test('Stripe transport expands the latest invoice before deriving paid entitlement',async()=>{
  const calls:any[]=[];
  const gateway=new StripeHttpGateway('sk_test_unit',(async(url,init)=>{calls.push({url,init});return Response.json({id:'sub_1',customer:'cus_1',status:'active'});}) as typeof fetch);
  assert.equal((await gateway.retrieveSubscription('sub_1')).id,'sub_1');
  assert.equal(calls[0].url,'https://api.stripe.com/v1/subscriptions/sub_1?expand%5B%5D=latest_invoice');
});
