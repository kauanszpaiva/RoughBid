import { UNIT_REGISTRY, isCanonicalUnit, type CanonicalUnit } from '../../../../packages/domain/src/takeoff-v2.ts';
import { buildEvidenceBudget, type BudgetMeasurement, type EvidenceBudgetInput, type EvidenceBudgetResult } from '../takeoff-v2/evidence-budget.ts';
import { PHOTO_EVIDENCE_STAGES, PhotoEvidenceError, requirePhotoEvidenceProfile, type PhotoStageRoute } from './profile.ts';

export const PHOTO_ASSET_LIMITS = Object.freeze({ maximumAssets: 8, maximumAssetBytes: 20 * 1024 * 1024,
  maximumBatchBytes: 40 * 1024 * 1024, maximumPixels: 64_000_000,
  maximumObservationsPerAsset: 100, maximumObservations: 800 });
export type PhotoMimeType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface PhotoSourceAsset {
  id: string;
  workspaceId: string;
  projectId: string;
  sha256: string;
  revision: string;
  mimeType: PhotoMimeType;
  byteSize: number;
  widthPixels: number;
  heightPixels: number;
  /** Metadata must come from verified private storage, never a model claim. */
  storageVerified: true;
}
export interface PhotoRegion {
  sourceAssetId: string;
  surfaceKey: string;
  /** Normalized [x, y, width, height]. Regions localize evidence, never scale it. */
  bbox: readonly [number, number, number, number];
}
export type PhotoMeasurementMethod = 'visible_count' | 'instrument_measurement' | 'calibrated_planar_geometry' | 'visual_estimate';
export interface PhotoObservation {
  id: string;
  label: string;
  regions: readonly PhotoRegion[];
  proposedQuantity: number | null;
  proposedUnit: CanonicalUnit | null;
  referenceId: string | null;
  method: PhotoMeasurementMethod;
  confidence: number;
  uncertainty: readonly string[];
}
export interface PhotoDimensionReference {
  id: string;
  region: PhotoRegion;
  objectIdentityKey: string;
  reviewerId: string;
  verified: boolean;
  kind: 'instrument_reading' | 'planar_calibration';
  /** Instrument values are verified readings; calibration lengths are not area. */
  value: number;
  unit: CanonicalUnit | 'M';
  coplanarVerified: boolean;
  perspectiveVerified: boolean;
}
/** Trusted human decisions are separate from untrusted model observations. */
export interface PhotoReviewDecision {
  observationId: string;
  disposition: 'approved' | 'rejected';
  reviewerId: string;
  quantity: number | null;
  unit: CanonicalUnit | null;
  method: PhotoMeasurementMethod;
  calculationMethod: string;
  referenceId: string | null;
  objectIdentityKey: string;
  /** Explicitly reviewed physical identity, not a model tag or similar label. */
  identityAssetIds: readonly string[];
  crossViewIdentityReviewed: boolean;
  uncertaintyResolved: boolean;
}
export interface PhotoApprovedMeasurement {
  id: string;
  objectIdentityKey: string;
  quantity: number;
  unit: CanonicalUnit;
  method: Exclude<PhotoMeasurementMethod, 'visual_estimate'>;
  calculationMethod: string;
  sourceRegions: readonly PhotoRegion[];
  sourceRevisions: Readonly<Record<string, string>>;
  referenceIds: readonly string[];
  reviewerIds: readonly string[];
}
export interface PhotoEvidenceReview {
  assets: readonly PhotoSourceAsset[];
  observations: readonly PhotoObservation[];
  approvedMeasurements: readonly PhotoApprovedMeasurement[];
  blockers: readonly string[];
  humanReviewRequired: true;
  releaseStatus: 'blocked' | 'measurement_review_ready';
  pricingStatus: 'missing_price';
  estimate: null;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);
const boundedText = (value: unknown, maximum = 500): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const decimal = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && value <= Number.MAX_SAFE_INTEGER && /^(\d+)(?:\.(\d{1,6}))?$/.test(String(value));
const METHODS = new Set<PhotoMeasurementMethod>(['visible_count', 'instrument_measurement', 'calibrated_planar_geometry', 'visual_estimate']);
function fail(code: string): never { throw new PhotoEvidenceError(code); }

export function validatePhotoAssets(input: unknown, scope: { workspaceId: string; projectId: string }): readonly PhotoSourceAsset[] {
  if (!identifier(scope.workspaceId) || !identifier(scope.projectId) || !Array.isArray(input)
    || input.length < 1 || input.length > PHOTO_ASSET_LIMITS.maximumAssets) fail('invalid_photo_source_batch');
  const identities = new Set<string>();
  const hashes = new Set<string>();
  let bytes = 0;
  const assets = input.map((asset: unknown): PhotoSourceAsset => {
    if (!record(asset) || !identifier(asset.id) || identities.has(asset.id) || typeof asset.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(asset.sha256) || hashes.has(asset.sha256) || !identifier(asset.revision)
      || asset.workspaceId !== scope.workspaceId || asset.projectId !== scope.projectId || asset.storageVerified !== true
      || !['image/jpeg', 'image/png', 'image/webp'].includes(String(asset.mimeType))
      || !Number.isSafeInteger(asset.byteSize) || Number(asset.byteSize) < 1 || Number(asset.byteSize) > PHOTO_ASSET_LIMITS.maximumAssetBytes
      || !Number.isSafeInteger(asset.widthPixels) || !Number.isSafeInteger(asset.heightPixels)
      || Number(asset.widthPixels) < 1 || Number(asset.heightPixels) < 1
      || Number(asset.widthPixels) * Number(asset.heightPixels) > PHOTO_ASSET_LIMITS.maximumPixels) fail('invalid_photo_asset');
    identities.add(asset.id); hashes.add(asset.sha256); bytes += Number(asset.byteSize);
    // Pick known metadata only. URLs, EXIF location, binary data and credentials
    // are not copied into provider planning or review artifacts.
    return Object.freeze({ id: asset.id, workspaceId: scope.workspaceId, projectId: scope.projectId,
      sha256: asset.sha256, revision: asset.revision, mimeType: asset.mimeType as PhotoMimeType,
      byteSize: Number(asset.byteSize), widthPixels: Number(asset.widthPixels), heightPixels: Number(asset.heightPixels), storageVerified: true });
  });
  if (bytes > PHOTO_ASSET_LIMITS.maximumBatchBytes) fail('photo_batch_size_exceeded');
  return Object.freeze(assets);
}

/** Produces metadata-only work requests. No uploads, model calls or implicit route. */
export function planPhotoEvidence(input: { profile: unknown; assets: unknown; workspaceId: string; projectId: string;
  authorizedRole: 'admin' | 'estimator' | 'viewer'; aiProcessingConsented: boolean; photoDataProcessingApproved: boolean }) {
  const profile = requirePhotoEvidenceProfile(input.profile);
  if (!['admin', 'estimator'].includes(input.authorizedRole) || !input.aiProcessingConsented || !input.photoDataProcessingApproved) fail('photo_processing_authorization_required');
  const assets = validatePhotoAssets(input.assets, input);
  return { humanReviewRequired: true as const, assets,
    requests: PHOTO_EVIDENCE_STAGES.map(stage => ({ stage, route: profile.routes[stage] as Readonly<PhotoStageRoute>,
      sources: assets.map(asset => ({ sourceAssetId: asset.id, sha256: asset.sha256, revision: asset.revision, mimeType: asset.mimeType })),
      quantityPolicy: 'reviewed_reference_required' as const, pricingPolicy: 'missing_price' as const })) };
}

function validRegion(value: unknown, assets: ReadonlyMap<string, PhotoSourceAsset>): value is PhotoRegion {
  if (!record(value) || !identifier(value.sourceAssetId) || !assets.has(value.sourceAssetId) || !identifier(value.surfaceKey)
    || !Array.isArray(value.bbox) || value.bbox.length !== 4 || value.bbox.some(item => typeof item !== 'number' || !Number.isFinite(item))) return false;
  const [x, y, width, height] = value.bbox as number[];
  return x! >= 0 && y! >= 0 && width! > 0 && height! > 0 && x! + width! <= 1 && y! + height! <= 1;
}
function cleanRegion(value: PhotoRegion): PhotoRegion {
  return { sourceAssetId: value.sourceAssetId, surfaceKey: value.surfaceKey, bbox: [...value.bbox] as [number, number, number, number] };
}
function normalizeObservations(values: unknown, assets: ReadonlyMap<string, PhotoSourceAsset>): PhotoObservation[] {
  if (!Array.isArray(values) || values.length > PHOTO_ASSET_LIMITS.maximumObservations) fail('invalid_photo_observations');
  const identities = new Set<string>();
  const observationsPerAsset = new Map<string,number>();
  return values.map((value: unknown): PhotoObservation => {
    if (!record(value) || !identifier(value.id) || identities.has(value.id) || !boundedText(value.label, 160)
      || !Array.isArray(value.regions) || value.regions.length < 1 || value.regions.length > PHOTO_ASSET_LIMITS.maximumAssets
      || value.regions.some(region => !validRegion(region, assets))
      || (value.proposedQuantity !== null && !decimal(value.proposedQuantity))
      || (value.proposedUnit !== null && (typeof value.proposedUnit !== 'string' || !isCanonicalUnit(value.proposedUnit)))
      || (value.referenceId !== undefined && value.referenceId !== null && !identifier(value.referenceId))
      || !METHODS.has(value.method as PhotoMeasurementMethod) || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
      || value.confidence < 0 || value.confidence > 1 || !Array.isArray(value.uncertainty) || value.uncertainty.length > 20
      || value.uncertainty.some(reason => !boundedText(reason, 160))) fail('invalid_photo_observation');
    identities.add(value.id);
    for (const assetId of new Set((value.regions as PhotoRegion[]).map(region=>region.sourceAssetId))) {
      const count=(observationsPerAsset.get(assetId)??0)+1;
      if (count>PHOTO_ASSET_LIMITS.maximumObservationsPerAsset) fail('photo_asset_observation_limit_exceeded');
      observationsPerAsset.set(assetId,count);
    }
    return { id: value.id, label: value.label, regions: value.regions.map(cleanRegion),
      proposedQuantity: value.proposedQuantity as number | null, proposedUnit: value.proposedUnit as CanonicalUnit | null,
      referenceId: typeof value.referenceId === 'string' ? value.referenceId : null,
      method: value.method as PhotoMeasurementMethod, confidence: value.confidence, uncertainty: value.uncertainty as string[] };
  });
}

/** Model confidence, tags, EXIF and standard object size cannot approve scale. */
export function reviewPhotoEvidence(input: { assets: unknown; workspaceId: string; projectId: string;
  observations: unknown; references: readonly PhotoDimensionReference[]; decisions: readonly PhotoReviewDecision[] }): PhotoEvidenceReview {
  const assets = validatePhotoAssets(input.assets, input);
  const assetMap = new Map(assets.map(asset => [asset.id, asset]));
  const parsedObservations = normalizeObservations(input.observations, assetMap);
  if (!Array.isArray(input.references) || input.references.length > PHOTO_ASSET_LIMITS.maximumObservations
    || !Array.isArray(input.decisions) || input.decisions.length > PHOTO_ASSET_LIMITS.maximumObservations) fail('invalid_photo_review_inputs');
  const references = new Map<string, PhotoDimensionReference>();
  for (const reference of input.references as readonly PhotoDimensionReference[]) {
    if (!record(reference) || !identifier(reference.id) || references.has(reference.id) || !validRegion(reference.region, assetMap)
      || !identifier(reference.objectIdentityKey) || !identifier(reference.reviewerId) || !decimal(reference.value) || reference.value <= 0
      || (reference.unit !== 'M' && !isCanonicalUnit(reference.unit))
      || typeof reference.verified !== 'boolean' || typeof reference.coplanarVerified !== 'boolean' || typeof reference.perspectiveVerified !== 'boolean'
      || !['instrument_reading', 'planar_calibration'].includes(reference.kind)) fail('invalid_photo_dimension_reference');
    references.set(reference.id, reference);
  }
  // Uncalibrated photographs cannot imply physical lengths, areas or volumes.
  // A local supplied reference can support an explicitly unverified proposal;
  // approval still requires the separate trusted decision below.
  const observations = parsedObservations.map(observation => {
    if (observation.proposedQuantity === null) return observation;
    const reference = observation.referenceId ? references.get(observation.referenceId) : undefined;
    const localReference = reference && observation.regions.some(region => region.sourceAssetId === reference.region.sourceAssetId
      && region.surfaceKey === reference.region.surfaceKey);
    const instrumentProposal = localReference && reference.kind === 'instrument_reading' && observation.method === 'instrument_measurement'
      && reference.unit === observation.proposedUnit && reference.value === observation.proposedQuantity;
    if ((observation.proposedUnit === 'EA' && observation.method === 'visible_count' && Number.isSafeInteger(observation.proposedQuantity))
      || instrumentProposal) return observation;
    return { ...observation, proposedQuantity: null, uncertainty: [...new Set([...observation.uncertainty,
      observation.method === 'calibrated_planar_geometry' ? 'deterministic_photo_calibration_required' : 'physical_dimension_reference_required'])] };
  });
  const decisions = new Map<string, PhotoReviewDecision>();
  for (const decision of input.decisions as readonly PhotoReviewDecision[]) {
    if (!record(decision) || !identifier(decision.observationId) || decisions.has(decision.observationId) || !observations.some(item => item.id === decision.observationId)
      || !identifier(decision.reviewerId) || !['approved', 'rejected'].includes(decision.disposition)) fail('invalid_photo_review_decision');
    decisions.set(decision.observationId, decision);
  }
  const blockers: string[] = [];
  const groups = new Map<string, Array<{ observation: PhotoObservation; decision: PhotoReviewDecision; reference: PhotoDimensionReference | undefined }>>();
  for (const observation of observations) {
    const decision = decisions.get(observation.id);
    if (decision?.disposition === 'rejected') continue;
    if (!decision || !decimal(decision.quantity) || typeof decision.unit !== 'string' || !isCanonicalUnit(decision.unit)
      || !identifier(decision.objectIdentityKey) || !boundedText(decision.calculationMethod)
      || !METHODS.has(decision.method) || decision.method === 'visual_estimate' || decision.uncertaintyResolved !== true
      || !Array.isArray(decision.identityAssetIds) || decision.identityAssetIds.some(id => !assetMap.has(id))) {
      blockers.push(`${observation.id}:human_measurement_review_required`); continue;
    }
    const viewIds = new Set(observation.regions.map(region => region.sourceAssetId));
    if ([...viewIds].some(id => !decision.identityAssetIds.includes(id))) { blockers.push(`${observation.id}:object_identity_review_required`); continue; }
    const reference = decision.referenceId ? references.get(decision.referenceId) : undefined;
    // A reviewed length and two booleans do not define a homography, source
    // polygon or deterministic physical calculation. Keep this mode pending
    // until those inputs are represented and verified by RoughBid itself.
    if (decision.method === 'calibrated_planar_geometry') {
      blockers.push(`${observation.id}:deterministic_photo_calibration_required`); continue;
    }
    if (decision.method === 'visible_count') {
      if (decision.unit !== 'EA' || !Number.isSafeInteger(decision.quantity)) { blockers.push(`${observation.id}:invalid_reviewed_count`); continue; }
    } else {
      const sameSurface = reference && observation.regions.some(region => region.sourceAssetId === reference.region.sourceAssetId && region.surfaceKey === reference.region.surfaceKey);
      if (reference?.verified !== true || reference.objectIdentityKey !== decision.objectIdentityKey || !sameSurface
        || (decision.method === 'instrument_measurement' && (reference.kind !== 'instrument_reading' || reference.unit !== decision.unit || reference.value !== decision.quantity))) {
        blockers.push(`${observation.id}:verified_local_dimension_reference_required`); continue;
      }
    }
    // SF and SY views of one surface are not separate physical quantities.
    // Conflicting units are reconciled explicitly rather than silently added.
    const key = `${decision.objectIdentityKey}:${UNIT_REGISTRY[decision.unit].dimension}`;
    const group = groups.get(key) ?? [];
    group.push({ observation, decision, reference }); groups.set(key, group);
  }
  const approvedMeasurements: PhotoApprovedMeasurement[] = [];
  for (const [key, group] of groups) {
    const primary = group[0]!;
    const regions = group.flatMap(item => item.observation.regions);
    const assetIds = [...new Set(regions.map(region => region.sourceAssetId))];
    if (assetIds.length > 1 && group.some(item => item.decision.crossViewIdentityReviewed !== true || assetIds.some(id => !item.decision.identityAssetIds.includes(id)))) {
      blockers.push(`${primary.decision.objectIdentityKey}:cross_view_identity_review_required`); continue;
    }
    if (group.some(item => item.decision.quantity !== primary.decision.quantity || item.decision.unit !== primary.decision.unit || item.decision.method !== primary.decision.method)) {
      blockers.push(`${primary.decision.objectIdentityKey}:conflicting_photo_measurements`); continue;
    }
    approvedMeasurements.push({ id: key, objectIdentityKey: primary.decision.objectIdentityKey,
      quantity: primary.decision.quantity!, unit: primary.decision.unit!, method: primary.decision.method as PhotoApprovedMeasurement['method'],
      calculationMethod: primary.decision.calculationMethod, sourceRegions: regions.map(cleanRegion),
      sourceRevisions: Object.fromEntries(assetIds.map(id => [id, assetMap.get(id)!.revision])),
      referenceIds: [...new Set(group.flatMap(item => item.reference ? [item.reference.id] : []))],
      reviewerIds: [...new Set(group.map(item => item.decision.reviewerId))] });
  }
  if (!observations.length || !approvedMeasurements.length) blockers.push('no_approved_photo_measurements');
  return { assets, observations, approvedMeasurements, blockers: [...new Set(blockers)], humanReviewRequired: true,
    releaseStatus: blockers.length ? 'blocked' : 'measurement_review_ready', pricingStatus: 'missing_price', estimate: null };
}

/**
 * Reuses the deterministic price/evidence guard. Ordered photo views occupy
 * internal coverage slots only; these numbers never assert PDF physical pages.
 * No photo observation reaches this join without a separate human decision.
 */
export function buildPhotoEvidenceBudget(review: PhotoEvidenceReview, input: Omit<EvidenceBudgetInput, 'measurements' | 'coverage' | 'physicalPageCount' | 'unresolvedConflicts'>
  & { reviewedAssetIds: readonly string[] }): EvidenceBudgetResult {
  if (review.blockers.length) return { releaseStatus: 'blocked', humanReviewRequired: true, estimate: null,
    blockers: [...review.blockers], provenance: [] };
  const slots = new Map(review.assets.map((asset, index) => [asset.id, index + 1]));
  const measurements: BudgetMeasurement[] = review.approvedMeasurements.map(item => {
    const primary = item.sourceRegions[0]!;
    return { id: item.id, physicalPageNumber: slots.get(primary.sourceAssetId)!, sourceRef: `photo:${primary.sourceAssetId}:${item.id}`,
      revision: item.sourceRevisions[primary.sourceAssetId]!, quantity: item.quantity, unit: item.unit,
      reviewed: true, scaleVerified: item.method === 'visible_count' || item.referenceIds.length > 0 };
  });
  return buildEvidenceBudget({ ...input, measurements, physicalPageCount: review.assets.length, unresolvedConflicts: [],
    coverage: review.assets.map((asset, index) => ({ physicalPageNumber: index + 1,
      reviewed: input.reviewedAssetIds.includes(asset.id), revision: asset.revision })) });
}
