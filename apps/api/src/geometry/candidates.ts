import {createHash} from 'node:crypto';
import type {KamaiCheckpoint} from '../takeoff-v2/kamai-provider.ts';
export interface GeometryCandidate {id:string;provider:'kamai'|'aps';sourceElementId:string;label:string;semanticClass:string;
  measurementKind:'area'|'perimeter'|'length'|'opening_width'|'count';quantity:number|null;unit:'m2'|'m'|'EA'|null;
  status:'candidate'|'blocked'|'accepted'|'rejected';geometry:Record<string,unknown>|null;coordinateFrame:'provider_blueprint'|'native_model';
  physicalPageNumber:number|null;fileSha256:string;source:Record<string,unknown>;reviewReasons:string[];reviewRevision:number;
  aggregationGroup:'room_area'|'area_surface'|'object_surface'|'linear_element'|'individual_object'|'native_property';}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type XY=[number,number];
function finitePoint(value:any):value is XY{return Array.isArray(value)&&value.length===2&&value.every((x:any)=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=1_000_000_000);}
const cross=(a:XY,b:XY,c:XY)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
const segmentsIntersect=(a:XY,b:XY,c:XY,d:XY)=>cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0
  &&Math.max(Math.min(a[0],b[0]),Math.min(c[0],d[0]))<=Math.min(Math.max(a[0],b[0]),Math.max(c[0],d[0]))
  &&Math.max(Math.min(a[1],b[1]),Math.min(c[1],d[1]))<=Math.min(Math.max(a[1],b[1]),Math.max(c[1],d[1]));
function ringValid(value:any):boolean{
  if(!Array.isArray(value)||value.length<4||value.length>2000||!value.every(finitePoint)||JSON.stringify(value[0])!==JSON.stringify(value[value.length-1]))return false;
  const points=value.slice(0,-1) as XY[];if(new Set(points.map(p=>JSON.stringify(p))).size!==points.length)return false;
  let twiceArea=0;for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;twiceArea+=a[0]*b[1]-b[0]*a[1];
    for(let j=i+1;j<points.length;j++){if(j===i+1||i===0&&j===points.length-1)continue;if(segmentsIntersect(a,b,points[j]!,points[(j+1)%points.length]!))return false;}}
  return Math.abs(twiceArea)>1e-12;
}
function insideRing(point:XY,ring:XY[]):boolean{let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i]!,b=ring[j]!;if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
function polygonValid(rings:any):boolean{
  if(!Array.isArray(rings)||!rings.length||rings.length>64||rings.reduce((n,r)=>n+(Array.isArray(r)?r.length:4001),0)>4000||!rings.every(ringValid))return false;
  for(let i=1;i<rings.length;i++){
    if(!rings[i].slice(0,-1).every((p:XY)=>insideRing(p,rings[0])))return false;
    for(let j=0;j<i;j++){
      if(j>0&&(insideRing(rings[i][0],rings[j])||insideRing(rings[j][0],rings[i])))return false;
      for(let a=0;a<rings[i].length-1;a++)for(let b=0;b<rings[j].length-1;b++)if(segmentsIntersect(rings[i][a],rings[i][a+1],rings[j][b],rings[j][b+1]))return false;
    }
  }return true;
}
function lineValid(value:any):boolean{
  if(!Array.isArray(value)||value.length<2||value.length>2000||!value.every(finitePoint))return false;
  if(value.some((p:XY,i:number)=>i>0&&p[0]===value[i-1]![0]&&p[1]===value[i-1]![1]))return false;
  for(let i=2;i<value.length;i++){const a=value[i-2]!,b=value[i-1]!,c=value[i]!;if(cross(a,b,c)===0&&(b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])<0)return false;}return true;
}
/** Validate local planar shapes; never use geographic area or derive SI from unproven coordinates. */
export function validProviderGeometry(value:Record<string,unknown>|null):boolean{
  if(!value)return false;const c=value.coordinates as any;
  if(value.type==='Polygon')return polygonValid(c);
  if(value.type==='MultiPolygon')return Array.isArray(c)&&c.length>0&&c.length<=64&&c.every(polygonValid);
  if(value.type==='LineString')return lineValid(c);
  if(value.type==='MultiLineString')return Array.isArray(c)&&c.length>0&&c.length<=64&&c.every(lineValid);
  if(value.type==='Point')return finitePoint(c);return false;
}
export function kamaiCandidates(checkpoint:KamaiCheckpoint,input:{runId:string;fileSha256:string;physicalPageNumber:number}):GeometryCandidate[]{
  if(!checkpoint.evidence)return [];const evidence=checkpoint.evidence;
  const candidates:GeometryCandidate[]=[],seen=new Map<string,string>();
  for(const feature of evidence.features){
    if(feature.kind==='folder'||feature.kind==='text')continue;
    const measurements=feature.kind==='area'?[['area',feature.measurements.area_m2,'m2'],['perimeter',feature.measurements.perimeter_m,'m']]
      :feature.kind==='line'?[['length',feature.measurements.length_m,'m']]
      :[['area',feature.measurements.area_m2,'m2'],['opening_width',feature.measurements.opening_width_m,'m'],['count',feature.objectCount,'EA']];
    for(const [kind,quantity,unit] of measurements){
      const reviewReasons=evidence.reviewReasons.filter(code=>!['multipage_completeness_unverified','text_revision_unverified','feature_geometry_missing','unresolved_feature_relations'].includes(code));
      if(quantity===null)reviewReasons.push('measurement_missing');if(!feature.geometry)reviewReasons.push('geometry_missing');
      else if(!validProviderGeometry(feature.geometry))reviewReasons.push('provider_geometry_invalid');
      if(['area','perimeter'].includes(kind as string)&&feature.geometry&&!['Polygon','MultiPolygon'].includes(String(feature.geometry.type)))reviewReasons.push('area_boundary_geometry_required');
      if(feature.kind==='line'&&feature.geometry&&!['LineString','MultiLineString'].includes(String(feature.geometry.type)))reviewReasons.push('line_geometry_required');
      if(feature.visible===false)reviewReasons.push('hidden_element_not_confirmed');
      const identity=digest({provider:'kamai',fileSha256:input.fileSha256,page:input.physicalPageNumber,blueprint:evidence.blueprintId,revision:evidence.revision,
        snapshot:digest(evidence.features),feature:feature.id,kind});
      const fingerprint=digest({kind,featureKind:feature.kind,class:feature.semanticClass,geometry:feature.geometry,quantity});
      if(seen.has(fingerprint))reviewReasons.push('duplicate_geometry_candidate');else seen.set(fingerprint,identity);
      candidates.push({id:identity,provider:'kamai',sourceElementId:feature.id,label:feature.name??feature.semanticClass,semanticClass:feature.semanticClass,
        measurementKind:kind as GeometryCandidate['measurementKind'],quantity:quantity as number|null,unit:unit as GeometryCandidate['unit'],
        status:reviewReasons.length?'blocked':'candidate',geometry:feature.geometry,coordinateFrame:'provider_blueprint',physicalPageNumber:input.physicalPageNumber,
        fileSha256:input.fileSha256,source:{geometryRunId:input.runId,providerProjectId:checkpoint.projectId,jobId:checkpoint.jobId,uploadId:checkpoint.uploadId,
          blueprintId:evidence.blueprintId,revision:evidence.revision,providerFileSha256:checkpoint.fileSha256,scale:evidence.scale,relations:feature.relations},
        reviewReasons:[...new Set(reviewReasons)],reviewRevision:0,aggregationGroup:feature.kind==='area'&&kind==='area'
          ? feature.semanticClass==='room'?'room_area':'area_surface'
          :kind==='count'?'individual_object':feature.kind==='object'?'object_surface':'linear_element'});
    }
  }return candidates;
}
/** Native properties are usable only with explicit typed units; labels/bboxes/URNs never become quantities. */
export function apsPropertyCandidates(payload:unknown,input:{runId:string;fileSha256:string;sourceUrn:string;sourceVersion:string;viewGuid:string}):GeometryCandidate[]{
  const body=payload as any,items=body?.data?.collection;if(!Array.isArray(items)||items.length>5000)throw new Error('aps_property_collection_unverified');
  const candidates:GeometryCandidate[]=[];const ids=new Set<number>();
  for(const item of items){
    if(!Number.isSafeInteger(item?.objectid)||ids.has(item.objectid))throw new Error('aps_object_identity_unverified');ids.add(item.objectid);
    const properties=item.properties;if(!properties||typeof properties!=='object')continue;
    for(const [category,values] of Object.entries(properties))if(values&&typeof values==='object')for(const [name,value] of Object.entries(values as Record<string,unknown>)){
      const textual=typeof value==='string'?value.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s+(m2|m²|m\^2|mm2|mm²|mm\^2|ft2|ft²|ft\^2|m|mm|cm|ft|in|EA)\s*$/):null;
      const typed=value&&typeof value==='object'&&!Array.isArray(value)?value as any:textual?{value:Number(textual[1]),unit:textual[2]}:{value,unit:null};
      const originalUnit=typed.unit??typed.units;const originalQuantity=typed.value;
      const conversion:Record<string,{unit:'m2'|'m'|'EA';factor:number}>={m2:{unit:'m2',factor:1},'m²':{unit:'m2',factor:1},'m^2':{unit:'m2',factor:1},mm2:{unit:'m2',factor:0.000001},'mm²':{unit:'m2',factor:0.000001},'mm^2':{unit:'m2',factor:0.000001},ft2:{unit:'m2',factor:0.09290304},'ft²':{unit:'m2',factor:0.09290304},'ft^2':{unit:'m2',factor:0.09290304},
        m:{unit:'m',factor:1},mm:{unit:'m',factor:0.001},cm:{unit:'m',factor:0.01},ft:{unit:'m',factor:0.3048},in:{unit:'m',factor:0.0254},EA:{unit:'EA',factor:1}};
      const converted=typeof originalUnit==='string'?conversion[originalUnit]:undefined;
      const relevant=/area|surface|length|width|perimeter|count|quantity/i.test(name);if(!converted&&!relevant)continue;
      const kindExpected=/area|surface/i.test(name)?'area':/count|quantity/i.test(name)?'count':/length|width|perimeter/i.test(name)?'length':null;
      const valid=Boolean(converted&&typeof originalQuantity==='number'&&Number.isFinite(originalQuantity)&&originalQuantity>=0&&Number.isFinite(originalQuantity*converted.factor)
        &&(!kindExpected||kindExpected==='area'&&converted.unit==='m2'||kindExpected==='length'&&converted.unit==='m'||kindExpected==='count'&&converted.unit==='EA')
        &&(converted.unit!=='EA'||Number.isSafeInteger(originalQuantity)));
      const unit=valid?converted!.unit:null,quantity=valid?originalQuantity*converted!.factor:null;
      const measure=unit==='m2'?'area':unit==='EA'?'count':/area|surface/i.test(name)?'area':'length';
      candidates.push({id:digest({...input,dbId:item.objectid,category,name}),provider:'aps',sourceElementId:String(item.objectid),label:String(item.name??name).slice(0,240),
        semanticClass:String(category).slice(0,120),measurementKind:measure,quantity,unit,status:valid?'candidate':'blocked',geometry:null,coordinateFrame:'native_model',
        physicalPageNumber:null,fileSha256:input.fileSha256,source:{geometryRunId:input.runId,sourceUrn:input.sourceUrn,sourceVersion:input.sourceVersion,viewGuid:input.viewGuid,
          dbId:item.objectid,propertyCategory:category,propertyName:name,unitEvidence:originalUnit??null,originalQuantity:originalQuantity??null,
          sourcePropertyValue:value,conversionFactor:converted?.factor??null},reviewReasons:valid?[]:['native_property_unit_or_value_unverified'],reviewRevision:0,aggregationGroup:'native_property'});
    }
  }return candidates;
}
