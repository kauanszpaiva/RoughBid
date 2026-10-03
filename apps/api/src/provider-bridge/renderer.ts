import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import { isolateStageRegions, type StageRegion } from '../takeoff-v2/stage-regions.ts';
import { splitPhysicalPages } from '../takeoff-v2/claude-provider.ts';
import { readRegionJpegDimensions } from '../takeoff-v2/local-region-renderer.ts';
import type { StageSourceImage } from '../takeoff-v2/stage-provider.ts';
import type { PlanSetManifest } from '../takeoff-v2/types.ts';
import { BridgeError } from './protocol.ts';

export const BRIDGE_RENDER_POLICY=Object.freeze({version:'pdfjs-canvas-crop-v1',maximumEdgePixels:1300,jpegQuality:92});
function packageDirectory():string{
  return dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
}
/** Native canvas renders only a reconstructed CropBox. No external URL, font or
 * image path is accepted from a command. All PDF.js resources are bundled files. */
export async function renderBridgeRegion(region:StageRegion,pageNumber:number,signal?:AbortSignal):Promise<StageSourceImage>{
  signal?.throwIfAborted();
  if(region.pdfBytes.byteLength>10*1024*1024||!Number.isSafeInteger(pageNumber)||pageNumber<1)throw new BridgeError('bridge_identity_conflict',409);
  const [{getDocument,GlobalWorkerOptions},{createCanvas}]=await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'),import('@napi-rs/canvas')]);
  const directory=packageDirectory(),resource=(name:string)=>join(directory,name).split(sep).join('/')+'/';
  // Vercel bundles this module away from PDF.js. Resolve the explicitly bundled
  // Node worker from its package, never relative to the serverless entrypoint.
  GlobalWorkerOptions.workerSrc=pathToFileURL(join(directory,'legacy/build/pdf.worker.mjs')).href;
  const task=getDocument({data:region.pdfBytes.slice(),standardFontDataUrl:resource('standard_fonts'),cMapUrl:resource('cmaps'),cMapPacked:true,
    wasmUrl:resource('wasm'),useWorkerFetch:false,useSystemFonts:false,disableFontFace:true,
    disableAutoFetch:true,disableRange:true,disableStream:true,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,
    enableXfa:false,stopAtErrors:true,verbosity:0});
  let rendering:{cancel():void;promise:Promise<void>}|undefined,timer:ReturnType<typeof setTimeout>|undefined;
  const cancelled=()=>{rendering?.cancel();void task.destroy().catch(()=>{});};
  signal?.addEventListener('abort',cancelled,{once:true});
  try{
    const work=(async()=>{
      const document=await task.promise;if(document.numPages!==1)throw new BridgeError('bridge_identity_conflict',409);
      const page=await document.getPage(1);
      if(page.rotate!==region.rotationDegrees)throw new BridgeError('bridge_identity_conflict',409);
      const original=page.getViewport({scale:1});
      const quarter=[90,270].includes(region.rotationDegrees),width=quarter?region.region.height:region.region.width,height=quarter?region.region.width:region.region.height;
      if(Math.abs(original.width-width)>0.01||Math.abs(original.height-height)>0.01)throw new BridgeError('bridge_identity_conflict',409);
      const viewport=page.getViewport({scale:BRIDGE_RENDER_POLICY.maximumEdgePixels/Math.max(original.width,original.height)});
      const canvas=createCanvas(Math.round(viewport.width),Math.round(viewport.height));
      rendering=page.render({canvas:canvas as any,canvasContext:canvas.getContext('2d') as any,viewport,background:'rgb(255,255,255)'});
      await rendering.promise;signal?.throwIfAborted();
      const bytes=await canvas.encode('jpeg',BRIDGE_RENDER_POLICY.jpegQuality),dimensions=readRegionJpegDimensions(bytes);
      if(bytes.byteLength>12*1024*1024||Math.max(dimensions.widthPixels,dimensions.heightPixels)>BRIDGE_RENDER_POLICY.maximumEdgePixels
        ||Math.abs(dimensions.widthPixels-viewport.width)>1||Math.abs(dimensions.heightPixels-viewport.height)>1)throw new BridgeError('bridge_result_unavailable',503);
      return {dataUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`,...dimensions,pageNumber,region:{...region.region},
        rotationDegrees:region.rotationDegrees,displayRegion:region.displayRegion,label:`Physical page ${pageNumber}, verified crop ${region.id}`} satisfies StageSourceImage;
    })();
    const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled();reject(new BridgeError('bridge_adapter_unavailable',503));},30_000);});
    return await Promise.race([work,deadline]);
  }catch(error){if(error instanceof BridgeError)throw error;throw new BridgeError('bridge_adapter_unavailable',503);}
  finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',cancelled);await task.destroy().catch(()=>{});}
}
/** Used by the worker for truthful local coverage metadata; the server separately
 * reconstructs and verifies the original document before its own provider call. */
export async function bridgePageImages(bytes:Uint8Array,manifest:PlanSetManifest,pageNumber:number,grid:2|3):Promise<StageSourceImage[]>{
  const pages=await splitPhysicalPages(bytes,manifest),page=pages.get(pageNumber);
  if(!page)throw new BridgeError('bridge_identity_conflict',409);
  const regions=await isolateStageRegions(page,grid),images:StageSourceImage[]=[];
  for(const region of regions)images.push(await renderBridgeRegion(region,pageNumber));
  return images;
}
let smoke:Promise<void>|undefined;
/** Real native module/font/PDF rendering availability, without a customer file or provider. */
export function verifyBridgeRenderer():Promise<void>{
  return smoke??=(async()=>{
    const pdf=await PDFDocument.create(),page=pdf.addPage([72,48]);page.drawRectangle({x:0,y:0,width:72,height:48,color:rgb(0,0,0)});
    const region=(await isolateStageRegions(new Uint8Array(await pdf.save()),2))[0]!;
    const rendered=await renderBridgeRegion(region,1);
    const {loadImage,createCanvas}=await import('@napi-rs/canvas'),image=await loadImage(Buffer.from(rendered.dataUrl.split(',')[1]!,'base64'));
    const canvas=createCanvas(1,1),context=canvas.getContext('2d');context.drawImage(image,0,0,1,1);
    const pixel=context.getImageData(0,0,1,1).data;if(pixel[0]!>20||pixel[1]!>20||pixel[2]!>20)throw new BridgeError('bridge_adapter_unavailable',503);
  })().catch(error=>{smoke=undefined;
    // Fixed diagnostics only: native/module exceptions can include local paths.
    const message=error instanceof Error?error.message:'';
    const code=/worker/i.test(message)?'pdf_worker_unavailable':/canvas|native|binding|\.node/i.test(message)?'native_canvas_unavailable'
      :/module|package|ENOENT/i.test(message)?'renderer_resource_unavailable':'renderer_smoke_failed';
    console.error('[provider-bridge] renderer smoke unavailable',{code});throw error;});
}
