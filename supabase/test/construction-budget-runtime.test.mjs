import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {photoDatabase,USER,WORKSPACE,PROJECT} from '../../apps/api/test/helpers/photo-db.mjs';
import {handleConstructionBudgetRequest} from '../../apps/api/src/construction-budget/routes.ts';
import researchData from '../../packages/domain/data/roughbid-catalog-base.json' with {type:'json'};
import {validateResearchConstructionCatalog,researchCatalogToConstructionCatalog} from '../../packages/domain/src/research-catalog.ts';

const FILE='30000000-0000-4000-8000-000000000009',RUN='40000000-0000-4000-8000-000000000009',MEASUREMENT='50000000-0000-4000-8000-000000000009';
const OTHER_USER='00000000-0000-4000-8000-000000000099',OTHER_WORKSPACE='10000000-0000-4000-8000-000000000099',OTHER_PROJECT='20000000-0000-4000-8000-000000000099';
const AT='2026-10-02T16:00:00Z';
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
const charge=()=>({required:false,amount:null,refundable:false,sourceRef:'supplier-document-explicit-exclusions'});
function quote(overrides={}){return {schema:'roughbid-supplier-quote-v1',id:'Q1',supplier:'other',supplierName:'Reviewed supplier',location:{country:'US',postalCode:'02110',storeId:'boston',timeZone:'America/New_York'},
  sku:'product-1',variant:null,model:null,specification:'Reviewed exact product specification',specificationReviewed:true,channel:'pickup',quotedQuantity:3,pricedUnit:'BOX',unitPrice:20,currency:'USD',origin:'manual_quote',sourceUrl:null,documentRef:'doc-1',observedAt:AT,evidenceAt:AT,
  sourceUpdatedAt:null,validUntil:'2026-10-03T00:00:00Z',importedAt:AT,reviewedBy:USER,reviewedAt:AT,availability:'in_stock',availableQuantity:10,availabilityAt:AT,coveragePerPricedUnit:{quantity:10,unit:'SF'},unitsPerPackage:1,
  minimumOrderPackages:0,orderIncrement:1,roundingRule:'round_up_increment',charges:{freight:charge(),handling:charge(),tax:charge(),conditionalDiscount:charge(),refundableDeposit:charge()},...overrides};}
function measurement(){return {measurementId:MEASUREMENT,expectedRevision:0,fileSha256:'a'.repeat(64),pageSha256:'b'.repeat(64),physicalPageNumber:1,regionKey:'floor-region',regionBounds:[0,0,1,1],
  canonicalElementKey:'floor-1',canonicalTrade:'floor-protection',label:'Reviewed floor',geometry:{type:'rectangle',points:[[0,0],[0.5,0.5]]},sourceKind:'manual_trace',sourceExcerpt:'Traced actual rectangle on pinned PDF page',decision:'accepted',
  geometryReviewed:true,identityReviewed:true,duplicateReviewComplete:true,uncertainty:[],boundaryEvidence:{method:'human_trace',reviewed:true,sourceExcerpt:'Human traced actual straight floor boundaries'},calibrationEvidence:[
    {sourceId:'dimA',sourceType:'explicit_dimension',sourceExcerpt:'Dimension A 5ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0],[0.5,0]],independenceVerified:true},
    {sourceId:'dimB',sourceType:'graphic_scale',sourceExcerpt:'Independent bar B 5ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0.1],[0.5,0.1]],independenceVerified:true}]};}
async function database(){
  const fixture=await photoDatabase();
  try{
    await fixture.sql.exec(migration('20261002140000_takeoff_measurement_review.sql'));
    await fixture.sql.exec(migration('20261002170000_construction_budget.sql'));
    await fixture.sql.exec(`
      insert into project_files(id,workspace_id,project_id)values('${FILE}','${WORKSPACE}','${PROJECT}');
      insert into takeoff_runs(id,workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by)values('${RUN}','${WORKSPACE}','${PROJECT}','${FILE}','full',repeat('a',64),'takeoff-v2.2-durable','${USER}');
      insert into plan_sheets(takeoff_run_id,workspace_id,project_id,file_id,physical_page_number,page_sha256,width_points,height_points,rotation_degrees,content_kind,text_quality,status,status_reason)
        values('${RUN}','${WORKSPACE}','${PROJECT}','${FILE}',1,repeat('b',64),100,100,0,'vector','good','review_required','local fixture');
      insert into auth.users values('${OTHER_USER}');insert into profiles values('${OTHER_USER}',false);insert into workspaces values('${OTHER_WORKSPACE}',now());
      insert into workspace_members values('${OTHER_WORKSPACE}','${OTHER_USER}','estimator');insert into projects values('${OTHER_PROJECT}','${OTHER_WORKSPACE}');
      create or replace function private.has_workspace_role(p_workspace uuid,p_roles text[]) returns boolean language sql stable security definer set search_path=public,auth,pg_temp
        as 'select exists(select 1 from workspace_members where workspace_id=p_workspace and user_id=auth.uid() and role=any(p_roles))';
      grant usage on schema private,auth to authenticated;grant execute on function auth.uid() to authenticated;
    `);
    const reviewed=await fixture.client.rpc('record_takeoff_measurement_review',{p_run_id:RUN,p_workspace_id:WORKSPACE,p_user_id:USER,p_review:measurement()});
    assert.equal(reviewed.error,null);assert.equal(Number(reviewed.data.quantity),25);
    // The existing fixture implements scalar Supabase projections. Translate
    // JSON aliases from the real saved columns, preserving SQL filters/RLS.
    const rawFrom=fixture.client.from.bind(fixture.client);
    fixture.client.from=table=>{
      const builder=rawFrom(table),rawSelect=builder.select.bind(builder),rawThen=builder.then.bind(builder);let fields=null;
      builder.select=columns=>{
        const selected=columns.split(',').map(field=>({field,alias:field.match(/^([a-z_]\w*):([a-z_]\w*)->([a-z_]\w*)$/i)}));
        if(!selected.some(value=>value.alias))return rawSelect(columns);fields=selected;
        return rawSelect([...new Set(selected.map(value=>value.alias?value.alias[2]:value.field))].join(','));
      };
      builder.then=(resolve,reject)=>rawThen(response=>{
        if(!fields||response.error)return resolve(response);
        const project=row=>row===null?null:Object.fromEntries(fields.map(({field,alias})=>alias?[alias[1],row[alias[2]]?.[alias[3]]??null]:[field,row[field]]));
        return resolve({...response,data:Array.isArray(response.data)?response.data.map(project):project(response.data)});
      },reject);
      return builder;
    };
    return fixture;
  }catch(error){await fixture.close();throw error;}
}
async function saveQuote(db,quotes=[quote()],user=USER,workspace=WORKSPACE,project=PROJECT){return db.query('select save_construction_supplier_quotes($1,$2,$3,$4) as result',[user,workspace,project,JSON.stringify(quotes)]);}
function snapshot(overrides={}){return {user:USER,workspace:WORKSPACE,project:PROJECT,source:'plan',run:RUN,count:1,hash:'d'.repeat(64),
  inputs:{sourceKind:'plan',runId:RUN,selections:[{measurementId:MEASUREMENT,assemblyId:'RB-SITE-001'}]},
  result:{status:'pending',coverage:'partial',humanReviewRequired:true,knownSubtotalUsd:0,totalUsd:null,missingInputs:['material:missing_price','independent_review_pending']},location:null,...overrides};}
async function saveSnapshot(db,value=snapshot()){return (await db.query('select save_construction_budget_snapshot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
  [value.user,value.workspace,value.project,value.source,value.run,value.count,value.hash,JSON.stringify(value.inputs),JSON.stringify(value.result),value.location===null?null:JSON.stringify(value.location)])).rows[0].result;}

test('actual quote/snapshot migrations expose tenant reads and service-only guarded immutable writes',async()=>{const f=await database();try{
  const permission=(await f.sql.query(`select has_table_privilege('authenticated','construction_supplier_quotes','INSERT') as browser_insert,
    has_table_privilege('service_role','construction_supplier_quotes','UPDATE') as service_update,has_table_privilege('service_role','construction_budget_snapshots','DELETE') as service_delete,
    has_function_privilege('authenticated','save_construction_supplier_quotes(uuid,uuid,uuid,jsonb)','EXECUTE') as browser_rpc,
    has_function_privilege('service_role','save_construction_supplier_quotes(uuid,uuid,uuid,jsonb)','EXECUTE') as service_rpc`)).rows[0];
  assert.deepEqual(permission,{browser_insert:false,service_update:false,service_delete:false,browser_rpc:false,service_rpc:true});
  await saveQuote(f.sql);await saveQuote(f.sql,[quote({id:'OTHER',reviewedBy:OTHER_USER})],OTHER_USER,OTHER_WORKSPACE,OTHER_PROJECT);
  await f.sql.exec('set role authenticated');const visible=await f.sql.query('select quote_key from construction_supplier_quotes');assert.deepEqual(visible.rows,[{quote_key:'Q1'}]);
  await assert.rejects(f.sql.query('delete from construction_supplier_quotes'),/permission denied/);
  await assert.rejects(saveQuote(f.sql),/permission denied/);await f.sql.exec('reset role');
}finally{await f.sql.exec('reset role');await f.close();}});
test('quote evidence identity is immutable and import time cannot renew old dates or change the authenticated reviewer',async()=>{const f=await database();try{
  const old='2026-10-01T16:00:00Z';await saveQuote(f.sql,[quote({origin:'cache',observedAt:old,evidenceAt:old,importedAt:old,reviewedAt:old})]);
  await saveQuote(f.sql,[quote({origin:'cache',observedAt:old,evidenceAt:old,importedAt:AT,reviewedAt:AT})]);
  const row=(await f.sql.query('select quote from construction_supplier_quotes')).rows[0].quote;assert.equal(row.evidenceAt,old);assert.equal(row.importedAt,old);
  await assert.rejects(saveQuote(f.sql,[quote({origin:'cache',evidenceAt:AT})]),/cannot be silently replaced/);
  await assert.rejects(saveQuote(f.sql,[quote({id:'Q2',reviewedBy:OTHER_USER})]),/reviewer identity/);
  await assert.rejects(saveQuote(f.sql,[quote({id:'Q2',origin:'partner_api'})]),/source\/reviewer/);
  await assert.rejects(saveQuote(f.sql,[quote()],USER,OTHER_WORKSPACE,OTHER_PROJECT),/access denied/);
  assert.equal((await f.sql.query('select count(*)::int as count from construction_supplier_quotes')).rows[0].count,1);
}finally{await f.close();}});
test('snapshots pin reviewed source scope, retain missing-price totals as null and cannot change a saved hash',async()=>{const f=await database();try{
  const first=await saveSnapshot(f.sql),repeat=await saveSnapshot(f.sql);assert.equal(repeat.id,first.id);
  const stored=(await f.sql.query('select result,plan_run_id,photo_run_id from construction_budget_snapshots where id=$1',[first.id])).rows[0];
  assert.equal(stored.result.totalUsd,null);assert.equal(stored.plan_run_id,RUN);assert.equal(stored.photo_run_id,null);
  await assert.rejects(saveSnapshot(f.sql,snapshot({result:{...snapshot().result,knownSubtotalUsd:99}})),/Snapshot identity changed/);
  await assert.rejects(saveSnapshot(f.sql,snapshot({hash:'e'.repeat(64),source:'photo'})),/photo scope denied/);
  await assert.rejects(saveSnapshot(f.sql,snapshot({hash:'e'.repeat(64),workspace:OTHER_WORKSPACE,project:OTHER_PROJECT})),/access denied/);
  for(const result of [{...snapshot().result,totalUsd:99},{...snapshot().result,coverage:'complete'},{...snapshot().result,humanReviewRequired:'true'}])
    await assert.rejects(saveSnapshot(f.sql,snapshot({hash:'e'.repeat(64),result})),/review gate is invalid/);
  await f.sql.exec(`update workspace_members set role='viewer' where workspace_id='${WORKSPACE}' and user_id='${USER}'`);
  await assert.rejects(saveSnapshot(f.sql,snapshot({hash:'e'.repeat(64)})),/access denied/);
  assert.equal((await f.sql.query('select count(*)::int as count from construction_budget_snapshots')).rows[0].count,1);
}finally{await f.close();}});
test('photo snapshot foreign keys preserve its separate tenant-scoped parent instead of a PDF run',async()=>{const f=await database();try{
  const photoRun='60000000-0000-4000-8000-000000000009';
  await f.sql.exec(`insert into photo_takeoff_runs(id,workspace_id,project_id,requested_by,request_key,profile_hash,provider,model,manifest,asset_ids,status,result)
    values('${photoRun}','${WORKSPACE}','${PROJECT}','${USER}',gen_random_uuid(),repeat('c',64),'openai','offline-mock-model','{}','{}','needs_review','{"approvedMeasurements":[{"id":"photo-floor-1","quantity":25,"unit":"SF"}]}');`);
  const saved=await saveSnapshot(f.sql,snapshot({source:'photo',run:photoRun,inputs:{sourceKind:'photo',runId:photoRun,selections:[{measurementId:'photo-floor-1',assemblyId:'RB-SITE-001'}]}}));
  const row=(await f.sql.query('select plan_run_id,photo_run_id,source_run_id from construction_budget_snapshots where id=$1',[saved.id])).rows[0];
  assert.deepEqual(row,{plan_run_id:null,photo_run_id:photoRun,source_run_id:photoRun});
}finally{await f.close();}});
test('authenticated HTTP calculation reads real reviewed geometry and documented quote rows, persists a partial snapshot and reloads it',async()=>{const f=await database();try{
  const catalog=researchCatalogToConstructionCatalog(validateResearchConstructionCatalog(researchData)),component='RB-SITE-001.m01';
  const material=structuredClone(catalog.items.find(item=>item.id===component));
  Object.assign(material,{reviewed:true,specification:'Reviewed exact floor protection product',specificationSource:{name:'Reviewed product document',url:null,documentRef:'product-doc-1',effectiveDate:'2026-10-02',place:'US 02110'},
    rate:{amount:999999,source:null,reviewed:true},wastePercent:0,pack:{pricedUnit:'BOX',coverageQuantity:10,coverageUnit:'SF',unitsPerPackage:1,minimumOrderPackages:0,orderIncrement:1,roundingRule:'round_up_increment'}});
  const send=(endpoint,method='GET',body)=>handleConstructionBudgetRequest(new Request(`https://offline.test/api/projects/${PROJECT}/${endpoint}`,{method,headers:{'x-workspace-id':WORKSPACE},...(body?{body:JSON.stringify(body)}:{})}),f.client,f.client,()=>AT);
  assert.equal((await send('supplier-quotes','POST',{quotes:[quote({reviewedBy:'spoofed'})]})).status,201);
  const calculated=await send('construction-budget','POST',{sourceKind:'plan',runId:RUN,location:quote().location,quoteIds:['Q1'],
    selections:[{measurementId:MEASUREMENT,assemblyId:'RB-SITE-001',quantity:999999,activation:{[component]:true,'RB-SITE-001.m02':false},componentInputs:{}}],
    catalogOverrides:{schema:catalog.schema,items:[material]},quoteBindings:[{componentId:component,quoteId:'Q1',supplier:'other',sku:'product-1',variant:null,channel:'pickup',specificationReviewed:true}]});
  assert.equal(calculated.status,201);const result=await calculated.json();assert.equal(result.result.knownSubtotalUsd,60);assert.equal(result.result.totalUsd,null);
  assert.equal(result.result.trace[0].measurement.quantity,25);assert.equal(result.result.trace[0].measurement.reviewStatus,'accepted');
  const restored=await send('construction-budget');assert.equal(restored.status,200);const history=await restored.json();assert.equal(history.snapshots[0].id,result.id);
  assert.deepEqual(history.snapshots[0].result,result.result);
  const quoteRow=(await f.sql.query('select quote,imported_by from construction_supplier_quotes')).rows[0];assert.equal(quoteRow.imported_by,USER);assert.equal(quoteRow.quote.reviewedBy,USER);
  const row=(await f.sql.query('select result,inputs from construction_budget_snapshots')).rows[0];assert.equal(row.inputs.selections[0].quantity,999999);assert.equal(row.result.trace[0].measurement.quantity,25);
}finally{await f.close();}});
