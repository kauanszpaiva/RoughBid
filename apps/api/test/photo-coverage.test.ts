import test from 'node:test';
import assert from 'node:assert/strict';
import { photoSourceBlockers, summarizePhotoCoverage } from '../src/photos/coverage.ts';
import type { PhotoSourceAsset } from '../src/photo-evidence.ts';

const assets = ['photo-1','photo-2'].map(id => ({id})) as PhotoSourceAsset[];
const observation = {id:'wall',method:'visual_estimate',proposedQuantity:null,regions:[{sourceAssetId:'photo-1',surfaceKey:'wall'}]};

test('photo coverage requires each distinct source checkpoint, not aggregate run progress or observed count', () => {
  const result = {photoQuality:[{sourceAssetId:'photo-1',usable:true,additionalViewsNeeded:true}],observations:[observation],progress:{completed:2,total:2}};
  const coverage = summarizePhotoCoverage(assets,[{photo_asset_id:'photo-1',status:'completed'}],result);
  assert.deepEqual(coverage.processedAssetIds,['photo-1']);
  assert.deepEqual(coverage.pendingAssetIds,['photo-2']);
  assert.deepEqual(coverage.unassessedAssetIds,['photo-2']);
  assert.deepEqual(coverage.additionalViewAssetIds,['photo-1']);
  assert.deepEqual(coverage.referenceRequiredObservationIds,['wall']);
  assert.equal(coverage.processingComplete,false);
  assert.equal(coverage.completeTakeoffVerified,false);
  assert.equal(coverage.estimateStatus,'pending');
  const duplicate = summarizePhotoCoverage(assets,[{photo_asset_id:'photo-1',status:'completed'},{photo_asset_id:'photo-1',status:'completed'},{photo_asset_id:'other',status:'completed'}],result);
  assert.deepEqual(duplicate.processedAssetIds,[]);
});

test('reference requests clear only for rejected observations or backed reviewed measurements; counts need no invented physical reference', () => {
  const result = {observations:[observation,{id:'count',method:'visible_count'}],decisions:[{observationId:'wall',disposition:'approved',objectIdentityKey:'wall-identity'}],
    approvedMeasurements:[{objectIdentityKey:'wall-identity',sourceRegions:[{sourceAssetId:'photo-1',surfaceKey:'wall'}]}]};
  const steps = assets.map(asset => ({photo_asset_id:asset.id,status:'completed'}));
  assert.deepEqual(summarizePhotoCoverage(assets,steps,result).referenceRequiredObservationIds,[]);
  assert.deepEqual(summarizePhotoCoverage(assets,steps,{...result,blockers:['wall:conflicting_photo_measurements']}).referenceRequiredObservationIds,['wall']);
  assert.deepEqual(summarizePhotoCoverage(assets,steps,{...result,approvedMeasurements:[]}).referenceRequiredObservationIds,['wall']);
  const rejected = summarizePhotoCoverage(assets,steps,{observations:[observation],decisions:[{observationId:'wall',disposition:'rejected'}]});
  assert.deepEqual(rejected.referenceRequiredObservationIds,[]);
  assert.equal(rejected.processingComplete,true);
  assert.equal(rejected.completeTakeoffVerified,false);
  const supplied = summarizePhotoCoverage(assets,steps,{observations:[observation],references:[{verified:true,value:5,region:{sourceAssetId:'photo-1',surfaceKey:'wall'}}]});
  assert.deepEqual(supplied.referenceRequiredObservationIds,[]);
  assert.deepEqual(supplied.unresolvedObservationIds,['wall']); // Review remains; do not request the same reference twice.
});

test('immutable source blockers survive quantity review and missing or unusable views remain explicit', () => {
  assert.deepEqual(photoSourceBlockers(assets,[{photo_asset_id:'photo-1',status:'completed',result:{quality:{usable:false,additionalViewsNeeded:true},blockers:['occluded_surface']}}]),[
    'photo-1:photo_unusable_source','photo-1:additional_photo_views_required','photo-1:occluded_surface','photo-2:photo_checkpoint_pending',
  ]);
  assert.deepEqual(photoSourceBlockers(assets,[{photo_asset_id:'photo-1',status:'completed',result:{quality:{},blockers:[]}}]),[
    'photo-1:photo_quality_review_required','photo-2:photo_checkpoint_pending',
  ]);
});
