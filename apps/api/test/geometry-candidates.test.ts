import test from 'node:test';import assert from 'node:assert/strict';
import {kamaiCandidates,apsPropertyCandidates,validProviderGeometry} from '../src/geometry/candidates.ts';
import {loadGeometryProfile} from '../src/geometry/config.ts';
import {normalizeKamaiBlueprint,type KamaiCheckpoint} from '../src/takeoff-v2/kamai-provider.ts';
const polygon={type:'Polygon',coordinates:[[[0,0],[10,0],[10,10],[0,10],[0,0]],[[2,2],[4,2],[4,4],[2,4],[2,2]]]};
const feature=(id:string,kind:string,geometry:any,measurements:any)=>({type:'Feature',properties:{id,kind,class:kind==='area'?'room':'door',name:id,tag:'D01',measurements},geometry});
const checkpoint=(features:any[],scale:any={manual_scaling_needed:false,drawing_scale:'1:50'}):KamaiCheckpoint=>({version:'kamai-adapter-v1',runId:'run',fileSha256:'a'.repeat(64),expectedPageCount:1,
  state:'review_required',projectId:'project',jobId:'job',uploadId:'upload',blueprintId:'blueprint',providerStatus:'OFFLINE_ATTESTED',pollAttempts:2,nextPollAt:null,errorCode:'multipage_completeness_unverified',textOffset:0,
  evidence:normalizeKamaiBlueprint({revision:'rev-1',blueprint:{id:'blueprint',scale,geojson:{type:'FeatureCollection',features},text:[],text_total:0}},'blueprint')});
const scope={runId:'run',fileSha256:'b'.repeat(64),physicalPageNumber:1};
const area=()=>checkpoint([feature('room-1','area',polygon,{area_m2:96,perimeter_m:48})]);
test('Kamai copies SI area/perimeter verbatim, including holes, without applying 1:50 again',()=>{const result=kamaiCandidates(area(),scope);assert.equal(result[0]?.quantity,96);assert.equal(result[0]?.unit,'m2');assert.equal(result[1]?.quantity,48);assert.deepEqual(result[0]?.geometry,polygon);assert.equal(result[0]?.status,'candidate');});
test('Room areas and object surfaces/counts are separate; nonunique tags never deduplicate distinct objects',()=>{const c=checkpoint([feature('room','area',polygon,{area_m2:20}),
  feature('doorA','object',{type:'Point',coordinates:[1,1]},{area_m2:0.2}),feature('doorB','object',{type:'Point',coordinates:[2,1]},{area_m2:0.2})]);
  const result=kamaiCandidates(c,scope);assert.equal(result.filter(x=>x.aggregationGroup==='room_area'&&x.measurementKind==='area')[0]?.quantity,20);
  assert.equal(result.filter(x=>x.aggregationGroup==='individual_object').reduce((n,x)=>n+(x.quantity??0),0),2);assert.equal(result.filter(x=>x.aggregationGroup==='object_surface'&&x.measurementKind==='area').length,2);
});
test('Null measurements remain pending; explicit zero remains zero and is never guessed',()=>{const result=kamaiCandidates(checkpoint([feature('r','area',polygon,{area_m2:null,perimeter_m:0})]),scope);assert.equal(result[0]?.quantity,null);assert.equal(result[0]?.status,'blocked');assert.equal(result[1]?.quantity,0);});
test('Scale absent/manual cannot be approved; folder/text are evidence only',()=>{const result=kamaiCandidates(checkpoint([feature('r','area',polygon,{area_m2:96}),feature('folder','folder',null,{})],{manual_scaling_needed:true}),scope);assert.equal(result.length,2);assert.ok(result.every(x=>x.status==='blocked'&&x.reviewReasons.includes('manual_scaling_required')));});
test('Candidate identity pins source hash, physical page and provider snapshot revision',()=>{const c=area(),a=kamaiCandidates(c,scope)[0]!;assert.notEqual(a.id,kamaiCandidates(c,{...scope,physicalPageNumber:2})[0]?.id);
  assert.notEqual(a.id,kamaiCandidates(c,{...scope,fileSha256:'c'.repeat(64)})[0]?.id);c.evidence!.revision='rev-2';assert.notEqual(a.id,kamaiCandidates(c,scope)[0]?.id);});
test('Exact repeated geometry is blocked within one source/class; per-feature missing evidence does not block valid room',()=>{const result=kamaiCandidates(checkpoint([feature('r1','area',polygon,{area_m2:96}),feature('r2','area',polygon,{area_m2:96}),feature('door','object',null,{})]),scope);
  assert.equal(result[0]?.status,'candidate');assert.ok(result[2]?.reviewReasons.includes('duplicate_geometry_candidate'));});
test('Reject malformed, self-crossing, degenerate, exterior-hole, overlapping-hole and backtracking geometry',()=>{
  assert.equal(validProviderGeometry({}),false);assert.equal(validProviderGeometry({type:'Polygon',coordinates:[[[0,0],[2,2],[0,2],[2,0],[0,0]]]}),false);
  assert.equal(validProviderGeometry({type:'Polygon',coordinates:[[[0,0],[1,0],[2,0],[0,0]]]}),false);
  assert.equal(validProviderGeometry({type:'Polygon',coordinates:[polygon.coordinates[0],[[12,12],[14,12],[14,14],[12,14],[12,12]]]}),false);
  assert.equal(validProviderGeometry({type:'LineString',coordinates:[[0,0],[0,0]]}),false);assert.equal(validProviderGeometry({type:'LineString',coordinates:[[0,0],[2,0],[1,0]]}),false);
  assert.equal(validProviderGeometry({type:'Point',coordinates:[0,0,Number.NaN]}),false);assert.equal(validProviderGeometry(polygon),true);
});
test('A claimed area on a Point or invalid boundary stays blocked despite positive SI measurement',()=>{const a=kamaiCandidates(checkpoint([feature('r','area',{type:'Point',coordinates:[1,2]},{area_m2:96})]),scope)[0]!;assert.equal(a.status,'blocked');assert.ok(a.reviewReasons.includes('area_boundary_geometry_required'));});
const aps=(values:any)=>apsPropertyCandidates({data:{collection:[{objectid:7,name:'Native wall',properties:{Dimensions:values}}]}},{runId:'run',fileSha256:'a'.repeat(64),sourceUrn:'source-urn',sourceVersion:'v1',viewGuid:'view-1'});
test('APS typed mm/ft lengths convert once to SI; raw values/units and native identity stay in provenance',()=>{const result=aps({Length:{value:1000,unit:'mm'},Width:{value:3.280839895013123,unit:'ft'}});assert.equal(result[0]?.quantity,1);assert.ok(Math.abs(result[1]!.quantity!-1)<1e-12);assert.equal(result[0]?.unit,'m');assert.equal(result[0]?.source.originalQuantity,1000);assert.equal(result[0]?.source.unitEvidence,'mm');assert.equal(result[0]?.source.dbId,7);});
test('APS ambiguous units, semantic unit mismatch and fractional EA stay pending; bbox never produces an area',()=>{const result=aps({Area:{value:10,unit:'m'},Length:{value:2},Count:{value:0.5,unit:'EA'},BoundingBox:{min:[0,0,0],max:[100,100,100]}});assert.equal(result.length,3);assert.ok(result.every(x=>x.status==='blocked'&&x.quantity===null));});
test('APS source version changes candidate identity and duplicate dbIds are rejected',()=>{const payload={data:{collection:[{objectid:7,properties:{Dimensions:{Area:{value:25,unit:'m2'}}}}]}};
  const input={runId:'run',fileSha256:'a'.repeat(64),sourceUrn:'source',sourceVersion:'v1',viewGuid:'view'};const first=apsPropertyCandidates(payload,input)[0]!;
  assert.notEqual(first.id,apsPropertyCandidates(payload,{...input,sourceVersion:'v2'})[0]?.id);assert.throws(()=>apsPropertyCandidates({data:{collection:[payload.data.collection[0],payload.data.collection[0]]}},input),/identity/);});
test('APS exact numeric strings with documented units are parsed; ambiguous localized/numeric-only values stay pending',()=>{const result=aps({Length:'1000 mm',Area:'100 ft^2',Width:'1,000 mm',Count:2});assert.equal(result[0]?.quantity,1);assert.equal(result[1]?.quantity,9.290304);assert.equal(result[0]?.source.sourcePropertyValue,'1000 mm');assert.equal(result[2]?.status,'blocked');assert.equal(result[3]?.status,'blocked');});
test('Provider keys do not activate geometry and an enabled profile still needs explicit spending authorization',()=>{assert.equal(loadGeometryProfile({KAMAI_API_KEY:'synthetic-only'}),undefined);assert.throws(()=>loadGeometryProfile({GEOMETRY_PROVIDER_ENABLED:'true'}),/spending_authorization/);});
