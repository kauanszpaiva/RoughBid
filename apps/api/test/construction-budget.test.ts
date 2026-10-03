import test from 'node:test';
import assert from 'node:assert/strict';
import researchData from '../../../packages/domain/data/roughbid-catalog-base.json' with { type:'json' };
import { ConstructionBudgetService } from '../src/construction-budget/service.ts';
import { handleConstructionBudgetRequest } from '../src/construction-budget/routes.ts';
import { validateResearchConstructionCatalog, researchCatalogToConstructionCatalog } from '../../../packages/domain/src/research-catalog.ts';
import { SUPPLIER_QUOTE_SCHEMA } from '../../../packages/domain/src/supplier-quotes.ts';

const USER='00000000-0000-4000-8000-000000000001',WORKSPACE='10000000-0000-4000-8000-000000000001',PROJECT='20000000-0000-4000-8000-000000000001';
const RUN='40000000-0000-4000-8000-000000000001',MEASUREMENT='50000000-0000-4000-8000-000000000001';
const AT='2026-10-02T16:00:00Z',LOCATION={country:'US',postalCode:'02110',storeId:'boston',timeZone:'America/New_York'};
const COMPONENT='RB-SITE-001.m01',ASSEMBLY='RB-SITE-001';
const emptyCharge=()=>({required:false,amount:null,refundable:false,sourceRef:'supplier-document-explicit-exclusions'});
function quote(overrides:Record<string,unknown>={}) {return {schema:SUPPLIER_QUOTE_SCHEMA,id:'Q1',supplier:'other',supplierName:'Documented supplier',location:LOCATION,
  sku:'floor-covering-1',variant:null,model:null,specification:'Exact reviewed surface protection product',specificationReviewed:true,channel:'pickup',quotedQuantity:3,pricedUnit:'BOX',unitPrice:20,currency:'USD',origin:'manual_quote',
  sourceUrl:null,documentRef:'supplier-doc-1',observedAt:AT,evidenceAt:AT,sourceUpdatedAt:null,validUntil:'2026-10-03T00:00:00Z',importedAt:AT,
  reviewedBy:'spoofed-reviewer',reviewedAt:AT,availability:'in_stock',availableQuantity:100,availabilityAt:AT,
  coveragePerPricedUnit:{quantity:10,unit:'SF'},unitsPerPackage:1,minimumOrderPackages:0,orderIncrement:1,roundingRule:'round_up_increment',
  charges:{freight:emptyCharge(),handling:emptyCharge(),tax:emptyCharge(),conditionalDiscount:emptyCharge(),refundableDeposit:emptyCharge()},...overrides};}

function fixture(role='estimator') {
  const tables:Record<string,any[]>={workspace_members:[{workspace_id:WORKSPACE,user_id:USER,role}],projects:[{id:PROJECT,workspace_id:WORKSPACE}],
    takeoff_measurement_reviews:[{id:MEASUREMENT,workspace_id:WORKSPACE,project_id:PROJECT,takeoff_run_id:RUN,label:'Human-reviewed floor protection',quantity:'25',unit:'SF',review_status:'accepted',physical_page_number:1,page_sha256:'b'.repeat(64),review_revision:3}],
    photo_takeoff_runs:[],geometry_provider_candidates:[],construction_supplier_quotes:[],construction_budget_snapshots:[]};
  const calls:Array<{name:string;args:Record<string,any>}>=[];
  let authenticatedUser:string|null=USER;
  const db:any={auth:{getUser:async()=>({data:{user:authenticatedUser?{id:authenticatedUser}:null},error:null})},from(table:string){
    assert.ok(table in tables,`unexpected fixture table ${table}`);const filters:Array<[string,unknown]>=[];let maximum=Infinity,single=false,descending=false,columns='*';
    const builder:any={select:(value='*')=>{columns=value;return builder;},eq:(key:string,value:unknown)=>{filters.push([key,value]);return builder;},
      order:(_key:string,options?:{ascending?:boolean})=>{descending=options?.ascending===false;return builder;},limit:(value:number)=>{maximum=value;return builder;},
      maybeSingle:()=>{single=true;return builder;},then:(resolve:any,reject:any)=>{
        const found=tables[table]!.filter(row=>filters.every(([key,value])=>row[key]===value));
        const sorted=descending?[...found].sort((a,b)=>String(b.created_at??'').localeCompare(String(a.created_at??''))):found;
        const projected=sorted.slice(0,maximum).map(row=>columns==='*'?row:Object.fromEntries(columns.split(',').map(field=>{
          const alias=field.match(/^([a-z_]\w*):([a-z_]\w*)->([a-z_]\w*)$/i);return alias?[alias[1],row[alias[2]!]?.[alias[3]!]]:[field,row[field]];
        })));
        return Promise.resolve({data:single?(projected[0]??null):projected,error:null}).then(resolve,reject);
      }};return builder;
  }};
  const writer={async rpc(name:string,args:Record<string,any>){calls.push({name,args});
    if(name==='save_construction_supplier_quotes') {
      for(const value of args.p_quotes){const index=tables.construction_supplier_quotes!.findIndex(row=>row.quote.id===value.id);
        const row={workspace_id:args.p_workspace_id,project_id:args.p_project_id,quote:structuredClone(value),created_at:value.importedAt};
        if(index<0)tables.construction_supplier_quotes!.push(row);else tables.construction_supplier_quotes![index]=row;}
      return {data:null,error:null};
    }
    assert.equal(name,'save_construction_budget_snapshot');
    const prior=tables.construction_budget_snapshots!.find(row=>row.request_hash===args.p_request_hash);
    if(prior)return {data:{id:prior.id,createdAt:prior.created_at},error:null};
    const row={id:crypto.randomUUID(),workspace_id:args.p_workspace_id,project_id:args.p_project_id,source_kind:args.p_source_kind,source_run_id:args.p_source_run_id,
      selection_count:args.p_selection_count,request_hash:args.p_request_hash,result:structuredClone(args.p_result),location:args.p_location,created_at:AT};
    tables.construction_budget_snapshots!.unshift(row);return {data:{id:row.id,createdAt:row.created_at},error:null};
  }};
  return {tables,calls,db,writer,setAuthenticatedUser:(user:string|null)=>{authenticatedUser=user;},service:new ConstructionBudgetService(db,writer,USER,WORKSPACE,()=>AT)};
}
function request(overrides:Record<string,unknown>={}) {return {sourceKind:'plan',runId:RUN,location:LOCATION,quoteIds:[],selections:[{measurementId:MEASUREMENT,assemblyId:ASSEMBLY,
  quantity:999999,activation:{[COMPONENT]:true,'RB-SITE-001.m02':false},componentInputs:{}}],...overrides};}
function materialInputs(rawRate=99999) {
  const catalog=researchCatalogToConstructionCatalog(validateResearchConstructionCatalog(researchData));
  const material:any=structuredClone(catalog.items.find(item=>item.id===COMPONENT)!);
  Object.assign(material,{reviewed:true,specification:'Reviewed exact surface protection product',specificationSource:{name:'Reviewed product specification',url:null,documentRef:'product-doc-1',effectiveDate:'2026-10-02',place:'US 02110'},
    rate:{amount:rawRate,reviewed:true,source:{sourceType:'project_quote',sourceName:'Unpersisted price injection',effectiveDate:'2026-10-02',expiresAt:null,geography:'US 02110',vendor:'Unpersisted',sku:'floor-covering-1',confidence:1}},
    wastePercent:0,pack:{pricedUnit:'BOX',coverageQuantity:10,coverageUnit:'SF',unitsPerPackage:1,minimumOrderPackages:0,orderIncrement:1,roundingRule:'round_up_increment'}});
  return {schema:catalog.schema,items:[material]};
}
function boundRequest(overrides:Record<string,unknown>={}) {return request({catalogOverrides:materialInputs(),quoteIds:['Q1'],
  quoteBindings:[{componentId:COMPONENT,quoteId:'Q1',sku:'floor-covering-1',variant:null,channel:'pickup',supplier:'other',specificationReviewed:true}],...overrides});}
const status=(expected:number)=>(error:any)=>error.status===expected;

test('construction budget authorizes the project tenant, allows read-only access and rejects viewer mutations',async()=>{
  const f=fixture('viewer');assert.equal((await f.service.get(PROJECT)).coverage,'partial');
  await assert.rejects(f.service.calculate(PROJECT,request()),status(403));await assert.rejects(f.service.importQuotes(PROJECT,{quotes:[quote()]}),status(403));
  const wrong=new ConstructionBudgetService(f.db,f.writer,USER,'10000000-0000-4000-8000-000000000099',()=>AT);
  await assert.rejects(wrong.get(PROJECT),status(403));await assert.rejects(f.service.get('20000000-0000-4000-8000-000000000099'),status(404));assert.equal(f.calls.length,0);
});
test('assembly calculation uses saved reviewed quantities, keeps missing prices null and reloads its immutable snapshot',async()=>{
  const f=fixture(),saved:any=await f.service.calculate(PROJECT,request());
  assert.equal(saved.result.trace[0].measurement.quantity,25);assert.equal(saved.result.trace[0].measurement.evidenceRef,`plan:${RUN}:${'b'.repeat(64)}:${MEASUREMENT}:v3`);
  const material=saved.result.lines.find((line:any)=>line.itemId===COMPONENT);assert.equal(material.quantity,25);assert.equal(material.cost,null);
  assert.equal(saved.result.totalUsd,null);assert.equal(saved.result.status,'pending');assert.ok(saved.result.missingInputs.some((reason:string)=>/price|purchase_packaging|specification/.test(reason)));
  const restored:any=await f.service.get(PROJECT);assert.equal(restored.snapshots[0].id,saved.id);assert.deepEqual(restored.snapshots[0].result,saved.result);
  const repeat:any=await f.service.calculate(PROJECT,request());assert.equal(repeat.id,saved.id);assert.equal(f.tables.construction_budget_snapshots!.length,1);
});
test('selections cannot duplicate a measurement, cross source/run boundaries or substitute incompatible units',async()=>{
  const f=fixture(),body=request();await assert.rejects(f.service.calculate(PROJECT,{...body,selections:[...body.selections,...body.selections]}),status(422));
  await assert.rejects(f.service.calculate(PROJECT,{...body,runId:'40000000-0000-4000-8000-000000000099'}),status(422));
  await assert.rejects(f.service.calculate(PROJECT,{...body,sourceKind:'photo'}),status(422));
  await assert.rejects(f.service.calculate(PROJECT,{...body,selections:[{...body.selections[0],assemblyId:'RB-SITE-002'}]}),status(422));assert.equal(f.calls.length,0);
});
test('documented quote import binds the authenticated reviewer and cannot renew cached or historical evidence',async()=>{
  const f=fixture(),old='2026-10-01T16:00:00Z';await f.service.importQuotes(PROJECT,{quotes:[quote({origin:'cache',observedAt:old,evidenceAt:old,importedAt:old})]});
  const persisted=f.calls[0]!.args.p_quotes[0];assert.equal(persisted.reviewedBy,USER);assert.equal(persisted.reviewedAt,AT);assert.equal(persisted.importedAt,AT);
  assert.equal(persisted.evidenceAt,old);assert.equal(persisted.observedAt,old);
  const result:any=await f.service.calculate(PROJECT,boundRequest());assert.equal(result.result.knownSubtotalUsd,0);assert.equal(result.result.totalUsd,null);
  assert.equal(result.result.quoteStates[0].evaluation.state,'stale');
  await assert.rejects(f.service.importQuotes(PROJECT,{quotes:[quote({origin:'partner_api'})]}),status(422));
});
test('unpersisted material rates cannot turn a documented specification into a price',async()=>{
  const f=fixture(),saved:any=await f.service.calculate(PROJECT,request({catalogOverrides:materialInputs()}));
  assert.equal(saved.result.knownSubtotalUsd,0);assert.equal(saved.result.lines.find((line:any)=>line.itemId===COMPONENT).cost,null);assert.equal(saved.result.totalUsd,null);
});
test('fresh persisted exact-scope quotes price only the reviewed material subset; changed source evidence creates a new snapshot',async()=>{
  const f=fixture();await f.service.importQuotes(PROJECT,{quotes:[quote()]});
  const first:any=await f.service.calculate(PROJECT,boundRequest());assert.equal(first.result.knownSubtotalUsd,60,JSON.stringify({lines:first.result.lines,quoteStates:first.result.quoteStates}));assert.equal(first.result.totalUsd,null);
  assert.equal(first.result.lines.find((line:any)=>line.itemId===COMPONENT).quantity,3);assert.equal(first.result.quoteStates[0].evaluation.state,'fresh');
  assert.ok(first.result.missingInputs.includes('sheet_category_coverage_and_independent_review_pending'));
  await f.service.importQuotes(PROJECT,{quotes:[quote({id:'Q2',unitPrice:30,documentRef:'supplier-doc-revision-2'})]});
  const second:any=await f.service.calculate(PROJECT,boundRequest({quoteIds:['Q2'],quoteBindings:[{componentId:COMPONENT,quoteId:'Q2',sku:'floor-covering-1',variant:null,channel:'pickup',supplier:'other',specificationReviewed:true}]}));assert.equal(second.result.knownSubtotalUsd,90);assert.notEqual(second.id,first.id);
  assert.equal(f.tables.construction_budget_snapshots!.length,2);
});
test('quoted bulk quantity, unknown location and different SKU cannot masquerade as a matching purchase',async()=>{
  const f=fixture();await f.service.importQuotes(PROJECT,{quotes:[quote({quotedQuantity:25})]});
  const bulk:any=await f.service.calculate(PROJECT,boundRequest());assert.equal(bulk.result.knownSubtotalUsd,0);assert.equal(bulk.result.totalUsd,null);
  const unlocated:any=await f.service.calculate(PROJECT,boundRequest({location:null}));assert.equal(unlocated.result.knownSubtotalUsd,0);
  await f.service.importQuotes(PROJECT,{quotes:[quote()]});
  const wrongSku:any=await f.service.calculate(PROJECT,boundRequest({quoteBindings:[{componentId:COMPONENT,quoteId:'Q1',sku:'different-product',variant:null,channel:'pickup',supplier:'other',specificationReviewed:true}]}));assert.equal(wrongSku.result.knownSubtotalUsd,0);
});
test('actual HTTP routes authenticate tenant/read-only permissions, preserve partial snapshots and bound document imports',async()=>{
  const f=fixture(),send=(endpoint:string,method='GET',body?:unknown,workspace:string|null=WORKSPACE)=>handleConstructionBudgetRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/${endpoint}`,{
    method,headers:{...(workspace?{'x-workspace-id':workspace}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),f.db,f.writer,()=>AT);
  f.setAuthenticatedUser(null);assert.equal((await send('construction-budget')).status,401);f.setAuthenticatedUser(USER);
  assert.equal((await send('supplier-quotes','GET',undefined,null)).status,400);
  assert.equal((await send('construction-budget','GET',undefined,'10000000-0000-4000-8000-000000000099')).status,403);
  f.tables.workspace_members![0].role='viewer';assert.equal((await send('construction-budget','POST',request())).status,403);assert.equal((await send('supplier-quotes','POST',{quotes:[quote()]})).status,403);
  f.tables.workspace_members![0].role='estimator';
  const imported=await send('supplier-quotes','POST',{quotes:[quote()]});assert.equal(imported.status,201);assert.equal((await imported.json()).quotes[0].reviewedBy,USER);
  const saved=await send('construction-budget','POST',boundRequest());assert.equal(saved.status,201);assert.equal(saved.headers.get('cache-control'),'private, no-store');
  const created=await saved.json();assert.equal(created.result.totalUsd,null);assert.equal(created.result.knownSubtotalUsd,60);
  const recovered=await send('construction-budget');assert.equal(recovered.status,200);assert.equal((await recovered.json()).snapshots[0].id,created.id);
  const oversized=await send('supplier-quotes','POST',{quotes:[quote()],padding:'x'.repeat(1_000_000)});assert.equal(oversized.status,413);
  const invalid=await handleConstructionBudgetRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/construction-budget`,{method:'POST',headers:{'x-workspace-id':WORKSPACE},body:'not-json'}),f.db,f.writer,()=>AT);assert.equal(invalid.status,400);
});
test('formula strings supplied as component dimensions are rejected without executing code',async()=>{
  const f=fixture();f.tables.takeoff_measurement_reviews![0].quantity=10;f.tables.takeoff_measurement_reviews![0].unit='LF';
  const malicious=request({selections:[{measurementId:MEASUREMENT,assemblyId:'RB-SITE-002',activation:{'RB-SITE-002.m01':true,'RB-SITE-002.m02':false,'RB-SITE-002.m03':false},
    componentInputs:{'RB-SITE-002.m01':{barrier_height_ft:{value:'globalThis.roughbidUnsafeExecution = true',unit:'ft',reviewed:true,sourceRef:'user-supplied-string'}}}}]});
  const response=await handleConstructionBudgetRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/construction-budget`,{method:'POST',headers:{'x-workspace-id':WORKSPACE},body:JSON.stringify(malicious)}),f.db,f.writer,()=>AT);
  assert.equal(response.status,422);assert.equal(Object.hasOwn(globalThis,'roughbidUnsafeExecution'),false);assert.equal(f.calls.length,0);
});

test('equipment usage requires explicit scoped allocation and cannot replace or double-charge physical evidence',async()=>{
  const f=fixture(),base=request().selections[0],allocation={quantity:2,unit:'EA',reviewed:true,sourceRef:'reviewed-hand-tools-use-allocation-1'};
  const saved:any=await f.service.calculate(PROJECT,request({selections:[{...base,equipmentAllocations:{hand_tools:allocation}}]}));
  const equipment=saved.result.lines.find((line:any)=>line.itemId==='equipment:hand_tools');assert.equal(equipment.quantity,2);assert.equal(equipment.cost,null);
  assert.equal(saved.result.trace.find((trace:any)=>trace.measurement).measurement.quantity,25);assert.equal(saved.result.totalUsd,null);
  assert.ok(saved.result.trace.some((trace:any)=>trace.kind==='manual_equipment_allocation'&&trace.physicalMeasureUnchanged===true));
  await assert.rejects(f.service.calculate(PROJECT,request({selections:[{...base,equipmentAllocations:{unreferenced_machine:allocation}}]})),status(422));
  await assert.rejects(f.service.calculate(PROJECT,request({selections:[{...base,equipmentAllocations:{hand_tools:{...allocation,quantity:-1}}}]})),status(422));
  const secondId='50000000-0000-4000-8000-000000000002';f.tables.takeoff_measurement_reviews!.push({...f.tables.takeoff_measurement_reviews![0],id:secondId,quantity:15});
  await assert.rejects(f.service.calculate(PROJECT,request({selections:[{...base,equipmentAllocations:{hand_tools:allocation}},{...base,measurementId:secondId,equipmentAllocations:{hand_tools:allocation}}]})),status(422));
});
test('purchasing groups sum distinct reviewed elements before package rounding and preserve each source trace',async()=>{
  const f=fixture(),secondId='50000000-0000-4000-8000-000000000002';
  f.tables.takeoff_measurement_reviews!.push({...f.tables.takeoff_measurement_reviews![0],id:secondId,label:'Second distinct reviewed floor',quantity:15});
  await f.service.importQuotes(PROJECT,{quotes:[quote({quotedQuantity:4})]});
  const first=request().selections[0];
  const saved:any=await f.service.calculate(PROJECT,boundRequest({selections:[first,{...first,measurementId:secondId}]}));
  const material=saved.result.lines.filter((line:any)=>line.itemId===COMPONENT);assert.equal(material.length,1);assert.equal(material[0].quantity,4);assert.equal(material[0].knownSubtotal,80);
  const sourceTraces=saved.result.trace.filter((entry:any)=>entry.measurement);
  assert.equal(sourceTraces.length,2);assert.deepEqual(sourceTraces.map((entry:any)=>entry.measurement.quantity),[25,15]);assert.equal(saved.result.totalUsd,null);
  assert.ok(saved.result.fiscal.pendingNodes.length>0);assert.equal(saved.result.fiscal.totalUsd,null);
});
test('per-purchase tax and refundable deposits cannot be multiplied into material unit rates or a complete total',async()=>{
  const f=fixture(),source=quote();source.charges.tax={required:true,amount:5,refundable:false,sourceRef:'tax-document-line'} as any;
  source.charges.refundableDeposit={required:true,amount:100,refundable:true,sourceRef:'refundable-deposit-document-line'} as any;
  await f.service.importQuotes(PROJECT,{quotes:[source]});
  const saved:any=await f.service.calculate(PROJECT,boundRequest());assert.equal(saved.result.knownSubtotalUsd,60);assert.equal(saved.result.totalUsd,null);
  assert.equal(saved.result.lines.find((line:any)=>line.itemId===COMPONENT).knownSubtotal,60);
  assert.ok(saved.result.missingInputs.some((reason:string)=>reason.includes('quote_purchase_charges_allocation_pending')));
});
test('budget history loads only one bounded result, retrieves an older exact snapshot and denies cross-project identities',async()=>{
  const f=fixture();
  f.tables.construction_budget_snapshots=Array.from({length:7},(_,i)=>({id:`60000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
    workspace_id:WORKSPACE,project_id:PROJECT,source_kind:'plan',source_run_id:RUN,selection_count:1,location:LOCATION,created_at:`2026-10-02T16:00:0${6-i}Z`,
    result:{status:'pending',totalUsd:null,knownSubtotalUsd:i,lines:[{evidence:'x'.repeat(900_000)}],trace:[],warnings:[],missingInputs:[]}}));
  const send=(suffix='')=>handleConstructionBudgetRequest(new Request(`https://roughbid.test/api/projects/${PROJECT}/construction-budget${suffix}`,{headers:{'x-workspace-id':WORKSPACE}}),f.db,f.writer,()=>AT);
  const response=await send();assert.equal(response.status,200);const result=await response.json();assert.equal(result.snapshots.length,5);assert.equal(result.hasMoreSnapshots,true);
  assert.equal(result.snapshots.filter((entry:any)=>entry.detailLoaded).length,1);assert.ok(result.snapshots.slice(1).every((entry:any)=>entry.result.lines.length===0&&entry.result.warnings.length>0));
  assert.ok(Buffer.byteLength(JSON.stringify(result))<1_000_000);
  const old=f.tables.construction_budget_snapshots[6]!;const detail=await send(`?snapshot_id=${old.id}`);assert.equal(detail.status,200);const selected=await detail.json();
  const loaded=selected.snapshots.filter((entry:any)=>entry.detailLoaded);assert.equal(loaded.length,1);assert.equal(loaded[0].id,old.id);assert.equal(loaded[0].result.knownSubtotalUsd,6);
  f.tables.construction_budget_snapshots.push({...old,id:'60000000-0000-4000-8000-000000000099',project_id:'20000000-0000-4000-8000-000000000099'});
  assert.equal((await send('?snapshot_id=60000000-0000-4000-8000-000000000099')).status,404);
});
