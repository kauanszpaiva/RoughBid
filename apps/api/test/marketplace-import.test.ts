import test from 'node:test';
import assert from 'node:assert/strict';
import {handleMarketplaceCatalog} from '../src/marketplace/catalog.ts';
import {handleSupplierPriceImport} from '../src/marketplace/supplier-import.ts';
import {SUPPLIER_CSV_MAX_BYTES} from '../../../packages/domain/src/supplier-price-import.ts';

const env={STRIPE_MODE:'live'};
const paid={status:'active',invoice_paid:true,current_period_end:'2030-01-01T00:00:00Z',mode:'live'};
const csv='Name,Unit,Unit cost,Supplier\nBoard,EA,14.25,Supply Co\n';
function request(body:BodyInit=csv,headers:Record<string,string>={}) {
  return new Request('https://roughbid.test/api/marketplace/supplier-import',{method:'POST',body,headers:{'x-workspace-id':'workspace-1','content-type':'text/csv',...headers}});
}
function database(options:{user?:string|null;role?:string|null;entitlement?:any;admin?:boolean;errorTable?:string}={}) {
  const state={user:'user-1',role:'admin',entitlement:{...paid},...options};
  const filters:Array<[string,string,unknown]>=[];
  const db={auth:{getUser:async()=>({data:{user:state.user?{id:state.user}:null},error:null})},from(table:string){
    const q:any={select:()=>q,eq:(column:string,value:unknown)=>{filters.push([table,column,value]);return q;},maybeSingle:async()=>({
      data:table==='workspace_members'?(state.role?{role:state.role}:null):table==='profiles'?{is_platform_admin:state.admin===true}:state.entitlement,
      error:state.errorTable===table?{message:'private database detail'}:null,
    })};return q;
  }};
  return {db:db as any,state,filters};
}

test('server imports supplier prices for current paid admin and estimator access',async()=>{
  for(const role of ['admin','estimator']) {
    const {db,filters}=database({role});
    const response=await handleSupplierPriceImport(request(),db,env);
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');
    const body=await response.json() as any;
    assert.equal(body.materials[0].unitCost,14.25);assert.equal(body.materials[0].supplier,'Supply Co');
    assert.ok(filters.some(([table,column,value])=>table==='workspace_members'&&column==='user_id'&&value==='user-1'));
    for(const table of ['workspace_members','marketplace_entitlements']) assert.ok(filters.some(([t,c,v])=>t===table&&c==='workspace_id'&&v==='workspace-1'));
  }
});

test('an open paid catalog cannot authorize imports after refund or role revocation',async()=>{
  const {db,state}=database();
  const catalog=await (await handleMarketplaceCatalog(new Request('https://roughbid.test/api/marketplace/catalog',{headers:{'x-workspace-id':'workspace-1'}}),db,env)).json() as any;
  assert.equal(catalog.items[0].entitled,true);
  state.entitlement={...paid,status:'revoked'};
  assert.equal((await handleSupplierPriceImport(request(),db,env)).status,403);
  state.entitlement={...paid};state.role='viewer';
  assert.equal((await handleSupplierPriceImport(request(),db,env)).status,403);
});

test('server rejects anonymous, other-workspace, unpaid, expired, and wrong-mode imports',async()=>{
  const cases=[
    {options:{user:null},status:401},{options:{role:null},status:404},{options:{role:'viewer'},status:403},
    ...[null,{...paid,invoice_paid:false},{...paid,status:'revoked'},{...paid,current_period_end:'2020-01-01'}, {...paid,mode:'test'}].map(entitlement=>({options:{entitlement},status:403})),
  ];
  for(const entry of cases) assert.equal((await handleSupplierPriceImport(request(),database(entry.options).db,env)).status,entry.status);
  assert.equal((await handleSupplierPriceImport(request(csv,{'x-workspace-id':''}),database().db,env)).status,400);
  assert.equal((await handleSupplierPriceImport(new Request('https://roughbid.test/api/marketplace/supplier-import'),database().db,env)).status,405);
});

test('owner preview requires a writable workspace and access failures never import',async()=>{
  assert.equal((await handleSupplierPriceImport(request(),database({admin:true,entitlement:null}).db,env)).status,200);
  assert.equal((await handleSupplierPriceImport(request(),database({admin:true,role:'viewer'}).db,env)).status,403);
  for(const table of ['profiles','workspace_members','marketplace_entitlements']) {
    const response=await handleSupplierPriceImport(request(),database({errorTable:table}).db,env);
    assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private database detail/);
  }
});

test('server enforces CSV encoding, amount validation, content type and byte limits',async()=>{
  assert.equal((await handleSupplierPriceImport(request('Name,Unit,Cost\nBoard,EA,'),database().db,env)).status,400);
  assert.equal((await handleSupplierPriceImport(request(csv,{'content-type':'application/json'}),database().db,env)).status,415);
  assert.equal((await handleSupplierPriceImport(request(new Uint8Array([0xff,0xfe])),database().db,env)).status,400);
  assert.equal((await handleSupplierPriceImport(request(csv,{'content-length':String(SUPPLIER_CSV_MAX_BYTES+1)}),database().db,env)).status,413);
  assert.equal((await handleSupplierPriceImport(request('a'.repeat(SUPPLIER_CSV_MAX_BYTES+1)),database().db,env)).status,413);
});
