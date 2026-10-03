import { createHash } from 'node:crypto';
import { PhotoEvidenceError } from './profile.ts';

export const PHOTO_PLANAR_VERSION='photo-planar-v1' as const;
export type PhotoPlanarPoint=readonly [number,number];
export interface PhotoPlanarSource {
  sourceAssetId:string;sourceRevision:string;sourceSha256:string;surfaceKey:string;
}
/** Four cyclic image points corresponding to a real, reviewed rectangle. */
export interface PhotoPlanarCalibration extends PhotoPlanarSource {
  version:typeof PHOTO_PLANAR_VERSION;
  referencePoints:readonly [PhotoPlanarPoint,PhotoPlanarPoint,PhotoPlanarPoint,PhotoPlanarPoint];
  referenceWidth:number;referenceHeight:number;referenceUnit:'M'|'LF';
  rectangleVerified:true;lensDistortionReviewed:true;
}
export interface PhotoPlanarMeasurement extends PhotoPlanarSource {
  version:typeof PHOTO_PLANAR_VERSION;
  kind:'polygon'|'polyline';points:readonly PhotoPlanarPoint[];
  measure:'area'|'perimeter'|'length';samePlaneReviewed:true;geometryReviewed:true;
}
export interface PhotoPlanarProof {
  version:typeof PHOTO_PLANAR_VERSION;
  sourceAssetId:string;sourceRevision:string;sourceSha256:string;surfaceKey:string;
  scope:'reviewed_planar_region';status:'human_reviewed_conditional_measurement';
  referenceId:string;reviewerId:string;objectIdentityKey:string;
  calibration:PhotoPlanarCalibration;geometry:PhotoPlanarMeasurement;
  /** Row-major homography: normalized image coordinates -> physical metres. */
  imageToPlaneMeters:readonly number[];
  transformedPointsMeters:readonly PhotoPlanarPoint[];
  areaM2:number|null;perimeterM:number|null;lengthM:number|null;
  quantity:number;unit:'SF'|'SY'|'SQ'|'LF';roundingDecimalPlaces:6;
  calibrationHash:string;proofHash:string;
  numericalChecks:{maximumReferenceReprojectionError:number;denominatorRatio:number;pivotRatio:number};
  uncertainty:{kind:'not_statistically_quantified';automaticCertification:false;sources:readonly string[]};
}
export interface PhotoPlanarAsset {id:string;sha256:string;revision:string;widthPixels:number;heightPixels:number;}
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const EPS=1e-10;
function fail(code:string):never {throw new PhotoEvidenceError(code);}
const cross=(a:PhotoPlanarPoint,b:PhotoPlanarPoint,c:PhotoPlanarPoint)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const distance=(a:PhotoPlanarPoint,b:PhotoPlanarPoint)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const pointInBox=(p:PhotoPlanarPoint,a:PhotoPlanarPoint,b:PhotoPlanarPoint)=>p[0]>=Math.min(a[0],b[0])-EPS
  &&p[0]<=Math.max(a[0],b[0])+EPS&&p[1]>=Math.min(a[1],b[1])-EPS&&p[1]<=Math.max(a[1],b[1])+EPS;
function intersects(a:PhotoPlanarPoint,b:PhotoPlanarPoint,c:PhotoPlanarPoint,d:PhotoPlanarPoint):boolean {
  const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
  if(((abC>EPS&&abD< -EPS)||(abC< -EPS&&abD>EPS))&&((cdA>EPS&&cdB< -EPS)||(cdA< -EPS&&cdB>EPS)))return true;
  return Math.abs(abC)<=EPS&&pointInBox(c,a,b)||Math.abs(abD)<=EPS&&pointInBox(d,a,b)
    ||Math.abs(cdA)<=EPS&&pointInBox(a,c,d)||Math.abs(cdB)<=EPS&&pointInBox(b,c,d);
}
function points(input:unknown,minimum:number,maximum:number):PhotoPlanarPoint[] {
  if(!Array.isArray(input)||input.length<minimum||input.length>maximum)fail('invalid_photo_planar_points');
  const result:PhotoPlanarPoint[]=input.map(value=>{
    if(!Array.isArray(value)||value.length!==2||value.some(coordinate=>typeof coordinate!=='number'||!Number.isFinite(coordinate)||coordinate<0||coordinate>1))fail('invalid_photo_planar_points');
    return [value[0],value[1]] as PhotoPlanarPoint;
  });
  for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++)if(distance(result[i]!,result[j]!)<=EPS)fail('degenerate_photo_planar_geometry');
  return result;
}
function simpleGeometry(values:readonly PhotoPlanarPoint[],closed:boolean):void {
  const edges=closed?values.length:values.length-1;
  for(let i=0;i<edges;i++)for(let j=i+1;j<edges;j++){
    if(j===i+1||closed&&i===0&&j===edges-1)continue;
    if(intersects(values[i]!,values[(i+1)%values.length]!,values[j]!,values[(j+1)%values.length]!))fail('self_intersecting_photo_planar_geometry');
  }
  for(let i=closed?0:1;i<(closed?values.length:values.length-1);i++){
    const previous=values[(i+values.length-1)%values.length]!,current=values[i]!,next=values[(i+1)%values.length]!;
    if(Math.abs(cross(previous,current,next))<=EPS
      &&(current[0]-previous[0])*(next[0]-current[0])+(current[1]-previous[1])*(next[1]-current[1])<0)fail('degenerate_photo_planar_geometry');
  }
}
function area(values:readonly PhotoPlanarPoint[]):number {
  // Translation reduces cancellation for a small region far from the origin.
  const origin=values[0]!;let sum=0;
  for(let i=1;i<values.length-1;i++)sum+=cross(origin,values[i]!,values[i+1]!);
  return Math.abs(sum)/2;
}
function source(value:Record<string,unknown>,asset:PhotoPlanarAsset,surfaceKey:string):PhotoPlanarSource {
  if(value.sourceAssetId!==asset.id||value.sourceRevision!==asset.revision||value.sourceSha256!==asset.sha256||value.surfaceKey!==surfaceKey)fail('photo_planar_source_mismatch');
  return {sourceAssetId:asset.id,sourceRevision:asset.revision,sourceSha256:asset.sha256,surfaceKey};
}
export function normalizePhotoPlanarCalibration(input:unknown,asset:PhotoPlanarAsset,surfaceKey:string):PhotoPlanarCalibration {
  if(!asset||!identifier(asset.id)||!identifier(asset.revision)||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/.test(asset.sha256)
    ||!Number.isSafeInteger(asset.widthPixels)||!Number.isSafeInteger(asset.heightPixels)||asset.widthPixels<1||asset.heightPixels<1
    ||asset.widthPixels*asset.heightPixels>64_000_000)fail('invalid_photo_planar_source');
  if(!record(input)||input.version!==PHOTO_PLANAR_VERSION||!identifier(surfaceKey))fail('deterministic_photo_calibration_required');
  const metadata=source(input,asset,surfaceKey),referencePoints=points(input.referencePoints,4,4);
  if(input.rectangleVerified!==true||input.lensDistortionReviewed!==true)fail('photo_planar_reference_review_required');
  if(!['M','LF'].includes(String(input.referenceUnit))||typeof input.referenceWidth!=='number'||typeof input.referenceHeight!=='number'
    ||![input.referenceWidth,input.referenceHeight].every(value=>Number.isFinite(value)&&value>0&&value<=1_000_000))fail('photo_planar_dimensions_required');
  simpleGeometry(referencePoints,true);
  let sign=0;
  for(let index=0;index<4;index++){
    const a=referencePoints[index]!,b=referencePoints[(index+1)%4]!,c=referencePoints[(index+2)%4]!,turn=cross(a,b,c);
    if(Math.abs(turn)/(distance(a,b)*distance(b,c))<1e-4||Math.abs(turn)<EPS||sign&&Math.sign(turn)!==sign)fail('degenerate_photo_planar_calibration');
    sign=Math.sign(turn);
    if(Math.hypot((b[0]-a[0])*asset.widthPixels,(b[1]-a[1])*asset.heightPixels)<2)fail('photo_planar_reference_resolution_insufficient');
  }
  if(area(referencePoints)*asset.widthPixels*asset.heightPixels<16)fail('photo_planar_reference_resolution_insufficient');
  return {version:PHOTO_PLANAR_VERSION,...metadata,referencePoints:referencePoints as unknown as PhotoPlanarCalibration['referencePoints'],
    referenceWidth:input.referenceWidth,referenceHeight:input.referenceHeight,referenceUnit:input.referenceUnit as 'M'|'LF',rectangleVerified:true,lensDistortionReviewed:true};
}
export function normalizePhotoPlanarMeasurement(input:unknown,asset:PhotoPlanarAsset,surfaceKey:string):PhotoPlanarMeasurement {
  if(!record(input)||input.version!==PHOTO_PLANAR_VERSION)fail('deterministic_photo_calibration_required');
  if(input.holes!==undefined||input.rings!==undefined)fail('unsupported_photo_planar_holes');
  const metadata=source(input,asset,surfaceKey);
  if(input.samePlaneReviewed!==true||input.geometryReviewed!==true)fail('photo_planar_geometry_review_required');
  if(input.kind!=='polygon'&&input.kind!=='polyline'||!['area','perimeter','length'].includes(String(input.measure))
    ||input.kind==='polygon'&&input.measure==='length'||input.kind==='polyline'&&input.measure!=='length')fail('invalid_photo_planar_measure');
  const geometryPoints=points(input.points,input.kind==='polygon'?3:2,64);simpleGeometry(geometryPoints,input.kind==='polygon');
  if(input.kind==='polygon'&&area(geometryPoints)<=EPS)fail('degenerate_photo_planar_geometry');
  return {version:PHOTO_PLANAR_VERSION,...metadata,kind:input.kind,points:geometryPoints,measure:input.measure as PhotoPlanarMeasurement['measure'],samePlaneReviewed:true,geometryReviewed:true};
}
function solveHomography(referencePoints:readonly PhotoPlanarPoint[]):{matrix:number[];pivotRatio:number} {
  const target:PhotoPlanarPoint[]=[[0,0],[1,0],[1,1],[0,1]],rows:number[][]=[];
  for(let index=0;index<4;index++){
    const [x,y]=referencePoints[index]!,[u,v]=target[index]!;
    rows.push([x,y,1,0,0,0,-u*x,-u*y,u],[0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  let largest=0,smallest=Infinity;
  for(let column=0;column<8;column++){
    let pivot=column;
    for(let row=column+1;row<8;row++)if(Math.abs(rows[row]![column]!)>Math.abs(rows[pivot]![column]!))pivot=row;
    const magnitude=Math.abs(rows[pivot]![column]!);
    if(!Number.isFinite(magnitude)||magnitude<1e-12)fail('unstable_photo_planar_calibration');
    largest=Math.max(largest,magnitude);smallest=Math.min(smallest,magnitude);
    [rows[column],rows[pivot]]=[rows[pivot]!,rows[column]!];
    const scale=rows[column]![column]!;
    for(let c=column;c<9;c++)rows[column]![c]=rows[column]![c]!/scale;
    for(let row=0;row<8;row++)if(row!==column){
      const factor=rows[row]![column]!;
      for(let c=column;c<9;c++)rows[row]![c]=rows[row]![c]!-factor*rows[column]![c]!;
    }
  }
  const matrix=rows.map(row=>row[8]!).concat(1),pivotRatio=largest/smallest;
  if(matrix.some(value=>!Number.isFinite(value))||pivotRatio>1e10)fail('unstable_photo_planar_calibration');
  return {matrix,pivotRatio};
}
function transform(matrix:readonly number[],point:PhotoPlanarPoint):PhotoPlanarPoint {
  const denominator=matrix[6]!*point[0]+matrix[7]!*point[1]+matrix[8]!;
  if(!Number.isFinite(denominator)||Math.abs(denominator)<1e-10)fail('unstable_photo_planar_calibration');
  const result:PhotoPlanarPoint=[(matrix[0]!*point[0]+matrix[1]!*point[1]+matrix[2]!)/denominator,
    (matrix[3]!*point[0]+matrix[4]!*point[1]+matrix[5]!)/denominator];
  if(result.some(value=>!Number.isFinite(value)))fail('unstable_photo_planar_calibration');
  return result;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Pure image->plane calculation; no model, upload, depth inference or database write. */
export function calculatePhotoPlanarMeasurement(input:{asset:PhotoPlanarAsset;surfaceKey:string;referenceId:string;reviewerId:string;
  objectIdentityKey:string;calibration:unknown;measurement:unknown;unit:string}):PhotoPlanarProof {
  if(!identifier(input.referenceId)||!identifier(input.reviewerId)||!identifier(input.objectIdentityKey))fail('invalid_photo_planar_identity');
  const calibration=normalizePhotoPlanarCalibration(input.calibration,input.asset,input.surfaceKey);
  const geometry=normalizePhotoPlanarMeasurement(input.measurement,input.asset,input.surfaceKey);
  if(geometry.measure==='area'?!['SF','SY','SQ'].includes(input.unit):input.unit!=='LF')fail('invalid_photo_planar_unit');
  const orientation=Math.sign(cross(calibration.referencePoints[0],calibration.referencePoints[1],calibration.referencePoints[2]));
  // A convex control region bounds interpolation and avoids unreviewed extrapolation.
  for(const point of geometry.points)for(let edge=0;edge<4;edge++){
    if(cross(calibration.referencePoints[edge]!,calibration.referencePoints[(edge+1)%4]!,point)*orientation< -EPS)fail('photo_planar_geometry_outside_calibrated_region');
  }
  const {matrix,pivotRatio}=solveHomography(calibration.referencePoints),metres=calibration.referenceUnit==='M'?1:0.3048;
  const widthM=calibration.referenceWidth*metres,heightM=calibration.referenceHeight*metres;
  const referenceDenominators=calibration.referencePoints.map(([x,y])=>matrix[6]!*x+matrix[7]!*y+matrix[8]!);
  if(referenceDenominators.some(value=>!Number.isFinite(value)||Math.abs(value)<1e-8||Math.sign(value)!==Math.sign(referenceDenominators[0]!)))fail('unstable_photo_planar_calibration');
  const denominatorRatio=Math.max(...referenceDenominators.map(Math.abs))/Math.min(...referenceDenominators.map(Math.abs));
  if(denominatorRatio>1e4)fail('unstable_photo_planar_calibration');
  const target:PhotoPlanarPoint[]=[[0,0],[1,0],[1,1],[0,1]],maximumReferenceReprojectionError=Math.max(...calibration.referencePoints.map((point,index)=>distance(transform(matrix,point),target[index]!)));
  if(maximumReferenceReprojectionError>1e-8)fail('unstable_photo_planar_calibration');
  const imageToPlaneMeters=matrix.map((value,index)=>index<3?value*widthM:index<6?value*heightM:value);
  const transformedPointsMeters=geometry.points.map(point=>transform(imageToPlaneMeters,point));
  const areaM2=geometry.kind==='polygon'?area(transformedPointsMeters):null;
  let boundary=0;
  for(let index=1;index<transformedPointsMeters.length;index++)boundary+=distance(transformedPointsMeters[index-1]!,transformedPointsMeters[index]!);
  if(geometry.kind==='polygon')boundary+=distance(transformedPointsMeters.at(-1)!,transformedPointsMeters[0]!);
  const perimeterM=geometry.kind==='polygon'?boundary:null,lengthM=geometry.kind==='polyline'?boundary:null;
  const selected=geometry.measure==='area'?areaM2!:boundary;
  const factor=input.unit==='SF'?0.09290304:input.unit==='SY'?0.83612736:input.unit==='SQ'?9.290304:0.3048;
  const quantity=Math.round((selected/factor)*1_000_000)/1_000_000;
  if(!Number.isFinite(quantity)||quantity<=0||quantity>Number.MAX_SAFE_INTEGER/1_000_000)fail('invalid_photo_planar_quantity');
  const proof:Omit<PhotoPlanarProof,'proofHash'>={version:PHOTO_PLANAR_VERSION,...source(calibration as unknown as Record<string,unknown>,input.asset,input.surfaceKey),
    scope:'reviewed_planar_region',status:'human_reviewed_conditional_measurement',referenceId:input.referenceId,reviewerId:input.reviewerId,objectIdentityKey:input.objectIdentityKey,
    calibration,geometry,imageToPlaneMeters,transformedPointsMeters,areaM2,perimeterM,lengthM,quantity,unit:input.unit as PhotoPlanarProof['unit'],roundingDecimalPlaces:6,
    calibrationHash:hash(calibration),numericalChecks:{maximumReferenceReprojectionError,denominatorRatio,pivotRatio},
    uncertainty:{kind:'not_statistically_quantified',automaticCertification:false,sources:['human_point_selection','supplied_reference_dimensions','residual_lens_distortion','human_coplanarity_declaration']}};
  return {...proof,proofHash:hash(proof)};
}
