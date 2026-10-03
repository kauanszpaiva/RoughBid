import test from 'node:test';
import assert from 'node:assert/strict';
import { geometryCatalogQuantity, acceptedAutomaticGeometry } from '../src/construction-budget/geometry-measurements.ts';

test('automatic SI is preserved as source and converted to catalog units only once',()=>{
  assert.equal(geometryCatalogQuantity(96,'m2')!.quantity,1033.3354);
  assert.equal(geometryCatalogQuantity(8.91869184,'m2')!.quantity,96);
  assert.deepEqual(geometryCatalogQuantity(0,'m'),{quantity:0,unit:'LF',conversion:'m / 0.3048; catalog precision 0.000001 LF'});
  assert.equal(geometryCatalogQuantity(1,'m')!.quantity,3.28084);
  assert.equal(geometryCatalogQuantity(2,'EA')!.quantity,2);
  for(const [value,unit] of [[null,'m2'],[96,'area'],[-1,'m'],[1.5,'EA'],[NaN,'m'],[1e-15,'m2']] as const)assert.equal(geometryCatalogQuantity(value,unit),null);
});
test('budget consumes only accepted persisted candidate SI, retaining provider geometry and provenance',async()=>{
  const filters:Array<[string,unknown]>=[];
  const db:any={from:(name:string)=>{
    assert.equal(name,'geometry_provider_candidates');const q:any={select:()=>q,eq:(k:string,v:unknown)=>{filters.push([k,v]);return q;},limit:()=>q,
      then:(resolve:any)=>Promise.resolve({data:[{id:'a'.repeat(64),run_id:'run-1',review_revision:1,candidate:{quantitySI:8.91869184,unit:'m2',label:'Automatic room',physicalPageNumber:1,
        geometry:{type:'Polygon',coordinates:[[[0,0],[4,0],[4,3],[0,3],[0,0]]]},source:{provider:'kamai',blueprintId:'BP1',revision:'R1',sourceElementId:'room1'}}}],error:null}).then(resolve)};return q;
  }};
  const result=await acceptedAutomaticGeometry(db,'workspace-1','project-1');
  assert.deepEqual(filters,[['workspace_id','workspace-1'],['project_id','project-1'],['status','accepted']]);
  assert.equal(result.measurements[0]!.quantity,96);assert.equal(result.measurements[0]!.sourceKind,'geometry');
  assert.equal(result.measurements[0]!.sourceEvidence!.quantitySI,8.91869184);
  assert.equal(result.measurements[0]!.sourceEvidence!.method,'automatic_provider_si');
});
test('missing geometry schema is explicit while unexpected read errors do not substitute quantities',async()=>{
  const db=(error:any)=>({from:()=>{const q:any={select:()=>q,eq:()=>q,limit:()=>q,then:(r:any)=>Promise.resolve({data:null,error}).then(r)};return q;}} as any);
  assert.equal((await acceptedAutomaticGeometry(db({code:'42P01'}),'w','p')).availability,'schema_not_activated');
  await assert.rejects(acceptedAutomaticGeometry(db({code:'42501',message:'permission denied'}),'w','p'),(e:any)=>e.status===503);
});
