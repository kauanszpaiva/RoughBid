import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketplaceCatalog,MARKETPLACE_PRICING_VERSION } from '../src/marketplace/catalog.ts';

function db(input:{user?:any;role?:string|null;entitlement?:any;admin?:boolean;errorTable?:string}){
  return {auth:{getUser:async()=>({data:{user:input.user??{id:'user-1'}},error:null})},from(table:string){
    const value=table==='workspace_members'?(input.role?{role:input.role}:null):table==='profiles'?{is_platform_admin:input.admin===true}:input.entitlement??null;
    const q:any={};for(const method of ['select','eq'])q[method]=()=>q;
    q.maybeSingle=async()=>({data:value,error:input.errorTable===table?{message:'private'}:null});return q;
  }} as any;
}
const request=()=>new Request('https://roughbid.test/api/marketplace/catalog',{headers:{'x-workspace-id':'workspace-1'}});
const configured={STRIPE_MODE:'live',BILLING_MARKETPLACE_ENABLED:'true',STRIPE_PRICE_MARKETPLACE_SUPPLIER_IMPORT:'price_Supplier123'};

test('Marketplace catalog requires real authenticated workspace membership',async()=>{
  const anonymous=db({user:null,role:null});anonymous.auth.getUser=async()=>({data:{user:null},error:null});
  assert.equal((await handleMarketplaceCatalog(request(),anonymous,configured)).status,401);
  assert.equal((await handleMarketplaceCatalog(request(),db({role:null}),configured)).status,404);
  assert.equal((await handleMarketplaceCatalog(new Request('https://roughbid.test/api/marketplace/catalog'),db({role:'admin'}),configured)).status,400);
});

test('only a current paid same-mode entitlement unlocks Supplier Price Import',async()=>{
  const active={feed_id:'supplier_import',status:'active',invoice_paid:true,current_period_end:'2030-01-01T00:00:00Z',mode:'live'};
  const response=await handleMarketplaceCatalog(request(),db({role:'admin',entitlement:active}),configured);
  const body=await response.json() as any;const supplier=body.items.find((item:any)=>item.id==='supplier_import');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(body.pricingVersion,MARKETPLACE_PRICING_VERSION);assert.equal(supplier.entitled,true);assert.equal(supplier.checkoutAvailable,false);
  assert.ok(body.items.filter((item:any)=>item.id!=='supplier_import').every((item:any)=>item.availability==='coming_soon'&&!item.checkoutAvailable&&!item.entitled));
  for(const entitlement of [{...active,mode:'test'},{...active,invoice_paid:false},{...active,status:'revoked'},{...active,current_period_end:'2020-01-01'}]){
    const result=await (await handleMarketplaceCatalog(request(),db({role:'admin',entitlement}),configured)).json() as any;
    assert.equal(result.items.find((item:any)=>item.id==='supplier_import').entitled,false);
  }
});

test('platform owner receives functional preview but never a Marketplace checkout',async()=>{
  const body=await (await handleMarketplaceCatalog(request(),db({role:'admin',admin:true}),configured)).json() as any;
  const supplier=body.items.find((item:any)=>item.id==='supplier_import');assert.equal(supplier.entitled,true);assert.equal(supplier.checkoutAvailable,false);
});
