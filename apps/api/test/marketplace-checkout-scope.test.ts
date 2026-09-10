import test from 'node:test';
import assert from 'node:assert/strict';
import {StripeHttpGateway} from '../src/billing/adapters.ts';
import {createBillingEndpointHandler} from '../src/billing/endpoints.ts';

test('an existing Marketplace subscription only blocks its own workspace',async()=>{
  let metadata:{workspace_id?:string}={workspace_id:'workspace-a'};
  let hasMore=false;
  const gateway=new StripeHttpGateway('sk_test_unit', (async()=>Response.json({has_more:hasMore,data:[{
    status:'active',metadata,items:{data:[{price:{id:'price_Supplier123'}}]},
  }]})) as typeof fetch);
  assert.equal(await gateway.hasBlockingSubscription('cus_1',['price_Supplier123'],'workspace-a'),true);
  assert.equal(await gateway.hasBlockingSubscription('cus_1',['price_Supplier123'],'workspace-b'),false);
  assert.equal(await gateway.hasBlockingSubscription('cus_1',['price_Supplier123']),true);
  metadata={};
  assert.equal(await gateway.hasBlockingSubscription('cus_1',['price_Supplier123'],'workspace-b'),true);
  metadata={workspace_id:'workspace-a'};hasMore=true;
  assert.equal(await gateway.hasBlockingSubscription('cus_1',['price_Supplier123'],'workspace-b'),true);
});

test('Marketplace checkout passes its verified workspace into duplicate detection',async()=>{
  let claimed=false;const calls:unknown[][]=[];
  const handler=createBillingEndpointHandler({
    config:{mode:'test',appUrl:'https://roughbid.test',productId:'',priceId:null,priceIds:{marketplace_supplier_import:'price_Supplier123'}},
    webhookSecret:'whsec_unit',marketplaceEnabled:true,
    authenticate:async()=>({id:'user-1',email:'user@example.test'}),
    repository:{customerIdForUser:async()=> 'cus_1',hasActivePilot:async()=>false,saveCustomer:async()=>{},
      claimMarketplaceCheckout:async(user,workspace)=>{assert.equal(user,'user-1');assert.equal(workspace,'workspace-b');claimed=true;return{id:'attempt-1',expiresAt:2_000_000_000};},
      processStripeEvent:async()=>true,
    },
    stripe:{createCustomer:async()=> 'cus_1',createPortalSession:async()=>({url:'https://billing.stripe.com/unit'}),
      hasBlockingSubscription:async(...args)=>{assert.equal(claimed,true);calls.push(args);return false;},
      createCheckoutSession:async(input)=>{assert.equal(input.subscription_data?.metadata.workspace_id,'workspace-b');return{url:'https://checkout.stripe.com/unit'};},
    },
  });
  const response=await handler(new Request('https://roughbid.test/api/billing/checkout',{method:'POST',headers:{'x-workspace-id':'workspace-b'},body:JSON.stringify({
    priceKey:'marketplace_supplier_import',successUrl:'https://roughbid.test/app/',cancelUrl:'https://roughbid.test/app/',
  })}));
  assert.equal(response.status,200);assert.deepEqual(calls,[['cus_1',['price_Supplier123'],'workspace-b']]);
});
