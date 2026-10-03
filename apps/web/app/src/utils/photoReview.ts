import { isCanonicalUnit, type CanonicalUnit } from '../../../../../packages/domain/src/takeoff-v2.ts';
import type { PhotoObservation, PhotoReferenceInput, PhotoReviewInput, PhotoRunDetail } from '../services/photos-api.ts';

export const PHOTO_UPLOAD_LIMITS = Object.freeze({ maximumAssets: 8, maximumAssetBytes: 20 * 1024 * 1024, maximumBatchBytes: 40 * 1024 * 1024 });
export function validatePhotoSelection(files: ReadonlyArray<Pick<File, 'name' | 'type' | 'size'>>): string | null {
  if (!files.length || files.length > PHOTO_UPLOAD_LIMITS.maximumAssets) return 'Select one to eight photos.';
  if (files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) return 'Use JPEG, PNG or WebP photos. PDF and animated image formats use a different workflow.';
  if (files.some(file => !Number.isSafeInteger(file.size) || file.size < 1 || file.size > PHOTO_UPLOAD_LIMITS.maximumAssetBytes)) return 'Each photo must be between 1 byte and 20 MB.';
  if (files.reduce((total, file) => total + file.size, 0) > PHOTO_UPLOAD_LIMITS.maximumBatchBytes) return 'The complete photo batch must be no larger than 40 MB.';
  return null;
}
export const isPhotoRunInFlight = (status: string) => status === 'queued' || status === 'processing';
export function canResumePhotoRun(detail: PhotoRunDetail): boolean {
  return ['queued', 'blocked', 'cancelled'].includes(detail.run.status)
    && !detail.run.reconciliation_required && detail.run.error_code !== 'unknown_provider_outcome'
    && !detail.steps.some(step => step.status === 'processing');
}
export function photoCheckpointProgress(detail: Pick<PhotoRunDetail, 'run'>): string {
  const progress = detail.run.progress;
  return progress && Number.isSafeInteger(progress.completed) && progress.completed >= 0
    && Number.isSafeInteger(progress.total) && progress.total > 0 && progress.completed <= progress.total
    ? `${progress.completed}/${progress.total} photo checkpoints saved` : 'Saved progress is not available yet';
}
export type PhotoReviewDraft = {
  disposition: 'unreviewed' | 'approved' | 'rejected'; quantity: string; unit: string;
  method: 'visible_count' | 'instrument_measurement'; objectIdentity: string; calculationMethod: string;
  verifiedReading: boolean; uncertaintyResolved: boolean; crossViewIdentityReviewed: boolean;
};
export function emptyPhotoReviewDraft(observation: PhotoObservation): PhotoReviewDraft {
  return { disposition: 'unreviewed', quantity: '', unit: observation.method === 'visible_count' ? 'EA' : '',
    method: observation.method === 'visible_count' ? 'visible_count' : 'instrument_measurement', objectIdentity: '', calculationMethod: '',
    verifiedReading: false, uncertaintyResolved: false, crossViewIdentityReviewed: false };
}

/** Approvals require a separately entered reading/count. Proposed model values never prefill approval. */
export function buildPhotoHumanReview(observations: readonly PhotoObservation[], drafts: Record<string, PhotoReviewDraft>, referenceId: () => string) {
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
    if (!/^\d+(?:\.\d{1,6})?$/.test(draft.quantity) || !Number.isFinite(Number(draft.quantity))
      || Number(draft.quantity) > Number.MAX_SAFE_INTEGER || !isCanonicalUnit(draft.unit)) throw new Error(`${observation.label}: enter a reviewed quantity and supported unit.`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(draft.objectIdentity)
      || !draft.calculationMethod.trim() || draft.calculationMethod.length > 500 || !draft.uncertaintyResolved) throw new Error(`${observation.label}: identify the physical object, explain the measurement and resolve uncertainty.`);
    const reviewedAssetIds = [...(identityAssets.get(`${draft.objectIdentity}:${draft.unit}`) ?? new Set(assetIds))];
    if (reviewedAssetIds.length > 1 && !draft.crossViewIdentityReviewed) throw new Error(`${observation.label}: verify that the photo views show the same physical object before combining evidence.`);
    const quantity = Number(draft.quantity), unit = draft.unit as CanonicalUnit;
    let id: string | null = null;
    if (draft.method === 'visible_count') {
      if (unit !== 'EA' || !Number.isSafeInteger(quantity)) throw new Error(`${observation.label}: visible counts must be whole EA units.`);
    } else {
      if (!draft.verifiedReading || quantity <= 0 || !observation.regions[0]) throw new Error(`${observation.label}: confirm a positive instrument reading on the identified surface.`);
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
