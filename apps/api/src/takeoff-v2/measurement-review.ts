import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { extractDrawingLinework } from '../ai-plan/drawing-linework.ts';
import { ProjectApiError } from '../projects/service.ts';
import { calibrateScale, measureGeometry } from './geometry.ts';
import type { MeasurementGeometry, ScaleCalibration, ScaleEvidence } from './types.ts';

export const MEASUREMENT_REVIEW_VERSION = 'measurement-review-v1';
export type MeasurementStatus = 'candidate' | 'accepted' | 'rejected' | 'blocked';
export interface MeasurementScope {
  runId: string; workspaceId: string; projectId: string; fileId: string;
  fileSha256: string; physicalPageNumber: number; pageSha256: string;
  widthPoints: number; heightPoints: number; rotationDegrees: number;
}
export interface ReviewedScaleReference {
  sourceId: string;
  sourceType: Exclude<ScaleEvidence['sourceType'], 'vector_coordinates'>;
  sourceExcerpt: string;
  unit: 'ft' | 'm' | 'in';
  drawingLength: number;
  pdfPoints: number;
  referenceLine: [[number, number], [number, number]];
  independenceVerified: true;
}
export interface MeasurementReviewInput {
  measurementId: string;
  expectedRevision: number;
  fileSha256: string;
  pageSha256: string;
  physicalPageNumber: number;
  regionKey: string;
  regionBounds: [number, number, number, number];
  canonicalElementKey: string;
  canonicalTrade: string;
  label: string;
  geometry: MeasurementGeometry;
  sourceKind: 'manual_trace' | 'native_vector_candidate' | 'manual_observed_count';
  sourceCandidateId?: string;
  sourceExcerpt: string;
  decision: MeasurementStatus;
  geometryReviewed: boolean;
  identityReviewed: boolean;
  duplicateReviewComplete: boolean;
  uncertainty: string[];
  calibrationEvidence: ReviewedScaleReference[];
  boundaryEvidence?: {method:'human_trace'|'verified_rectangular_surface';reviewed:true;sourceExcerpt:string};
}
export interface MeasurementReviewResult {
  input: MeasurementReviewInput;
  quantity: number | null;
  unit: 'LF' | 'SF' | 'EA' | null;
  calibration: ScaleCalibration | null;
  formula: Record<string, unknown> | null;
  method: 'reviewed_geometry' | 'reviewed_visible_identity';
  humanReviewRequired: true;
  blockers: string[];
}
const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/;
function invalid(message: string): never { throw new ProjectApiError(422, message); }
function text(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name} is required and must fit its evidence bound.`);
  return value.trim();
}
function point(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1);
}
function inside(p: [number,number], b: [number,number,number,number]): boolean {
  return p[0] >= b[0] && p[1] >= b[1] && p[0] <= b[0] + b[2] + 1e-9 && p[1] <= b[1] + b[3] + 1e-9;
}
function orientation(a:[number,number],b:[number,number],c:[number,number]) { return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]); }
function intersects(a:[number,number],b:[number,number],c:[number,number],d:[number,number]):boolean {
  return orientation(a,b,c)*orientation(a,b,d) <= 0 && orientation(c,d,a)*orientation(c,d,b) <= 0
    && Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0])) <= Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))
    && Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1])) <= Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]));
}
function geometry(value: unknown, bounds:[number,number,number,number]):MeasurementGeometry {
  if (!record(value) || !['line','polyline','polygon','rectangle','point','count'].includes(value.type)
    || !Array.isArray(value.points) || value.points.length > 128 || !value.points.every(point)) invalid('A bounded normalized geometry is required.');
  const points=value.points as [number,number][];
  if (points.some(p=>!inside(p,bounds))) invalid('Geometry must remain inside the reviewed region.');
  const minimum=value.type==='polygon'?3:['point','count'].includes(value.type)?1:2;
  if (points.length<minimum || ['line','rectangle'].includes(value.type)&&points.length!==2 || ['point','count'].includes(value.type)&&points.length!==1) invalid('Geometry has an invalid number of points.');
  if (new Set(points.map(p=>JSON.stringify(p))).size!==points.length) invalid('Geometry contains duplicate vertices.');
  if (value.type==='polygon') for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++) {
    if(j===i+1||i===0&&j===points.length-1)continue;
    if(intersects(points[i]!,points[(i+1)%points.length]!,points[j]!,points[(j+1)%points.length]!)) invalid('Self-intersecting geometry requires correction before measurement.');
  }
  return {type:value.type,points} as MeasurementGeometry;
}
export function displayedPageDimensions(scope:MeasurementScope):{width:number;height:number} {
  return scope.rotationDegrees===90||scope.rotationDegrees===270?{width:scope.heightPoints,height:scope.widthPoints}:{width:scope.widthPoints,height:scope.heightPoints};
}
export function reviewMeasurement(value:unknown,scope:MeasurementScope):MeasurementReviewResult {
  if(!record(value)||!uuid.test(value.measurementId??'')||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0) invalid('Measurement identity and expected revision are required.');
  if(value.fileSha256!==scope.fileSha256||value.pageSha256!==scope.pageSha256||value.physicalPageNumber!==scope.physicalPageNumber) invalid('Measurement evidence belongs to another file or physical-page revision.');
  const regionKey=text(value.regionKey,120,'regionKey'),elementKey=text(value.canonicalElementKey,120,'canonicalElementKey'),trade=text(value.canonicalTrade,80,'canonicalTrade');
  if(!key.test(regionKey)||!key.test(elementKey)||!key.test(trade)) invalid('Region, trade and element keys must be stable identifiers.');
  const bounds=value.regionBounds;
  if(!Array.isArray(bounds)||bounds.length!==4||bounds.some(x=>typeof x!=='number'||!Number.isFinite(x))
    ||bounds[0]<0||bounds[1]<0||bounds[2]<=0||bounds[3]<=0||bounds[0]+bounds[2]>1+1e-9||bounds[1]+bounds[3]>1+1e-9) invalid('A normalized reviewed region is required.');
  const selected=geometry(value.geometry,bounds as [number,number,number,number]);
  if(!['candidate','accepted','rejected','blocked'].includes(value.decision)||!['manual_trace','native_vector_candidate','manual_observed_count'].includes(value.sourceKind)) invalid('Measurement decision/source is invalid.');
  if(!Array.isArray(value.uncertainty)||value.uncertainty.length>20||value.uncertainty.some((x:any)=>typeof x!=='string'||!x.trim()||x.length>240)) invalid('Measurement uncertainty must be a bounded list.');
  if(!Array.isArray(value.calibrationEvidence)||value.calibrationEvidence.length>8) invalid('Calibration references must be a bounded list.');
  const dimensions=displayedPageDimensions(scope);
  const refs:ReviewedScaleReference[]=value.calibrationEvidence.map((ref:any)=>{
    if(!record(ref)||!['printed_scale','graphic_scale','explicit_dimension','known_reference'].includes(ref.sourceType)
      ||!['ft','m','in'].includes(ref.unit)||typeof ref.drawingLength!=='number'||!Number.isFinite(ref.drawingLength)||ref.drawingLength<=0
      ||typeof ref.pdfPoints!=='number'||!Number.isFinite(ref.pdfPoints)||ref.pdfPoints<=0||ref.independenceVerified!==true
      ||!Array.isArray(ref.referenceLine)||ref.referenceLine.length!==2||!ref.referenceLine.every(point)
      ||ref.referenceLine.some((p:[number,number])=>!inside(p,bounds as [number,number,number,number]))) invalid('Each calibration needs an independently reviewed physical reference in this region.');
    const [a,b]=ref.referenceLine as [[number,number],[number,number]];
    const distance=Math.hypot((b[0]-a[0])*dimensions.width,(b[1]-a[1])*dimensions.height);
    if(distance<=0||Math.abs(distance-ref.pdfPoints)/distance>0.01) invalid('Calibration PDF length must match its displayed reference geometry.');
    return {sourceId:text(ref.sourceId,120,'sourceId'),sourceType:ref.sourceType as ReviewedScaleReference['sourceType'],
      sourceExcerpt:text(ref.sourceExcerpt,1200,'scale source excerpt'),unit:ref.unit as ReviewedScaleReference['unit'],
      drawingLength:ref.drawingLength,pdfPoints:ref.pdfPoints,referenceLine:ref.referenceLine as ReviewedScaleReference['referenceLine'],independenceVerified:true};
  });
  if(new Set(refs.map(ref=>ref.sourceId)).size!==refs.length||new Set(refs.map(ref=>ref.sourceExcerpt)).size!==refs.length
    ||new Set(refs.map(ref=>JSON.stringify([...ref.referenceLine].sort((a,b)=>a[0]-b[0]||a[1]-b[1])))).size!==refs.length) invalid('Repeated references do not establish two independent scale proofs.');
  const sourceCandidateId=value.sourceKind==='native_vector_candidate'?text(value.sourceCandidateId,120,'sourceCandidateId'):undefined;
  if(sourceCandidateId&&!/^[a-f0-9]{64}$/.test(sourceCandidateId))invalid('Native candidate identity must belong to the reproduced source revision.');
  const input:MeasurementReviewInput={measurementId:value.measurementId,expectedRevision:value.expectedRevision,fileSha256:scope.fileSha256,
    pageSha256:scope.pageSha256,physicalPageNumber:scope.physicalPageNumber,regionKey,regionBounds:bounds as [number,number,number,number],
    canonicalElementKey:elementKey,canonicalTrade:trade,label:text(value.label,240,'label'),geometry:selected,sourceKind:value.sourceKind,
    ...(sourceCandidateId?{sourceCandidateId}:{}),sourceExcerpt:text(value.sourceExcerpt,1200,'source excerpt'),decision:value.decision,
    geometryReviewed:value.geometryReviewed===true,identityReviewed:value.identityReviewed===true,duplicateReviewComplete:value.duplicateReviewComplete===true,
    uncertainty:value.uncertainty,calibrationEvidence:refs};
  const count=selected.type==='point'||selected.type==='count';
  if(!count&&input.sourceKind==='manual_observed_count')invalid('Observed counts require one reviewed point identity, not length or area geometry.');
  const blockers:string[]=[];
  if(!input.geometryReviewed)blockers.push('geometry_review_required');
  if(!input.identityReviewed||!input.duplicateReviewComplete)blockers.push('identity_and_duplicate_review_required');
  if(input.uncertainty.length)blockers.push('measurement_uncertainty_unresolved');
  if(!count){
    const boundary=value.boundaryEvidence;
    if(record(boundary)&&['human_trace','verified_rectangular_surface'].includes(boundary.method)&&boundary.reviewed===true){
      if(boundary.method==='verified_rectangular_surface'&&selected.type!=='rectangle')invalid('Verified rectangular-surface evidence requires rectangular geometry.');
      input.boundaryEvidence={method:boundary.method,reviewed:true,sourceExcerpt:text(boundary.sourceExcerpt,1200,'actual boundary evidence')};
    }else blockers.push('actual_boundary_review_required');
  }
  let calibration:ScaleCalibration|null=null,quantity:number|null=null,unit:'LF'|'SF'|'EA'|null=null,formula:Record<string,unknown>|null=null;
  if(!count){
    calibration=calibrateScale(refs.map(ref=>({sourceType:ref.sourceType,sourceExcerpt:ref.sourceExcerpt,
      drawingUnits:ref.unit==='ft'?ref.drawingLength:ref.unit==='in'?ref.drawingLength/12:ref.drawingLength/0.3048,pdfPoints:ref.pdfPoints})));
    if(refs.length<2||calibration.verificationStatus!=='verified')blockers.push('two_agreeing_independent_scale_references_required');
  }
  if(input.decision==='accepted'){
    if(blockers.length) invalid(`Measurement cannot be accepted: ${blockers.join(', ')}.`);
    if(count){quantity=1;unit='EA';formula={version:'reviewed-count-v1',operation:'one_distinct_reviewed_element',elementKey:input.canonicalElementKey};}
    else {const measured=measureGeometry(selected,calibration!,dimensions.width,dimensions.height);quantity=measured.quantity;unit=measured.unit as 'LF'|'SF';formula=measured.formula;}
    if(!quantity||!Number.isFinite(quantity)) invalid('A degenerate or zero geometry cannot be accepted as a measurement.');
  }
  return {input,quantity,unit,calibration,formula,method:count?'reviewed_visible_identity':'reviewed_geometry',humanReviewRequired:true,blockers};
}

export interface NativeGeometryCandidate {id:string;kind:'native_outline'|'enclosed_space_candidate'|'opening_candidate';bbox:[number,number,number,number];status:'candidate';quantity:null;unit:null;physicalPageNumber:number;fileSha256:string;pageSha256:string;source:'native_pdf_vector';}
/** A copied extent remains an extent even when represented by polygon vertices. */
export function geometryMatchesNativeExtent(geometry:MeasurementGeometry,bbox:[number,number,number,number]):boolean {
  const epsilon=1e-9,close=(a:number,b:number)=>Math.abs(a-b)<=epsilon;
  const [x,y,w,h]=bbox;
  if(w<=0||h<=0)return false;
  if(geometry.type==='rectangle') {
    const [a,b]=geometry.points;
    return Boolean(a&&b&&close(Math.min(a[0],b[0]),x)&&close(Math.min(a[1],b[1]),y)&&close(Math.abs(a[0]-b[0]),w)&&close(Math.abs(a[1]-b[1]),h));
  }
  if(geometry.type!=='polygon')return false;
  if(!geometry.points.every(p=>p[0]>=x-epsilon&&p[0]<=x+w+epsilon&&p[1]>=y-epsilon&&p[1]<=y+h+epsilon
    &&(close(p[0],x)||close(p[0],x+w)||close(p[1],y)||close(p[1],y+h))))return false;
  const twiceArea=geometry.points.reduce((sum,a,i)=>{const b=geometry.points[(i+1)%geometry.points.length]!;return sum+a[0]*b[1]-b[0]*a[1];},0);
  return close(Math.abs(twiceArea)/2,w*h);
}
/** Local PDF features are bounded review candidates, never automatic rooms/quantities. */
export async function nativeMeasurementCandidates(bytes:Uint8Array,scope:MeasurementScope):Promise<{candidates:NativeGeometryCandidate[];truncated:boolean;limitations:string[]}> {
  if(createHash('sha256').update(bytes).digest('hex')!==scope.fileSha256) invalid('Stored PDF changed after this run was authorized.');
  const source=await PDFDocument.load(bytes),single=await PDFDocument.create();
  if(scope.physicalPageNumber<1||scope.physicalPageNumber>source.getPageCount())invalid('Physical page is unavailable.');
  const [page]=await single.copyPages(source,[scope.physicalPageNumber-1]);single.addPage(page!);
  const linework=await extractDrawingLinework(await single.save(),{maxPages:1,maxSegmentsPerPage:40_000,maxRegionsPerPage:80});
  const found=linework.pages[0];
  const dimensions=displayedPageDimensions(scope);
  if(found&&(Math.abs(found.pageWidthPoints-dimensions.width)>0.01||Math.abs(found.pageHeightPoints-dimensions.height)>0.01
    ||found.rotationDegrees!==scope.rotationDegrees))invalid('Native vector coordinates do not match this reviewed display frame.');
  const features=found?[...found.regions.map(item=>({kind:'native_outline' as const,bbox:item.bbox})),
    ...found.spaces.map(item=>({kind:'enclosed_space_candidate' as const,bbox:item.bbox})),...found.openings.map(item=>({kind:'opening_candidate' as const,bbox:item.bbox}))]:[];
  const candidates=features.slice(0,240).map((feature,index)=>({...feature,id:createHash('sha256').update(JSON.stringify({file:scope.fileSha256,page:scope.pageSha256,index,...feature})).digest('hex'),
    status:'candidate' as const,quantity:null,unit:null,physicalPageNumber:scope.physicalPageNumber,fileSha256:scope.fileSha256,pageSha256:scope.pageSha256,source:'native_pdf_vector' as const}));
  return {candidates,truncated:linework.truncated||features.length>240,limitations:[
    'Contours, enclosed-space bounds and openings are candidates. Confirm their meaning and trace actual geometry before measuring.',
    'Bounding boxes do not establish surface area, room identity, physical scale, completeness or deduplication.',
  ]};
}

export async function loadAcceptedGeometryMeasurements(db:{from(table:string):any},input:{runId:string;workspaceId:string;projectId:string;fileId:string;fileSha256:string;physicalPageNumber:number;pageSha256:string;regionKey?:string}) {
  let query=db.from('takeoff_measurement_reviews').select('id,file_sha256,physical_page_number,page_sha256,region_key,region_bounds,canonical_element_key,canonical_trade,label,geometry,source_kind,source_candidate_id,quantity,unit,calibration,proof,formula,method,review_status,reviewed_by,reviewed_at,review_revision')
    .eq('takeoff_run_id',input.runId).eq('workspace_id',input.workspaceId).eq('project_id',input.projectId).eq('file_id',input.fileId)
    .eq('file_sha256',input.fileSha256).eq('page_sha256',input.pageSha256).eq('physical_page_number',input.physicalPageNumber).eq('review_status','accepted');
  if(input.regionKey)query=query.eq('region_key',input.regionKey);
  const result=await query.order('id').limit(101);
  if(result.error||!Array.isArray(result.data))throw new ProjectApiError(503,'Reviewed geometry measurements are unavailable.');
  return {measurements:result.data.slice(0,100),truncated:result.data.length>100,coverageStatus:'partial' as const,humanReviewRequired:true as const,
    blockers:['Reviewed quantities cover selected elements only; sheet scope/completeness and pricing remain separate review gates.']};
}
