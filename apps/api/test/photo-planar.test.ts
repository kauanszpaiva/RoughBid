import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePhotoPlanarMeasurement, PhotoEvidenceError, reviewPhotoEvidence,
  type PhotoPlanarCalibration,type PhotoPlanarMeasurement,type PhotoDimensionReference,type PhotoReviewDecision,type PhotoSourceAsset } from '../src/photo-evidence.ts';

const asset:PhotoSourceAsset={id:'photo-a',workspaceId:'workspace-a',projectId:'project-a',sha256:'a'.repeat(64),revision:'rev-a',mimeType:'image/png',
  byteSize:1000,widthPixels:400,heightPixels:300,storageVerified:true};
const metadata={sourceAssetId:asset.id,sourceRevision:asset.revision,sourceSha256:asset.sha256,surfaceKey:'wall-plane'};
function calibration(changes:Partial<PhotoPlanarCalibration>={}):PhotoPlanarCalibration {
  return {version:'photo-planar-v1',...metadata,referencePoints:[[.1,.1],[.9,.1],[.9,.9],[.1,.9]],referenceWidth:10,referenceHeight:12,
    referenceUnit:'LF',rectangleVerified:true,lensDistortionReviewed:true,...changes};
}
function measurement(changes:Partial<PhotoPlanarMeasurement>={}):PhotoPlanarMeasurement {
  return {version:'photo-planar-v1',...metadata,kind:'polygon',points:calibration().referencePoints,measure:'area',samePlaneReviewed:true,geometryReviewed:true,...changes};
}
function calculate(changes:Partial<Parameters<typeof calculatePhotoPlanarMeasurement>[0]>={}){
  return calculatePhotoPlanarMeasurement({asset,surfaceKey:metadata.surfaceKey,referenceId:'reference-a',reviewerId:'reviewer-a',objectIdentityKey:'wall-a',
    calibration:calibration(),measurement:measurement(),unit:'SF',...changes});
}
const near=(actual:number,expected:number,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const code=(value:string)=>(error:unknown)=>error instanceof PhotoEvidenceError&&error.code===value;
function review(changes:{calibration?:unknown;measurement?:unknown;reference?:Partial<PhotoDimensionReference>;decision?:Partial<PhotoReviewDecision>}={}){
  const reference:PhotoDimensionReference={id:'reference-a',region:{sourceAssetId:asset.id,surfaceKey:metadata.surfaceKey,bbox:[0,0,1,1]},objectIdentityKey:'wall-a',
    reviewerId:'reviewer-a',verified:true,kind:'planar_calibration',value:10,unit:'LF',coplanarVerified:true,perspectiveVerified:true,
    planarCalibration:(changes.calibration??calibration()) as PhotoPlanarCalibration,...changes.reference};
  const decision:PhotoReviewDecision={observationId:'observation-a',disposition:'approved',reviewerId:'reviewer-a',quantity:null,unit:'SF',method:'calibrated_planar_geometry',
    calculationMethod:'Human selected reviewed wall region.',referenceId:reference.id,objectIdentityKey:'wall-a',identityAssetIds:[asset.id],crossViewIdentityReviewed:false,uncertaintyResolved:true,
    planarMeasurement:(changes.measurement??measurement()) as PhotoPlanarMeasurement,...changes.decision};
  return reviewPhotoEvidence({assets:[asset],workspaceId:asset.workspaceId,projectId:asset.projectId,
    observations:[{id:decision.observationId,label:'Visible wall',regions:[reference.region],proposedQuantity:null,proposedUnit:null,referenceId:null,method:'visual_estimate',confidence:.8,uncertainty:['Human calibration required.']}],
    references:[reference],decisions:[decision]});
}

test('four reviewed points and known feet dimensions yield exact full/partial area with SI and auditable hashes',()=>{
  const full=calculate();assert.equal(full.quantity,120);near(full.areaM2!,120*.09290304);near(full.perimeterM!,44*.3048);
  assert.equal(full.scope,'reviewed_planar_region');assert.equal(full.status,'human_reviewed_conditional_measurement');
  assert.equal(full.sourceSha256,asset.sha256);assert.equal(full.sourceRevision,asset.revision);
  assert.equal(full.imageToPlaneMeters.length,9);assert.equal(full.transformedPointsMeters.length,4);assert.equal(full.uncertainty.automaticCertification,false);
  assert.match(full.calibrationHash,/^[a-f0-9]{64}$/);assert.match(full.proofHash,/^[a-f0-9]{64}$/);assert.deepEqual(calculate(),full);
  const half=calculate({measurement:measurement({points:[[.1,.1],[.5,.1],[.5,.9],[.1,.9]]})});assert.equal(half.quantity,60);
  assert.equal(half.calibrationHash,full.calibrationHash);assert.notEqual(half.proofHash,full.proofHash);
  assert.equal(calculate({unit:'SY'}).quantity,13.333333);assert.equal(calculate({unit:'SQ'}).quantity,1.2);
});
test('perimeter and polyline length are distinct calculations; polygon boundary is closed only for perimeter',()=>{
  const perimeter=calculate({measurement:measurement({measure:'perimeter'}),unit:'LF'});assert.equal(perimeter.quantity,44);assert.equal(perimeter.lengthM,null);
  const length=calculate({measurement:measurement({kind:'polyline',measure:'length',points:[[.1,.1],[.9,.1],[.9,.9]]}),unit:'LF'});
  assert.equal(length.quantity,22);assert.equal(length.areaM2,null);assert.equal(length.perimeterM,null);near(length.lengthM!,22*.3048);
  const concave=calculate({measurement:measurement({points:[[.1,.1],[.9,.1],[.9,.5],[.5,.5],[.5,.9],[.1,.9]]})});assert.equal(concave.quantity,90);
});
test('projective trapezoid rectification recovers 2m² instead of a global pixel-area ratio',()=>{
  const control=calibration({referencePoints:[[0,0],[.5,0],[.5,.5],[0,1]],referenceWidth:4,referenceHeight:3,referenceUnit:'M'});
  const polygon=measurement({points:[[80/400,80/300],[(1200/7)/400,(400/7)/300],[(1200/7)/400,(800/7)/300],[80/400,160/300]]});
  const result=calculate({calibration:control,measurement:polygon});near(result.areaM2!,2);assert.equal(result.quantity,21.527821);
  const expected=[4,0,0,0,3,0,-1,0,1];result.imageToPlaneMeters.forEach((value,index)=>near(value,expected[index]!));
  near(result.numericalChecks.denominatorRatio,2);assert.ok(result.numericalChecks.maximumReferenceReprojectionError<1e-8);
});
test('metric inputs and mirrored cyclic correspondences preserve physical measurements without silent point reordering',()=>{
  const ref=calibration({referencePoints:[[0,0],[1,0],[1,1],[0,1]],referenceWidth:4,referenceHeight:3,referenceUnit:'M'});
  const region=measurement({points:[[.25,1/3],[.75,1/3],[.75,2/3],[.25,2/3]]});
  near(calculate({calibration:ref,measurement:region}).areaM2!,2);
  near(calculate({calibration:{...ref,referencePoints:[...ref.referencePoints].reverse()},measurement:region}).areaM2!,2);
  const crossed=[ref.referencePoints[0],ref.referencePoints[2],ref.referencePoints[1],ref.referencePoints[3]];
  assert.throws(()=>calculate({calibration:{...ref,referencePoints:crossed},measurement:region}),code('self_intersecting_photo_planar_geometry'));
  const imperial=calculate({calibration:calibration({referenceWidth:12,referenceHeight:8})});assert.equal(imperial.quantity,96);near(imperial.areaM2!,8.91869184);
});
test('unknown dimensions, stale source/plane and missing human geometric declarations never produce a quantity',()=>{
  for(const changes of [{widthPixels:NaN},{heightPixels:0},{widthPixels:Infinity},{sha256:'not-a-hash'},{revision:''}]){
    assert.throws(()=>calculate({asset:{...asset,...changes}}),code('invalid_photo_planar_source'));
  }
  for(const changes of [{referenceWidth:0},{referenceHeight:NaN},{referenceUnit:'SF'},{referenceWidth:Infinity}])assert.throws(()=>calculate({calibration:{...calibration(),...changes}}),code('photo_planar_dimensions_required'));
  for(const changes of [{sourceAssetId:'other-photo'},{sourceRevision:'older'},{sourceSha256:'b'.repeat(64)},{surfaceKey:'other-plane'}]){
    assert.throws(()=>calculate({calibration:{...calibration(),...changes}}),code('photo_planar_source_mismatch'));
    assert.throws(()=>calculate({measurement:{...measurement(),...changes}}),code('photo_planar_source_mismatch'));
  }
  assert.throws(()=>calculate({calibration:{...calibration(),rectangleVerified:false}}),code('photo_planar_reference_review_required'));
  assert.throws(()=>calculate({calibration:{...calibration(),lensDistortionReviewed:false}}),code('photo_planar_reference_review_required'));
  for(const flag of [false,undefined])assert.throws(()=>calculate({measurement:{...measurement(),samePlaneReviewed:flag}}),code('photo_planar_geometry_review_required'));
  assert.throws(()=>calculate({measurement:{...measurement(),geometryReviewed:false}}),code('photo_planar_geometry_review_required'));
  assert.throws(()=>calculate({unit:'CY'}),code('invalid_photo_planar_unit'));
});
test('crossed, repeated, collinear, low-resolution and nonfinite controls are rejected rather than numerically extrapolated',()=>{
  const invalid=[[[.1,.1],[.9,.1],[.9,.1],[.1,.9]],[[.1,.1],[.4,.1],[.7,.1],[.9,.1]],[[.1,.1],[.9,.1],[.9,.10000000001],[.1,.10000000001]],
    [[.1,.1],[.9,.1],[.2,.2],[.1,.9]],[[.1,.1],[.9,.1],[NaN,.9],[.1,.9]],[[.1,.1],[.9,.1],[.9,Infinity],[.1,.9]]];
  for(const referencePoints of invalid)assert.throws(()=>calculate({calibration:{...calibration(),referencePoints}}),error=>error instanceof PhotoEvidenceError);
  assert.throws(()=>calculate({asset:{...asset,widthPixels:1,heightPixels:1}}),code('photo_planar_reference_resolution_insufficient'));
});
test('self-intersections, unsupported holes, extrapolation and horizon-crossing selections stay blocked',()=>{
  assert.throws(()=>calculate({measurement:measurement({points:[[.2,.2],[.8,.8],[.8,.2],[.2,.8]]})}),code('self_intersecting_photo_planar_geometry'));
  assert.throws(()=>calculate({measurement:{...measurement(),holes:[]}}),code('unsupported_photo_planar_holes'));
  assert.throws(()=>calculate({measurement:measurement({points:[[0,0],[1,0],[1,1],[0,1]]})}),code('photo_planar_geometry_outside_calibrated_region'));
  // The reference's projective horizon is x=1; the selection crosses it even
  // though every supplied image coordinate is finite. No extrapolation allowed.
  assert.throws(()=>calculate({calibration:calibration({referencePoints:[[0,0],[.5,0],[.5,.5],[0,1]]}),measurement:measurement({points:[[.975,.2],[1,.2],[1,.4],[.975,.4]]})}),code('photo_planar_geometry_outside_calibrated_region'));
});
test('review integrates server-computed planar quantities with evidence, while false/unknown plane membership remains pending',()=>{
  const result=review();assert.equal(result.approvedMeasurements[0]?.quantity,120);assert.equal(result.blockers.length,0);
  assert.equal(result.approvedMeasurements[0]?.calculationMethod,'homography_rectangle_v1_area');
  assert.equal(result.approvedMeasurements[0]?.measurementScope,'reviewed_planar_region');assert.equal(result.planarProofs?.length,1);
  assert.equal(result.estimate,null);assert.equal(result.pricingStatus,'missing_price');assert.equal(result.humanReviewRequired,true);
  for(const flag of [false,undefined]){
    const pending=review({measurement:{...measurement(),samePlaneReviewed:flag}});assert.equal(pending.approvedMeasurements.length,0);
    assert.ok(pending.blockers.includes('observation-a:photo_planar_geometry_review_required'));
  }
  const untrustedQuantity=review({decision:{quantity:120}});assert.equal(untrustedQuantity.approvedMeasurements.length,0);
  assert.ok(untrustedQuantity.blockers.includes('observation-a:photo_planar_client_quantity_forbidden'));
  const mismatch=review({reference:{value:11}});assert.equal(mismatch.approvedMeasurements.length,0);
  assert.ok(mismatch.blockers.includes('observation-a:photo_planar_reference_dimensions_mismatch'));
});
