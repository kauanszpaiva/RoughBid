import test from 'node:test';
import assert from 'node:assert/strict';
import { projectReadiness } from '../app/src/utils/projectReadiness.ts';
import type { Project } from '../app/src/types/index.ts';
const project: Project = { id:'test',name:'Test',clientName:'Test',address:'',projectType:'Test',status:'Planning',updatedAt:'',overheadPercentage:10,markupPercentage:20,revisions:[{id:'rev',revisionNumber:'01',fileName:'test.pdf',fileSize:'1 MB',pages:2,uploadDate:'',uploadedBy:'Test',isCurrent:true,remoteFileId:'saved-pdf'}],quantities:[{id:'q',itemNumber:1,name:'Wall',quantity:100,unit:'SF'}],estimateItems:[{id:'e',quantityId:'q',name:'Wall',quantity:100,unit:'SF',materialCost:200,laborCost:100,equipmentCost:0,directCost:300}] };
test('saved plan and entered costs permit export',()=> assert.equal(projectReadiness(project).canExport,true));
test('unpriced and invalid lines cannot appear ready for a client',()=>{
  for(const cost of [0,-1,NaN,Infinity]) {
    const next={...project,estimateItems:[{...project.estimateItems[0]!,materialCost:cost,laborCost:0,directCost:cost}]};
    assert.equal(projectReadiness(next).canExport,false);
  }
});
test('fake plan metadata and invalid markups cannot pass readiness',()=>{
  assert.equal(projectReadiness({...project,revisions:[{...project.revisions[0]!,remoteFileId:''}]}).canExport,false);
  assert.equal(projectReadiness({...project,markupPercentage:-20}).canExport,false);
  assert.equal(projectReadiness({...project,estimateItems:[{...project.estimateItems[0]!,directCost:999}]}).canExport,false);
});
