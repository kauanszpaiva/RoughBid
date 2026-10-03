import assert from 'node:assert/strict';
import test from 'node:test';
import { PHOTO_ASSET_LIMITS, PhotoEvidenceError, buildPhotoEvidenceBudget, planPhotoEvidence, reviewPhotoEvidence,
  validatePhotoAssets, type PhotoDimensionReference, type PhotoObservation, type PhotoReviewDecision, type PhotoSourceAsset } from '../src/photo-evidence.ts';

const workspaceId = 'workspace-a', projectId = 'project-a';
function asset(id = 'photo-a', hash = 'a'): PhotoSourceAsset {
  return { id, workspaceId, projectId, sha256: hash.repeat(64), revision: 'rev-a', mimeType: 'image/jpeg',
    byteSize: 1024, widthPixels: 2000, heightPixels: 1500, storageVerified: true };
}
const region = (sourceAssetId = 'photo-a') => ({ sourceAssetId, surfaceKey: 'wall-plane', bbox: [0.1, 0.1, 0.5, 0.5] as const });
function observation(id = 'wall-observation', sourceAssetId = 'photo-a'): PhotoObservation {
  return { id, label: 'Wall finish', regions: [region(sourceAssetId)], proposedQuantity: 100, proposedUnit: 'SF',
    referenceId: null, method: 'visual_estimate', confidence: 0.99, uncertainty: ['perspective', 'hidden_scope'] };
}
function reference(sourceAssetId = 'photo-a'): PhotoDimensionReference {
  return { id: `ref-${sourceAssetId}`, region: region(sourceAssetId), objectIdentityKey: 'physical-wall', reviewerId: 'estimator-a',
    verified: true, kind: 'instrument_reading', value: 100, unit: 'SF', coplanarVerified: false, perspectiveVerified: false };
}
function decision(observationId = 'wall-observation', sourceAssetId = 'photo-a'): PhotoReviewDecision {
  return { observationId, disposition: 'approved', reviewerId: 'estimator-a', quantity: 100, unit: 'SF', method: 'instrument_measurement',
    calculationMethod: 'Verified field instrument area reading', referenceId: `ref-${sourceAssetId}`, objectIdentityKey: 'physical-wall',
    identityAssetIds: [sourceAssetId], crossViewIdentityReviewed: false, uncertaintyResolved: true };
}
function review(options: Partial<Parameters<typeof reviewPhotoEvidence>[0]> = {}) {
  return reviewPhotoEvidence({ assets: [asset()], workspaceId, projectId, observations: [observation()], references: [], decisions: [], ...options });
}
const code = (expected: string) => (error: unknown) => error instanceof PhotoEvidenceError && error.code === expected;
function profile() {
  const route = { provider: 'openai', model: 'gpt-6-astra', accountVerified: true, imageCompatibilityVerified: true,
    priceVersion: 'reviewed-tariff-1', maximumCallCostUsd: 10 };
  return { enabled: true, quality: 'maximum', routes: { observation: route, reconciliation: route, risk_review: route } };
}

test('photo planning is disabled by default, explicitly selects strong models and never creates a paid call', () => {
  const input = { assets: [asset()], workspaceId, projectId, authorizedRole: 'estimator' as const,
    aiProcessingConsented: true, photoDataProcessingApproved: true };
  assert.throws(() => planPhotoEvidence({ ...input, profile: {} }), code('photo_processing_disabled'));
  const selected = planPhotoEvidence({ ...input, profile: profile() });
  assert.deepEqual(selected.requests.map(item => item.route.model), ['gpt-6-astra', 'gpt-6-astra', 'gpt-6-astra']);
  assert.equal(selected.requests[0]?.sources[0]?.sourceAssetId, 'photo-a');
  const cheap = profile(); cheap.routes.observation.model = 'gemini-3.8-flash'; cheap.routes.observation.provider = 'gemini';
  assert.throws(() => planPhotoEvidence({ ...input, profile: cheap }), code('explicit_maximum_quality_model_required'));
  assert.throws(() => planPhotoEvidence({ ...input, authorizedRole: 'viewer', profile: profile() }), code('photo_processing_authorization_required'));
  assert.throws(() => planPhotoEvidence({ ...input, photoDataProcessingApproved: false, profile: profile() }), code('photo_processing_authorization_required'));
});

test('source metadata requires scoped verified images and bounded MIME/bytes/pixels; private extras are not copied', () => {
  for (const patch of [{ mimeType: 'application/pdf' }, { projectId: 'other-project' }, { storageVerified: false },
    { byteSize: PHOTO_ASSET_LIMITS.maximumAssetBytes + 1 }, { widthPixels: 100000 }, { sha256: 'tag' }]) {
    assert.throws(() => validatePhotoAssets([{ ...asset(), ...patch }], { workspaceId, projectId }), code('invalid_photo_asset'));
  }
  assert.throws(() => validatePhotoAssets([asset(), asset('photo-b')], { workspaceId, projectId }), code('invalid_photo_asset'));
  const clean = validatePhotoAssets([{ ...asset(), signedUrl: 'https://private.invalid', secret: 'fixture-only' }], { workspaceId, projectId });
  assert.equal(Object.hasOwn(clean[0]!, 'signedUrl'), false); assert.equal(Object.hasOwn(clean[0]!, 'secret'), false);
});

test('batch reconciliation preserves 70 observations from each of two photos and rejects more than 100 on one source',()=>{
  const assets=[asset(),asset('photo-b','b')];
  const observations=assets.flatMap(source=>Array.from({length:70},(_,index)=>observation(`${source.id}-object-${index}`,source.id)));
  const result=review({assets,observations});
  assert.equal(result.observations.length,140);
  for(const source of assets)assert.equal(result.observations.filter(item=>item.regions.some(region=>region.sourceAssetId===source.id)).length,70);
  assert.equal(result.approvedMeasurements.length,0);
  assert.ok(result.observations.every(item=>item.proposedQuantity===null));
  const concentrated=Array.from({length:101},(_,index)=>observation(`object-${index}`));
  assert.throws(()=>review({observations:concentrated}),code('photo_asset_observation_limit_exceeded'));
});

test('uncalibrated photo confidence, tags and proposed money never become metric quantity or price', () => {
  const result = review({ observations: [{ ...observation(), materialCost: 900, scale: 42, objectTag: 'W1' }] });
  assert.equal(result.observations[0]?.proposedQuantity, null);
  assert.ok(result.observations[0]?.uncertainty.includes('physical_dimension_reference_required'));
  assert.equal(result.approvedMeasurements.length, 0); assert.equal(result.estimate, null); assert.equal(result.pricingStatus, 'missing_price');
  assert.equal(Object.hasOwn(result.observations[0]!, 'materialCost'), false);
  const supplied = { ...observation(), method: 'instrument_measurement' as const, referenceId: 'ref-photo-a' };
  assert.equal(review({ observations: [supplied], references: [reference()] }).observations[0]?.proposedQuantity, 100);
  assert.equal(review({ observations: [supplied], references: [reference()] }).approvedMeasurements.length, 0);
  assert.equal(review({ observations: [supplied], references: [{ ...reference(), value: 90 }] }).observations[0]?.proposedQuantity, null);
});

test('only reviewed instrument value/unit at the same image surface approves quantity', () => {
  const input = { references: [reference()], decisions: [decision()] };
  const approved = review(input); assert.equal(approved.approvedMeasurements[0]?.quantity, 100);
  assert.equal(approved.approvedMeasurements[0]?.sourceRevisions['photo-a'], 'rev-a');
  for (const patch of [{ verified: false }, { value: 90 }, { unit: 'LF' as const }, { objectIdentityKey: 'other-wall' },
    { region: { ...region(), surfaceKey: 'different-plane' } }]) {
    assert.equal(review({ ...input, references: [{ ...reference(), ...patch }] }).approvedMeasurements.length, 0);
  }
});

test('planar flags and a calculation label cannot approve a metric quantity without deterministic calibration', () => {
  const ref = { ...reference(), kind: 'planar_calibration' as const, value: 1, unit: 'M' as const, coplanarVerified: true, perspectiveVerified: true };
  const approved = { ...decision(), method: 'calibrated_planar_geometry' as const, calculationMethod: 'Reviewed rectified-plane calculation' };
  const proposed = { ...observation(), method:'calibrated_planar_geometry' as const, referenceId:ref.id };
  const pending=review({ observations:[proposed], references: [ref], decisions: [approved] });
  assert.equal(pending.approvedMeasurements.length, 0);
  assert.equal(pending.observations[0]?.proposedQuantity,null);
  assert.ok(pending.blockers.includes('wall-observation:deterministic_photo_calibration_required'));
  assert.ok(pending.observations[0]?.uncertainty.includes('deterministic_photo_calibration_required'));
  assert.equal(review({ references: [{ ...ref, perspectiveVerified: false }], decisions: [approved] }).approvedMeasurements.length, 0);
  assert.equal(review({ references: [{ ...ref, coplanarVerified: false }], decisions: [approved] }).approvedMeasurements.length, 0);
  assert.equal(review({ references: [ref], decisions: [{ ...approved, unit: 'CY' }] }).approvedMeasurements.length, 0);
});

test('cross-view object identity prevents double count; contradictory quantities require reconciliation', () => {
  const assets = [asset(), asset('photo-b', 'b')], observations = [observation(), observation('wall-other-view', 'photo-b')];
  const references = [reference(), reference('photo-b')];
  const decisions = [decision(), decision('wall-other-view', 'photo-b')];
  const incomplete = review({ assets, observations, references, decisions });
  assert.equal(incomplete.approvedMeasurements.length, 0); assert.ok(incomplete.blockers.some(item => item.includes('cross_view')));
  const reviewed = decisions.map(item => ({ ...item, identityAssetIds: ['photo-a', 'photo-b'], crossViewIdentityReviewed: true }));
  const combined = review({ assets, observations, references, decisions: reviewed });
  assert.equal(combined.approvedMeasurements.length, 1); assert.equal(combined.approvedMeasurements[0]?.quantity, 100);
  assert.equal(combined.approvedMeasurements[0]?.sourceRegions.length, 2);
  const different = { ...references[1]!, value: 101 }, changed = { ...reviewed[1]!, quantity: 101 };
  assert.ok(review({ assets, observations, references: [references[0]!, different], decisions: [reviewed[0]!, changed] }).blockers.some(item => item.includes('conflicting')));
  const unitReference = { ...references[1]!, unit: 'SY' as const }, otherUnit = { ...reviewed[1]!, unit: 'SY' as const };
  assert.ok(review({ assets, observations, references: [references[0]!, unitReference], decisions: [reviewed[0]!, otherUnit] }).blockers.some(item => item.includes('conflicting')));
});

test('null differs from a reviewed zero count, and missing prices keep the sourced budget null', () => {
  const count = { ...observation(), proposedQuantity: 0, proposedUnit: 'EA' as const, method: 'visible_count' as const };
  const counted = { ...decision(), quantity: 0, unit: 'EA' as const, method: 'visible_count' as const, referenceId: null };
  const approved = review({ observations: [count], decisions: [counted] });
  assert.equal(approved.approvedMeasurements[0]?.quantity, 0);
  assert.equal(review({ observations: [count], decisions: [{ ...counted, quantity: null }] }).approvedMeasurements.length, 0);
  const measured = review({ references: [reference()], decisions: [decision()] });
  const missing = buildPhotoEvidenceBudget(measured, { asOf: '2026-10-02', reviewedAssetIds: ['photo-a'],
    assemblies: [], selections: [], policies: { generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 } } });
  assert.equal(missing.estimate, null); assert.equal(missing.releaseStatus, 'blocked');
});

test('verified photo quantity uses existing sourced composition math and retains source-image provenance', () => {
  const measured = review({ references: [reference()], decisions: [decision()] });
  const source = { sourceType: 'project_quote' as const, sourceName: 'Reviewed vendor quote', effectiveDate: '2026-09-01',
    expiresAt: '2026-12-01', geography: 'MA', vendor: 'Fixture vendor', sku: null, confidence: 1 };
  const result = buildPhotoEvidenceBudget(measured, { asOf: '2026-10-02', reviewedAssetIds: ['photo-a'],
    assemblies: [{ id: 'approved-finish', description: 'Reviewed finish composition', unit: 'SF', reviewed: true, wastePercent: 0, material: { amount: 2, source } }],
    selections: [{ measurementId: measured.approvedMeasurements[0]!.id, assemblyId: 'approved-finish' }],
    policies: { generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 } } });
  assert.equal(result.estimate?.finalBid, 200); assert.equal(result.humanReviewRequired, true);
  assert.ok(result.provenance[0]?.sourceRef.startsWith('photo:photo-a:'));
});
