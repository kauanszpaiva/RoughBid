import { isCanonicalUnit, type CanonicalUnit } from '../../../../../packages/domain/src/takeoff-v2.ts';
import type { PhotoObservation, PhotoReferenceInput, PhotoReviewInput, PhotoRunDetail, PhotoSourceAsset } from '../services/photos-api.ts';

export const PHOTO_UPLOAD_LIMITS = Object.freeze({ maximumAssets: 8, maximumAssetBytes: 20 * 1024 * 1024, maximumBatchBytes: 40 * 1024 * 1024 });
export function validatePhotoSelection(files: ReadonlyArray<Pick<File, 'name' | 'type' | 'size'>>): string | null {
  if (!files.length || files.length > PHOTO_UPLOAD_LIMITS.maximumAssets) return 'Select one to eight photos.';
  if (files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) return 'Use JPEG, PNG or WebP photos. PDF and animated image formats use a different workflow.';
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 1 || file.size > PHOTO_UPLOAD_LIMITS.maximumAssetBytes)) return 'Each photo must be between 1 byte and 20 MB.';
  if (files.reduce((total, file) => total + file.size, 0) > PHOTO_UPLOAD_LIMITS.maximumBatchBytes) return 'The complete photo batch must be no larger than 40 MB.';
  return null;
}
export const isPhotoRunInFlight = (status: string) => status === 'queued' || status === 'processing' || status === 'waiting_budget';
export function photoReadingSteps(detail: PhotoRunDetail) {
  return ([['observation', 'Identify visible work'], ['reconciliation', 'Compare the photos'], ['risk_review', 'Check missing details']] as const).map(([stage, label]) => {
    const records = detail.stageCheckpoints?.filter(value => value.stage === stage) ?? [];
    const covered = new Set(records.flatMap(value => value.asset_ids));
    const complete = records.length > 0 ? records.every(value => value.status === 'completed') && detail.assets.length > 0 && detail.assets.every(asset => covered.has(asset.id))
      : detail.run.result?.stageStatus?.[stage] === 'completed';
    return { stage, label, status: complete ? 'Completed' : records.some(value => value.status === 'processing' || value.status === 'admitted') ? 'In progress' : 'Pending' };
  });
}
export function photoCapacityWait(detail: Pick<PhotoRunDetail, 'run'>) {
  if (detail.run.status !== 'waiting_budget') return null;
  const resume = detail.run.not_before ? new Date(detail.run.not_before) : null;
  return { message: 'Waiting for processing capacity. Reading will resume automatically with saved progress and no extra charge.',
    estimate: resume && Number.isFinite(resume.valueOf()) ? resume.toLocaleString() : null };
}
export function canResumePhotoRun(detail: PhotoRunDetail): boolean {
  return ['queued', 'blocked', 'cancelled'].includes(detail.run.status)
    && !detail.run.reconciliation_required && !['unknown_provider_outcome', 'processing_review_required'].includes(detail.run.error_code ?? '')
    && !detail.steps.some(step => step.status === 'processing');
}
export function photoCheckpointProgress(detail: Pick<PhotoRunDetail, 'run'>): string {
  const progress = detail.run.progress;
  return progress && Number.isSafeInteger(progress.completed) && progress.completed >= 0
    && Number.isSafeInteger(progress.total) && progress.total > 0 && progress.completed <= progress.total
    ? `${progress.completed}/${progress.total} photo checkpoints saved` : 'Saved progress is not available yet';
}
export type PhotoPlanarDraft = {
  sourceAssetId: string; sourceRevision: string; sourceSha256: string; surfaceKey: string;
  referencePoints: Array<[number, number]>; referenceWidth: string; referenceHeight: string; referenceUnit: 'M' | 'LF';
  rectangleVerified: boolean; lensDistortionReviewed: boolean;
  measurementPoints: Array<[number, number]>; measure: 'area' | 'perimeter' | 'length'; samePlaneReviewed: boolean; geometryReviewed: boolean;
};
export type PhotoReviewDraft = {
  disposition: 'unreviewed' | 'approved' | 'rejected'; quantity: string; unit: string;
  method: 'visible_count' | 'instrument_measurement' | 'calibrated_planar_geometry'; objectIdentity: string; calculationMethod: string;
  verifiedReading: boolean; uncertaintyResolved: boolean; crossViewIdentityReviewed: boolean;
  planar?: PhotoPlanarDraft;
};
export function photoPhysicalIdentity(observationId: string): string {
  let first = 2166136261, second = 5381;
  for (const char of observationId) { first = Math.imul(first ^ char.charCodeAt(0), 16777619); second = Math.imul(second, 33) ^ char.charCodeAt(0); }
  return `object:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}:${observationId.length}`;
}
export function emptyPhotoPlanarDraft(observation: PhotoObservation, assets: readonly PhotoSourceAsset[], regionIndex = 0): PhotoPlanarDraft {
  const region = observation.regions[regionIndex], asset = assets.find(item => item.id === region?.sourceAssetId);
  return { sourceAssetId: region?.sourceAssetId ?? '', sourceRevision: asset?.revision ?? '', sourceSha256: asset?.sha256 ?? '', surfaceKey: region?.surfaceKey ?? '',
    referencePoints: [], referenceWidth: '', referenceHeight: '', referenceUnit: 'M', rectangleVerified: false, lensDistortionReviewed: false,
    measurementPoints: [], measure: 'area', samePlaneReviewed: false, geometryReviewed: false };
}
export function restorePhotoReviewDraft(observation: PhotoObservation, decision: PhotoReviewInput, references: readonly PhotoReferenceInput[]): PhotoReviewDraft {
  const calibration = references.find(item => item.id === decision.referenceId)?.planarCalibration, measurement = decision.planarMeasurement;
  return { ...emptyPhotoReviewDraft(observation), disposition: decision.disposition, quantity: decision.quantity === null ? '' : String(decision.quantity), unit: decision.unit ?? '',
    method: decision.method === 'visible_count' ? 'visible_count' : decision.method === 'calibrated_planar_geometry' ? 'calibrated_planar_geometry' : 'instrument_measurement',
    objectIdentity: decision.objectIdentityKey, calculationMethod: decision.calculationMethod, verifiedReading: decision.method === 'instrument_measurement',
    uncertaintyResolved: decision.uncertaintyResolved, crossViewIdentityReviewed: decision.crossViewIdentityReviewed,
    ...(calibration && measurement ? { planar: { sourceAssetId: calibration.sourceAssetId, sourceRevision: calibration.sourceRevision, sourceSha256: calibration.sourceSha256,
      surfaceKey: calibration.surfaceKey, referencePoints: calibration.referencePoints.map(point => [point[0], point[1]]), referenceWidth: String(calibration.referenceWidth),
      referenceHeight: String(calibration.referenceHeight), referenceUnit: calibration.referenceUnit, rectangleVerified: calibration.rectangleVerified, lensDistortionReviewed: calibration.lensDistortionReviewed,
      measurementPoints: measurement.points.map(point => [point[0], point[1]]), measure: measurement.measure, samePlaneReviewed: measurement.samePlaneReviewed, geometryReviewed: measurement.geometryReviewed } } : {}) };
}
export function emptyPhotoReviewDraft(observation: PhotoObservation): PhotoReviewDraft {
  return { disposition: 'unreviewed', quantity: '', unit: observation.method === 'visible_count' ? 'EA' : '',
    method: observation.method === 'visible_count' ? 'visible_count' : 'instrument_measurement', objectIdentity: photoPhysicalIdentity(observation.id), calculationMethod: '',
    verifiedReading: false, uncertaintyResolved: false, crossViewIdentityReviewed: false };
}

/** Approvals require a separately entered reading/count. Proposed model values never prefill approval. */
export function buildPhotoHumanReview(observations: readonly PhotoObservation[], drafts: Record<string, PhotoReviewDraft>, referenceId: () => string, assets: readonly PhotoSourceAsset[] = []) {
  const decisions: PhotoReviewInput[] = [], references: PhotoReferenceInput[] = [];
  const identityAssets = new Map<string, Set<string>>();
  for (const observation of observations) {
    const draft = drafts[observation.id];
    if (draft?.disposition !== 'approved') continue;
    const key = `${draft.objectIdentity}:${draft.unit}`;
    const ids = identityAssets.get(key) ?? new Set<string>();
    for (const region of observation.regions) ids.add(region.sourceAssetId);
    identityAssets.set(key, ids);
  }
  for (const observation of observations) {
    const draft = drafts[observation.id];
    if (!draft || draft.disposition === 'unreviewed') continue;
    const assetIds = [...new Set(observation.regions.map(region => region.sourceAssetId))];
    if (draft.disposition === 'rejected') {
      decisions.push({ observationId: observation.id, disposition: 'rejected', quantity: null, unit: null, method: draft.method,
        calculationMethod: 'Rejected after human review.', referenceId: null, objectIdentityKey: '', identityAssetIds: assetIds,
        crossViewIdentityReviewed: false, uncertaintyResolved: false });
      continue;
    }
    if (draft.method !== 'calibrated_planar_geometry' && (!/^\d+(?:\.\d{1,6})?$/.test(draft.quantity) || !Number.isFinite(Number(draft.quantity))
      || Number(draft.quantity) > Number.MAX_SAFE_INTEGER || !isCanonicalUnit(draft.unit))) throw new Error(`${observation.label}: enter a reviewed quantity and supported unit.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(draft.objectIdentity)
      || !draft.calculationMethod.trim() || draft.calculationMethod.length > 500 || !draft.uncertaintyResolved) throw new Error(`${observation.label}: identify the physical object, explain the measurement and resolve uncertainty.`);
    const reviewedAssetIds = [...(identityAssets.get(`${draft.objectIdentity}:${draft.unit}`) ?? new Set(assetIds))];
    if (reviewedAssetIds.length > 1 && !draft.crossViewIdentityReviewed) throw new Error(`${observation.label}: verify that the photo views show the same physical object before combining evidence.`);
    const quantity = draft.method === 'calibrated_planar_geometry' ? null : Number(draft.quantity), unit = draft.unit as CanonicalUnit;
    let id: string | null = null;
    if (draft.method === 'calibrated_planar_geometry') {
      const planar = draft.planar, asset = assets.find(item => item.id === planar?.sourceAssetId);
      const region = observation.regions.find(item => item.sourceAssetId === planar?.sourceAssetId && item.surfaceKey === planar?.surfaceKey);
      if (!planar || !asset || !region || !asset.storageVerified || asset.revision !== planar.sourceRevision || asset.sha256 !== planar.sourceSha256) throw new Error(`${observation.label}: reload the verified photo revision and choose its source surface.`);
      if (!/^\d+(?:\.\d{1,6})?$/.test(planar.referenceWidth) || !/^\d+(?:\.\d{1,6})?$/.test(planar.referenceHeight)
        || Number(planar.referenceWidth) <= 0 || Number(planar.referenceHeight) <= 0 || !['M', 'LF'].includes(planar.referenceUnit)) throw new Error(`${observation.label}: enter both known reference dimensions in metres or feet.`);
      const validPoints = (values: Array<[number, number]>, minimum: number, maximum: number) => values.length >= minimum && values.length <= maximum && values.every(point => point.length === 2 && point.every(value => Number.isFinite(value) && value >= 0 && value <= 1));
      if (!validPoints(planar.referencePoints, 4, 4) || !validPoints(planar.measurementPoints, planar.measure === 'length' ? 2 : 3, 64)) throw new Error(`${observation.label}: mark four reference corners and trace the actual measured boundary.`);
      if (!planar.rectangleVerified || !planar.lensDistortionReviewed || !planar.samePlaneReviewed || !planar.geometryReviewed) throw new Error(`${observation.label}: verify the reference rectangle, lens distortion, shared plane and measured boundary.`);
      if (planar.measure === 'area' ? !['SF', 'SY', 'SQ'].includes(unit) : unit !== 'LF') throw new Error(`${observation.label}: use SF, SY or SQ for area and LF for perimeter or length.`);
      id = referenceId();
      const source = { sourceAssetId: asset.id, sourceRevision: asset.revision, sourceSha256: asset.sha256, surfaceKey: region.surfaceKey };
      references.push({ id, region, objectIdentityKey: draft.objectIdentity, verified: true, kind: 'planar_calibration', value: Number(planar.referenceWidth), unit: planar.referenceUnit,
        coplanarVerified: true, perspectiveVerified: true, planarCalibration: { version: 'photo-planar-v1', ...source,
          referencePoints: planar.referencePoints as [[number, number], [number, number], [number, number], [number, number]], referenceWidth: Number(planar.referenceWidth), referenceHeight: Number(planar.referenceHeight), referenceUnit: planar.referenceUnit, rectangleVerified: true, lensDistortionReviewed: true } });
      decisions.push({ observationId: observation.id, disposition: 'approved', quantity: null, unit, method: draft.method,
        calculationMethod: draft.calculationMethod.trim(), referenceId: id, objectIdentityKey: draft.objectIdentity, identityAssetIds: reviewedAssetIds,
        crossViewIdentityReviewed: draft.crossViewIdentityReviewed, uncertaintyResolved: true,
        planarMeasurement: { version: 'photo-planar-v1', ...source, kind: planar.measure === 'length' ? 'polyline' : 'polygon', points: planar.measurementPoints, measure: planar.measure, samePlaneReviewed: true, geometryReviewed: true } });
      continue;
    } else if (draft.method === 'visible_count') {
      if (unit !== 'EA' || !Number.isSafeInteger(quantity)) throw new Error(`${observation.label}: visible counts must be whole EA units.`);
    } else {
      if (!draft.verifiedReading || quantity === null || quantity <= 0 || !observation.regions[0]) throw new Error(`${observation.label}: confirm a positive instrument reading on the identified surface.`);
      id = referenceId();
      references.push({ id, region: observation.regions[0], objectIdentityKey: draft.objectIdentity, verified: true,
        kind: 'instrument_reading', value: quantity, unit, coplanarVerified: false, perspectiveVerified: false });
    }
    decisions.push({ observationId: observation.id, disposition: 'approved', quantity, unit, method: draft.method,
      calculationMethod: draft.calculationMethod.trim(), referenceId: id, objectIdentityKey: draft.objectIdentity,
      identityAssetIds: reviewedAssetIds, crossViewIdentityReviewed: draft.crossViewIdentityReviewed, uncertaintyResolved: true });
  }
  if (!decisions.length) throw new Error('Choose at least one reviewed approval or rejection.');
  return { references, decisions };
}
