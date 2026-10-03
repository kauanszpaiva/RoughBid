import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import { reviewMeasurement, nativeMeasurementCandidates, geometryMatchesNativeExtent, loadAcceptedGeometryMeasurements, type MeasurementScope } from '../src/takeoff-v2/measurement-review.ts';
import { handleMeasurementReviewRequest } from '../src/takeoff-v2/measurement-routes.ts';

const scope:MeasurementScope={runId:'run',workspaceId:'workspace',projectId:'project',fileId:'file',fileSha256:'a'.repeat(64),pageSha256:'b'.repeat(64),physicalPageNumber:1,widthPoints:100,heightPoints:100,rotationDegrees:0};
function input(overrides:Record<string,unknown>={}) {
  return {measurementId:'40000000-0000-4000-8000-000000000001',expectedRevision:0,fileSha256:scope.fileSha256,pageSha256:scope.pageSha256,physicalPageNumber:1,
    regionKey:'main-plan',regionBounds:[0,0,1,1],canonicalElementKey:'wall-W1-side-A',canonicalTrade:'drywall',label:'Reviewed wall segment',
    geometry:{type:'line',points:[[0,0],[1,0]]},sourceKind:'manual_trace',sourceExcerpt:'Wall W1 between reviewed corners.',decision:'accepted',
    geometryReviewed:true,identityReviewed:true,duplicateReviewComplete:true,uncertainty:[],boundaryEvidence:{method:'human_trace',reviewed:true,sourceExcerpt:'Human traced actual wall endpoints on the source sheet.'},calibrationEvidence:[
      {sourceId:'dimension-A',sourceType:'explicit_dimension',sourceExcerpt:'Dimension A: 5 ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0],[0.5,0]],independenceVerified:true},
      {sourceId:'dimension-B',sourceType:'graphic_scale',sourceExcerpt:'Independent bar B: 5 ft',unit:'ft',drawingLength:5,pdfPoints:50,referenceLine:[[0,0.1],[0.5,0.1]],independenceVerified:true},
    ],...overrides};
}

test('human-reviewed geometry computes LF/SF from two scoped references and ignores proposed quantities',()=>{
  const line=reviewMeasurement(input({quantity:999999}),scope);assert.equal(line.quantity,10);assert.equal(line.unit,'LF');
  const area=reviewMeasurement(input({geometry:{type:'rectangle',points:[[0,0],[0.5,0.5]]}}),scope);assert.equal(area.quantity,25);assert.equal(area.unit,'SF');
  assert.equal(area.calibration?.verificationStatus,'verified');assert.equal(area.humanReviewRequired,true);
});
test('metric and inch references convert once to canonical feet and rotated display dimensions stay reproducible',()=>{
  const value=input();value.calibrationEvidence[0]!.unit='m';value.calibrationEvidence[0]!.drawingLength=1.524;
  value.calibrationEvidence[1]!.unit='in';value.calibrationEvidence[1]!.drawingLength=60;
  assert.equal(reviewMeasurement(value,scope).quantity,10);
  const rotated={...scope,widthPoints:200,heightPoints:100,rotationDegrees:90};
  assert.equal(reviewMeasurement(input(),rotated).quantity,10);
});
test('one scale reference, repeats, conflicting scale, unresolved uncertainty and wrong revision fail before acceptance',()=>{
  const one=input();one.calibrationEvidence=one.calibrationEvidence.slice(0,1);assert.throws(()=>reviewMeasurement(one,scope),/two_agreeing/);
  const repeated=input();repeated.calibrationEvidence[1]={...repeated.calibrationEvidence[0]!};assert.throws(()=>reviewMeasurement(repeated,scope),/Repeated references/);
  const conflict=input();conflict.calibrationEvidence[1]!.drawingLength=15;assert.throws(()=>reviewMeasurement(conflict,scope),/two_agreeing/);
  assert.throws(()=>reviewMeasurement(input({uncertainty:['Hidden segment unresolved']}),scope),/uncertainty_unresolved/);
  assert.throws(()=>reviewMeasurement(input({pageSha256:'c'.repeat(64)}),scope),/another file/);
  assert.throws(()=>reviewMeasurement(input({geometryReviewed:false}),scope),/geometry_review_required/);
});
test('candidate quantities remain null, degenerate/bow-tie/out-of-region geometry cannot masquerade as accepted area',()=>{
  assert.equal(reviewMeasurement(input({decision:'candidate',calibrationEvidence:[],geometryReviewed:false}),scope).quantity,null);
  assert.throws(()=>reviewMeasurement(input({geometry:{type:'rectangle',points:[[0,0],[0.5,0]]}}),scope),/degenerate/);
  assert.throws(()=>reviewMeasurement(input({geometry:{type:'polygon',points:[[0,0],[1,1],[0,1],[1,0]]}}),scope),/Self-intersecting/);
  assert.throws(()=>reviewMeasurement(input({regionBounds:[0,0,0.2,0.2]}),scope),/inside the reviewed region/);
});
test('actual boundary evidence is required and a native extent cannot become a contour by changing its encoding',()=>{
  assert.throws(()=>reviewMeasurement(input({boundaryEvidence:undefined}),scope),/actual_boundary_review_required/);
  assert.throws(()=>reviewMeasurement(input({boundaryEvidence:{method:'verified_rectangular_surface',reviewed:true,sourceExcerpt:'Actual rectangular surface'}}),scope),/rectangular geometry/);
  assert.equal(geometryMatchesNativeExtent({type:'rectangle',points:[[0,0],[0.5,0.5]]},[0,0,0.5,0.5]),true);
  assert.equal(geometryMatchesNativeExtent({type:'polygon',points:[[0,0],[0.25,0],[0.5,0],[0.5,0.5],[0,0.5]]},[0,0,0.5,0.5]),true);
  assert.equal(geometryMatchesNativeExtent({type:'polygon',points:[[0,0],[0.5,0],[0.5,0.5],[0.2,0.3],[0,0.5]]},[0,0,0.5,0.5]),false);
});
test('EA needs observed identity and duplicate review, not invented physical scale',()=>{
  const count=input({geometry:{type:'count',points:[[0.3,0.3]]},sourceKind:'manual_observed_count',canonicalElementKey:'distinct-window-W1',calibrationEvidence:[]});
  const result=reviewMeasurement(count,scope);assert.equal(result.quantity,1);assert.equal(result.unit,'EA');assert.equal(result.calibration,null);
  assert.throws(()=>reviewMeasurement({...count,duplicateReviewComplete:false},scope),/identity_and_duplicate/);
});
test('native PDF extraction emits bounded contours as null-quantity candidates with revision proof',async()=>{
  const doc=await PDFDocument.create(),page=doc.addPage([100,100]);page.drawRectangle({x:10,y:10,width:70,height:70,borderWidth:2,borderColor:rgb(0,0,0)});
  const bytes=new Uint8Array(await doc.save()),fileSha256=createHash('sha256').update(bytes).digest('hex');
  const result=await nativeMeasurementCandidates(bytes,{...scope,fileSha256});
  assert.ok(result.candidates.length>0);assert.ok(result.candidates.every(candidate=>candidate.quantity===null&&candidate.unit===null&&candidate.status==='candidate'));
  assert.ok(result.candidates.every(candidate=>candidate.pageSha256===scope.pageSha256));assert.ok(result.limitations.length>0);
  await assert.rejects(nativeMeasurementCandidates(bytes,scope),/Stored PDF changed/);
  await assert.rejects(nativeMeasurementCandidates(bytes,{...scope,fileSha256,widthPoints:200}),/display frame/);
});
function query(data:unknown) {const builder:any={};for(const method of['select','eq','maybeSingle','order','range','limit'])builder[method]=()=>builder;builder.then=(resolve:any)=>Promise.resolve({data,error:null}).then(resolve);return builder;}
function db(role='estimator') {return {auth:{getUser:async()=>({data:{user:{id:'user'}},error:null})},from(table:string){
  if(table==='profiles')return query({is_platform_admin:true});if(table==='workspace_members')return query({role});if(table==='workspaces')return query({ai_processing_consented_at:'2026-10-02'});
  if(table==='projects')return query({id:'project'});if(table==='takeoff_runs')return query({id:'run',project_id:'project',file_id:'file',file_sha256:scope.fileSha256,manifest:{physicalPageCount:1}});
  if(table==='plan_sheets')return query({page_sha256:scope.pageSha256,width_points:100,height_points:100,rotation_degrees:0});if(table==='takeoff_measurement_reviews')return query([]);throw new Error('Unexpected mock table');
}};}
test('review API authenticates project/run scope and preserves source context even before any measurement',async()=>{
  const request=new Request('https://test/api/takeoff-runs/run/measurements?page_number=1',{headers:{'x-workspace-id':'workspace'}});
  const response=await handleMeasurementReviewRequest(request,db() as never,{writer:{from:()=>{throw new Error('GET cannot write');}}});
  assert.equal(response.status,200);const result=await response.json();assert.equal(result.fileSha256,scope.fileSha256);assert.equal(result.sheet.displayWidthPoints,100);assert.deepEqual(result.measurements,[]);
  const denied=await handleMeasurementReviewRequest(request,db('viewer') as never,{writer:{from:()=>{}}});assert.equal(denied.status,403);
});
test('review API saves scoped reviewed evidence, strips proposed quantity and bounds input before persistence',async()=>{
  const calls:any[]=[];
  const writer={from:()=>{},rpc:async(name:string,args:any)=>{calls.push({name,args});return {data:{quantity:10,unit:'LF',review_revision:1},error:null};}};
  const response=await handleMeasurementReviewRequest(new Request('https://test/api/takeoff-runs/run/measurements',{method:'POST',headers:{'x-workspace-id':'workspace'},body:JSON.stringify(input({quantity:999999}))}),db() as never,{writer});
  assert.equal(response.status,201);assert.equal((await response.json()).measurement.quantity,10);
  assert.equal(calls[0].name,'record_takeoff_measurement_review');assert.equal(calls[0].args.p_user_id,'user');assert.equal(calls[0].args.p_workspace_id,'workspace');
  assert.equal(calls[0].args.p_review.quantity,undefined);assert.equal(calls[0].args.p_review.fileSha256,scope.fileSha256);
  const tooLarge=await handleMeasurementReviewRequest(new Request('https://test/api/takeoff-runs/run/measurements',{method:'POST',headers:{'x-workspace-id':'workspace'},body:JSON.stringify(input({sourceExcerpt:'A'.repeat(50_000)}))}),db() as never,{writer});
  assert.equal(tooLarge.status,413);assert.equal(calls.length,1);
});
test('lost-ack reconciliation finds the exact saved identity beyond the first measurement page',async()=>{
  const rows=Array.from({length:100},(_,i)=>({id:`50000000-0000-4000-8000-${String(i).padStart(12,'0')}`,review_revision:2}));
  const target=rows[99]!,base=db(),filters:Record<string,unknown>={};
  const scoped={...base,from(table:string){if(table!=='takeoff_measurement_reviews')return base.from(table);
    const builder:any={select:()=>builder,order:()=>builder,eq:(key:string,value:unknown)=>{filters[key]=value;return builder;},
      range:async(start:number,end:number)=>({data:rows.filter(row=>!filters.id||row.id===filters.id).slice(start,end+1),error:null})};return builder;
  }};
  const response=await handleMeasurementReviewRequest(new Request(`https://test/api/takeoff-runs/run/measurements?page_number=1&measurement_id=${target.id}`,{headers:{'x-workspace-id':'workspace'}}),scoped as never,{writer:{from:()=>{}}});
  assert.equal(response.status,200);const result=await response.json();assert.deepEqual(result.measurements,[target]);assert.equal(result.nextOffset,null);
  assert.deepEqual(filters,{takeoff_run_id:'run',workspace_id:'workspace',project_id:'project',file_id:'file',file_sha256:scope.fileSha256,physical_page_number:1,id:target.id});
  const invalid=await handleMeasurementReviewRequest(new Request('https://test/api/takeoff-runs/run/measurements?measurement_id=',{headers:{'x-workspace-id':'workspace'}}),scoped as never,{writer:{from:()=>{}}});assert.equal(invalid.status,400);
});
test('accepted geometry runtime loading is bounded and discloses truncated coverage',async()=>{
  const rows=Array.from({length:101},(_,id)=>({id,quantity:1,unit:'EA'}));
  const bundle=await loadAcceptedGeometryMeasurements({from:()=>query(rows)},{...scope});
  assert.equal(bundle.measurements.length,100);assert.equal(bundle.truncated,true);assert.equal(bundle.coverageStatus,'partial');assert.ok(bundle.blockers.length>0);
});
