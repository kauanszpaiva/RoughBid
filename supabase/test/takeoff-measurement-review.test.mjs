import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync}from'node:fs';import{PGlite}from'@electric-sql/pglite';
const user='00000000-0000-4000-8000-000000000001',workspace='10000000-0000-4000-8000-000000000001',project='20000000-0000-4000-8000-000000000001',file='30000000-0000-4000-8000-000000000001',run='40000000-0000-4000-8000-000000000001';
const migration=name=>readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');
function review(overrides={}){return{measurementId:'50000000-0000-4000-8000-000000000001',expectedRevision:0,fileSha256:'a'.repeat(64),pageSha256:'b'.repeat(64),physicalPageNumber:1,regionKey:'main-plan',regionBounds:[0,0,1,1],canonicalElementKey:'wall-W1',canonicalTrade:'drywall',label:'Reviewed wall',geometry:{type:'line',points:[[0,0],[1,0]]},sourceKind:'manual_trace',sourceExcerpt:'Dimensioned wall W1',decision:'accepted',geometryReviewed:true,identityReviewed:true,duplicateReviewComplete:true,uncertainty:[],boundaryEvidence:{method:'human_trace',reviewed:true,sourceExcerpt:'Actual traced endpoints.'},calibrationEvidence:[
  {sourceId:'A',sourceType:'explicit_dimension',sourceExcerpt:'Dimension A:5ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0],[0.5,0]],independenceVerified:true},
  {sourceId:'B',sourceType:'graphic_scale',sourceExcerpt:'Independent barB:5ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0.1],[0.5,0.1]],independenceVerified:true}],...overrides};}
async function database(){const db=new PGlite();await db.exec(`
create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema private;
create table auth.users(id uuid primary key);create table profiles(id uuid primary key,is_platform_admin boolean);create table workspaces(id uuid primary key,ai_processing_consented_at timestamptz);create table workspace_members(workspace_id uuid,user_id uuid,role text);
create table projects(id uuid primary key,workspace_id uuid,unique(id,workspace_id));create table project_files(id uuid primary key,workspace_id uuid,project_id uuid,unique(id,workspace_id,project_id));
create function auth.uid() returns uuid language sql stable as 'select null::uuid';create function private.has_workspace_role(uuid,text[]) returns boolean language sql stable as 'select true';create function private.has_product_access() returns boolean language sql stable as 'select true';
insert into auth.users values('${user}');insert into profiles values('${user}',true);insert into workspaces values('${workspace}',now());insert into workspace_members values('${workspace}','${user}','estimator');insert into projects values('${project}','${workspace}');insert into project_files values('${file}','${workspace}','${project}');`);
await db.exec(migration('20260910225937_takeoff_v2_foundation.sql'));await db.exec(migration('20261002140000_takeoff_measurement_review.sql'));
await db.exec(`insert into takeoff_runs(id,workspace_id,project_id,file_id,mode,file_sha256,orchestrator_version,requested_by)values('${run}','${workspace}','${project}','${file}','full',repeat('a',64),'takeoff-v2.2-durable','${user}');
insert into plan_sheets(takeoff_run_id,workspace_id,project_id,file_id,physical_page_number,page_sha256,width_points,height_points,rotation_degrees,content_kind,text_quality,status,status_reason)values('${run}','${workspace}','${project}','${file}',1,repeat('b',64),100,100,0,'vector','good','review_required','test');`);return db;}
const save=async(db,input=review(),actor=user)=>(await db.query('select record_takeoff_measurement_review($1,$2,$3,$4) as result',[run,workspace,actor,JSON.stringify(input)])).rows[0].result;
test('migration grants read-only browser/service tables and only service role can review',async()=>{const db=await database();try{
const permissions=(await db.query("select has_table_privilege('service_role','takeoff_measurement_reviews','UPDATE') as service_write,has_table_privilege('authenticated','takeoff_measurement_reviews','INSERT') as browser_write,has_function_privilege('authenticated','record_takeoff_measurement_review(uuid,uuid,uuid,jsonb)','EXECUTE') as browser_rpc,has_function_privilege('service_role','record_takeoff_measurement_review(uuid,uuid,uuid,jsonb)','EXECUTE') as service_rpc")).rows[0];assert.deepEqual(permissions,{service_write:false,browser_write:false,browser_rpc:false,service_rpc:true});
const row=await save(db,review({quantity:999999}));assert.equal(Number(row.quantity),10);assert.equal(row.unit,'LF');assert.equal(row.review_revision,1);assert.equal(row.proof.fileSha256,'a'.repeat(64));
await assert.rejects(save(db,review({measurementId:'50000000-0000-4000-8000-000000000004',canonicalElementKey:'renamed-wall',regionKey:'overlapping-region',geometry:{type:'polyline',points:[[1,0],[0,0]]}})),/duplicate key/);
await assert.rejects(save(db,review({expectedRevision:0})),/revision conflict/);const corrected=await save(db,review({expectedRevision:1,geometry:{type:'rectangle',points:[[0,0],[0.5,0.5]]}}));assert.equal(Number(corrected.quantity),25);assert.equal(corrected.unit,'SF');assert.equal(corrected.review_revision,2);
await assert.rejects(save(db,review({measurementId:'50000000-0000-4000-8000-000000000005',canonicalElementKey:'renamed-surface',geometry:{type:'polygon',points:[[0.5,0.5],[0,0.5],[0,0],[0.5,0]]}})),/duplicate key/);
assert.equal((await db.query('select count(*)::int as count from takeoff_measurement_review_events')).rows[0].count,2);
}finally{await db.close();}});
test('SQL rejects cross-tenant/revision access, single/repeated/conflicting scale and fake confirmed quantity',async()=>{const db=await database();try{
await assert.rejects(save(db,review({pageSha256:'c'.repeat(64)})),/page revision mismatch/);await assert.rejects(save(db,review({fileSha256:'c'.repeat(64)})),/file revision mismatch/);
await assert.rejects(save(db,review(),'00000000-0000-4000-8000-000000000002'),/access denied/);
const one=review();one.calibrationEvidence=one.calibrationEvidence.slice(0,1);await assert.rejects(save(db,one),/Two agreeing/);
const repeated=review();repeated.calibrationEvidence[1]={...repeated.calibrationEvidence[0]};await assert.rejects(save(db,repeated),/not independent/);
const conflict=review();conflict.calibrationEvidence[1].drawingLength=15;await assert.rejects(save(db,conflict),/Two agreeing/);
await assert.rejects(save(db,review({duplicateReviewComplete:false})),/human geometry/);await assert.rejects(save(db,review({geometry:{type:'polygon',points:[[0,0],[1,1],[0,1],[1,0]]}})),/Self-intersecting/);
await assert.rejects(save(db,review({boundaryEvidence:undefined})),/surface boundary/);
const candidate=await save(db,review({decision:'candidate',geometryReviewed:false,calibrationEvidence:[],quantity:100}));assert.equal(candidate.quantity,null);assert.equal(candidate.unit,null);
}finally{await db.close();}});
test('EA requires reviewed identity and duplicate keys cannot double count an element or exact geometry',async()=>{const db=await database();try{
const count=review({geometry:{type:'count',points:[[0.2,0.2]]},sourceKind:'manual_observed_count',canonicalElementKey:'window-W1',calibrationEvidence:[]});const row=await save(db,count);assert.equal(Number(row.quantity),1);assert.equal(row.unit,'EA');
await assert.rejects(save(db,{...count,measurementId:'50000000-0000-4000-8000-000000000002'}),/duplicate key/);
await assert.rejects(save(db,{...count,measurementId:'50000000-0000-4000-8000-000000000003',canonicalElementKey:'alternate-tag-for-same-window'}),/duplicate key/);
await assert.rejects(save(db,{...count,measurementId:'50000000-0000-4000-8000-000000000004',canonicalElementKey:'same-window-other-region',regionKey:'overlap',regionBounds:[0,0,0.5,0.5],geometry:{type:'point',points:[[0.2,0.2]]}}),/duplicate key/);
await save(db,{...count,expectedRevision:1,decision:'rejected'});assert.equal((await db.query("select quantity from takeoff_measurement_reviews where id=$1",[count.measurementId])).rows[0].quantity,null);
assert.equal((await db.query('select count(*)::int as count from takeoff_measurement_review_events')).rows[0].count,2);
}finally{await db.close();}});
test('native bounding boxes require actual rectangular-surface review, including equivalent polygon encodings',async()=>{const db=await database();try{
const nativeCandidate={id:'c'.repeat(64),source:'native_pdf_vector',fileSha256:'a'.repeat(64),pageSha256:'b'.repeat(64),physicalPageNumber:1,bbox:[0,0,0.5,0.5]};
const proposed=review({sourceKind:'native_vector_candidate',sourceCandidateId:nativeCandidate.id,nativeCandidate,geometry:{type:'rectangle',points:[[0,0],[0.5,0.5]]}});
await assert.rejects(save(db,proposed),/Native extent/);
await assert.rejects(save(db,{...proposed,geometry:{type:'polygon',points:[[0,0],[0.25,0],[0.5,0],[0.5,0.5],[0,0.5]]}}),/Native extent/);
await assert.rejects(save(db,{...proposed,nativeCandidate:{...nativeCandidate,physicalPageNumber:2}}),/proof unavailable/);
const row=await save(db,{...proposed,boundaryEvidence:{method:'verified_rectangular_surface',reviewed:true,sourceExcerpt:'Human compared all four actual straight surface boundaries to the source drawing.'}});
assert.equal(Number(row.quantity),25);assert.equal(row.proof.boundaryEvidence.method,'verified_rectangular_surface');
}finally{await db.close();}});
