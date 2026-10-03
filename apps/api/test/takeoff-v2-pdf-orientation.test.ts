import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument,degrees,rgb } from 'pdf-lib';
import { loadDrawEngine,pdfDocumentSource } from '../src/ai-plan/drawing-linework.ts';
import { createPlanSetManifest } from '../src/takeoff-v2/preflight.ts';
import { splitPhysicalPages } from '../src/takeoff-v2/claude-provider.ts';
import { isolateStageRegions,stageRegionIdentity } from '../src/takeoff-v2/stage-regions.ts';
import { displayedRegionBounds,normalizedPdfRotation,type PdfRotation } from '../src/takeoff-v2/pdf-orientation.ts';
import { displayedPageDimensions,nativeMeasurementCandidates } from '../src/takeoff-v2/measurement-review.ts';

const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const close=(a:number,b:number)=>assert.ok(Math.abs(a-b)<0.0001,`${a} differs from ${b}`);
for(const rotation of [0,90,180,270] as PdfRotation[])test(`PDF ${rotation} degrees retains original bytes/page hash and all regional bounds agree with PDF.js`,async()=>{
  const pdf=await PDFDocument.create({updateMetadata:false});
  const page=pdf.addPage([240,160]);page.setCropBox(20,30,200,100);page.setRotation(degrees(rotation));
  page.drawRectangle({x:25,y:35,width:40,height:20,color:rgb(1,0,0)});
  const bytes=await pdf.save(),original=digest(bytes),manifest=await createPlanSetManifest(bytes);
  const pages=await splitPhysicalPages(bytes,manifest),single=pages.get(1)!;
  assert.equal(manifest.sheets[0]!.rotationDegrees,rotation);
  assert.equal(digest(single),manifest.sheets[0]!.pageSha256);
  const regions=await isolateStageRegions(single,2);assert.equal(regions.length,4);
  const engine=await loadDrawEngine(),loading=engine.getDocument(pdfDocumentSource(single));
  try{
    const doc=await loading.promise,source=await doc.getPage(1),viewport=source.getViewport({scale:1});
    for(const region of regions){
      assert.equal(region.rotationDegrees,rotation);
      const crop=await PDFDocument.load(region.pdfBytes),cropped=crop.getPage(0),box=cropped.getCropBox();
      assert.equal(normalizedPdfRotation(cropped.getRotation().angle),rotation);
      close(box.x,20+region.region.x);close(box.y,30+region.region.y);
      close(box.width,region.region.width);close(box.height,region.region.height);
      const corner1=[box.x,box.y],corner2=[box.x+box.width,box.y+box.height];
      engine.Util.applyTransform(corner1,viewport.transform);engine.Util.applyTransform(corner2,viewport.transform);
      const corners=[...corner1,...corner2];
      const [x1,y1,x2,y2]=corners,shown=region.displayRegion;
      close(shown.x,Math.min(x1,x2));close(shown.y,Math.min(y1,y2));
      close(shown.width,Math.abs(x2-x1));close(shown.height,Math.abs(y2-y1));
      close(shown.pageWidth,viewport.width);close(shown.pageHeight,viewport.height);
      assert.ok(shown.x>=0&&shown.y>=0&&shown.x+shown.width<=viewport.width+1e-6&&shown.y+shown.height<=viewport.height+1e-6);
    }
    // The four overlapping crops collectively retain every point of the source.
    for(let x=0;x<=200;x+=10)for(let y=0;y<=100;y+=10)assert.ok(regions.some(({region:r})=>x>=r.x&&x<=r.x+r.width&&y>=r.y&&y<=r.y+r.height));
  }finally{await loading.destroy?.();}
  assert.equal(digest(bytes),original);assert.equal((await createPlanSetManifest(bytes)).fileSha256,original);
  const request={runId:'run',sheet:manifest.sheets[0]!,passType:'discipline' as const,attempt:1,idempotencyKey:'a'.repeat(64),reasoningEffort:'high' as const};
  assert.equal(await stageRegionIdentity(request,regions[0]!,'gemini','gemini-3.8-flash'),await stageRegionIdentity(request,(await isolateStageRegions(single,2))[0]!,'gemini','gemini-3.8-flash'));
});

test('right-angle aliases normalize and malformed rotations/source rectangles fail closed',()=>{
  assert.equal(normalizedPdfRotation(-90),270);assert.equal(normalizedPdfRotation(450),90);
  assert.throws(()=>normalizedPdfRotation(45));assert.throws(()=>normalizedPdfRotation(NaN));
  assert.throws(()=>displayedRegionBounds({x:190,y:0,width:20,height:10},200,100,90));
});

test('native geometry candidates remain in the same rotated display frame for90/180/270',async()=>{
  for(const rotation of [90,180,270] as PdfRotation[]){
    const pdf=await PDFDocument.create({updateMetadata:false}),page=pdf.addPage([200,100]);page.setRotation(degrees(rotation));
    page.drawRectangle({x:20,y:20,width:80,height:50,borderWidth:1,borderColor:rgb(0,0,0)});
    const bytes=await pdf.save(),manifest=await createPlanSetManifest(bytes),sheet=manifest.sheets[0]!;
    const scope={runId:'run',workspaceId:'ws',projectId:'project',fileId:'file',fileSha256:manifest.fileSha256,physicalPageNumber:1,
      pageSha256:sheet.pageSha256,widthPoints:sheet.widthPoints,heightPoints:sheet.heightPoints,rotationDegrees:rotation};
    assert.deepEqual(displayedPageDimensions(scope),rotation===180?{width:200,height:100}:{width:100,height:200});
    const result=await nativeMeasurementCandidates(bytes,scope);
    for(const candidate of result.candidates){assert.equal(candidate.pageSha256,sheet.pageSha256);assert.equal(candidate.quantity,null);
      assert.ok(candidate.bbox.every(Number.isFinite));}
  }
});
