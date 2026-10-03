import { createHash } from 'node:crypto';
import { ProjectApiError } from '../projects/service.ts';
import { PHOTO_ASSET_LIMITS, type PhotoMimeType, type PhotoSourceAsset } from '../photo-evidence/pipeline.ts';
import type { DocumentObjectStorage } from '../documents/service.ts';

export interface PhotoAssetRow {
  id: string; workspace_id: string; project_id: string; uploaded_by: string;
  storage_path: string; original_name: string; mime_type: PhotoMimeType; byte_size: number;
  status: 'uploading' | 'ready'; sha256: string | null; width_pixels: number | null; height_pixels: number | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function assertPhotoId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new ProjectApiError(400, 'A valid resource ID is required.');
}
export function photoStoragePath(workspaceId: string, projectId: string, assetId: string, mime: PhotoMimeType): string {
  assertPhotoId(workspaceId); assertPhotoId(projectId); assertPhotoId(assetId);
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
  return `${workspaceId}/${projectId}/photos/${assetId}/source.${extension}`;
}
export function assertPhotoStoragePath(row: PhotoAssetRow): void {
  if (row.storage_path !== photoStoragePath(row.workspace_id, row.project_id, row.id, row.mime_type)) {
    throw new ProjectApiError(403, 'Photo storage does not belong to the authorized project.');
  }
}
export function toPhotoSourceAsset(row: PhotoAssetRow): PhotoSourceAsset {
  if (row.status !== 'ready' || !row.sha256 || !row.width_pixels || !row.height_pixels) throw new ProjectApiError(409, 'Photo upload is not verified.');
  return { id: row.id, workspaceId: row.workspace_id, projectId: row.project_id, sha256: row.sha256,
    revision: row.sha256, mimeType: row.mime_type, byteSize: row.byte_size,
    widthPixels: row.width_pixels, heightPixels: row.height_pixels, storageVerified: true };
}
function invalid(): never { throw new ProjectApiError(415, 'Uploaded content is not a supported JPEG, PNG or WebP image.'); }
const textDecoder=new TextDecoder();
const fourCC=(bytes:Uint8Array,offset:number)=>textDecoder.decode(bytes.subarray(offset,offset+4));
function inspectWebp(bytes:Uint8Array,view:DataView):{width:number;height:number} {
  if (bytes.length<20 || fourCC(bytes,0)!=='RIFF' || fourCC(bytes,8)!=='WEBP'
    || view.getUint32(4,true)+8!==bytes.length || bytes.length%2!==0) invalid();
  let offset=12,canvas:{width:number;height:number}|null=null,frame:{width:number;height:number}|null=null;
  let extended=false,alpha=false,alphaLength=0,alphaCompression=0;
  while(offset<bytes.length){
    if (offset+8>bytes.length) invalid();
    const kind=fourCC(bytes,offset),length=view.getUint32(offset+4,true),start=offset+8,end=start+length,padded=end+(length%2);
    if (padded>bytes.length || (length%2!==0 && bytes[end]!==0)) invalid();
    if (offset===12 && !['VP8X','VP8 ','VP8L'].includes(kind)) invalid();
    if (kind==='ANIM' || kind==='ANMF') throw new ProjectApiError(415,'Animated images are not accepted.');
    if (kind==='VP8X') {
      if (offset!==12 || length!==10 || extended) invalid();
      if (bytes[start]!&2) throw new ProjectApiError(415,'Animated images are not accepted.');
      extended=true;
      canvas={width:1+bytes[start+4]!+(bytes[start+5]!<<8)+(bytes[start+6]!<<16),
        height:1+bytes[start+7]!+(bytes[start+8]!<<8)+(bytes[start+9]!<<16)};
    } else if (kind==='VP8 ' || kind==='VP8L') {
      if (frame) invalid();
      if (kind==='VP8 ') {
        if (length<=10 || bytes[start+3]!==157 || bytes[start+4]!==1 || bytes[start+5]!==42) invalid();
        const tag=bytes[start]!+(bytes[start+1]!<<8)+(bytes[start+2]!<<16),partitionSize=tag>>>5;
        // WebP needs a displayed VP8 key frame, its control partition and
        // compressed frame payload; a ten-byte dimension header is insufficient.
        if ((tag&1)!==0 || ((tag>>>1)&7)>3 || (tag&16)===0 || partitionSize===0 || 10+partitionSize>=length) invalid();
        frame={width:view.getUint16(start+6,true)&0x3fff,height:view.getUint16(start+8,true)&0x3fff};
      } else {
        if (length<=5 || bytes[start]!==47 || alpha) invalid();
        const bits=view.getUint32(start+1,true);
        if (bits>>>29!==0) invalid();
        frame={width:1+(bits&0x3fff),height:1+((bits>>>14)&0x3fff)};
      }
    } else if (kind==='ALPH') {
      if (!extended || frame || alpha || length<=1 || (bytes[start]!&3)>1) invalid();
      alpha=true;alphaLength=length-1;alphaCompression=bytes[start]!&3;
    } else if (kind==='ICCP' && (!extended || frame)) invalid();
    offset=padded;
  }
  if (!frame || !frame.width || !frame.height || (canvas && (canvas.width!==frame.width || canvas.height!==frame.height))
    || (alpha && alphaCompression===0 && alphaLength!==frame.width*frame.height)) invalid();
  return frame;
}
function inspectJpeg(bytes:Uint8Array,view:DataView):{width:number;height:number} {
  if (bytes.length<4 || bytes[0]!==255 || bytes[1]!==216 || bytes.at(-2)!==255 || bytes.at(-1)!==217) invalid();
  let offset=2,width=0,height=0,scans=0,frameMarker=0;
  const components=new Set<number>();
  while(offset<bytes.length){
    if (bytes[offset++]!==255) invalid();
    while(offset<bytes.length && bytes[offset]===255) offset++;
    if(offset>=bytes.length) invalid();
    const marker=bytes[offset++]!;
    if (marker===217) {
      if (offset!==bytes.length || !width || !height || scans===0) invalid();
      return {width,height};
    }
    if (marker===0 || marker===216 || marker===1 || marker>=208 && marker<=215 || offset+2>bytes.length) invalid();
    const length=view.getUint16(offset),end=offset+length;
    if(length<2 || end>bytes.length) invalid();
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      // Self-contained photographic baseline/extended/progressive Huffman JPEG.
      if (width || ![192,193,194].includes(marker) || length<11 || bytes[offset+2]!==8) invalid();
      const count=bytes[offset+7]!;
      if (count<1 || count>4 || length!==8+3*count) invalid();
      height=view.getUint16(offset+3);width=view.getUint16(offset+5);frameMarker=marker;
      for(let index=0;index<count;index++){
        const start=offset+8+index*3,id=bytes[start]!,sampling=bytes[start+1]!;
        if(components.has(id) || (sampling>>>4)<1 || (sampling>>>4)>4 || (sampling&15)<1 || (sampling&15)>4 || bytes[start+2]!>3) invalid();
        components.add(id);
      }
    }
    if (marker===218) {
      if (!width || !height || length<8) invalid();
      const count=bytes[offset+2]!,selected=new Set<number>();
      if (count<1 || count>components.size || length!==6+2*count) invalid();
      for(let index=0;index<count;index++){
        const start=offset+3+index*2,id=bytes[start]!,tables=bytes[start+1]!;
        if (!components.has(id) || selected.has(id) || (tables>>>4)>3 || (tables&15)>3) invalid();
        selected.add(id);
      }
      const spectralStart=bytes[end-3]!,spectralEnd=bytes[end-2]!,approximation=bytes[end-1]!;
      if (spectralStart>spectralEnd || spectralEnd>63 || (approximation>>>4)>13 || (approximation&15)>13
        || (frameMarker!==194 && (spectralStart!==0 || spectralEnd!==63 || approximation!==0))) invalid();
      offset=end;let entropyBytes=0;
      // Respect byte stuffing and restart markers. Progressive scans may be
      // followed by another table/scan; dimensions alone never end validation.
      while(offset<bytes.length){
        if(bytes[offset]!==255){entropyBytes++;offset++;continue;}
        const markerStart=offset++;
        while(offset<bytes.length && bytes[offset]===255) offset++;
        if(offset>=bytes.length) invalid();
        const next=bytes[offset]!;
        if(next===0){entropyBytes++;offset++;continue;}
        if(next>=208 && next<=215){offset++;continue;}
        offset=markerStart;break;
      }
      if(entropyBytes===0) invalid();
      scans++;continue;
    }
    offset=end;
  }
  return invalid();
}
/** Structural framing/dimensions are metadata, not full raster decoding or scale proof. */
export function inspectPhoto(bytes: Uint8Array, mime: PhotoMimeType): { width: number; height: number; sha256: string } {
  if (bytes.length<1 || bytes.length>PHOTO_ASSET_LIMITS.maximumAssetBytes) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)
    && new TextDecoder().decode(bytes.subarray(12,16)) === 'IHDR' && view.getUint32(8) === 13) {
    width = view.getUint32(16); height = view.getUint32(20);
    let offset=8,imageData=false,ended=false;
    while(offset+12<=bytes.length){
      const length=view.getUint32(offset),kind=new TextDecoder().decode(bytes.subarray(offset+4,offset+8));
      if(offset+12+length>bytes.length||kind==='acTL') invalid();
      if(kind==='IDAT' && length>0) imageData=true;
      if(kind==='IEND'){
        if(length!==0||offset+12!==bytes.length) invalid();
        ended=true;break;
      }
      offset+=12+length;
    }
    if(!imageData||!ended) invalid();
  } else if (mime === 'image/jpeg') ({width,height}=inspectJpeg(bytes,view));
  else if (mime === 'image/webp') ({width,height}=inspectWebp(bytes,view));
  if (!width || !height || width * height > PHOTO_ASSET_LIMITS.maximumPixels) invalid();
  return { width, height, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Download only server-signed tenant paths, with redirects disabled and bounded stream. */
export async function loadVerifiedPhoto(row: PhotoAssetRow, storage: DocumentObjectStorage, fetcher: typeof fetch,
  requireSavedHash = true, signal?: AbortSignal): Promise<Uint8Array> {
  assertPhotoStoragePath(row);
  const signed = await storage.presign('GET', row.storage_path, { expiresIn: 60 });
  const response = await fetcher(signed.url, { method: 'GET', headers: signed.headers, redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new ProjectApiError(409, 'Photo upload is unavailable.');
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const size = response.headers.get('content-length');
  if (type !== row.mime_type || size !== null && Number(size) !== row.byte_size) throw new ProjectApiError(422, 'Photo metadata differs from the upload declaration.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > row.byte_size || length > PHOTO_ASSET_LIMITS.maximumAssetBytes) { await reader.cancel(); throw new ProjectApiError(413, 'Photo exceeds its size bound.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== row.byte_size) throw new ProjectApiError(422, 'Photo byte size differs from the upload declaration.');
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const inspected = inspectPhoto(bytes, row.mime_type);
  if (requireSavedHash && (inspected.sha256 !== row.sha256 || inspected.width !== row.width_pixels || inspected.height !== row.height_pixels)) {
    throw new ProjectApiError(409, 'Photo changed after verification. A new upload is required.');
  }
  return bytes;
}
