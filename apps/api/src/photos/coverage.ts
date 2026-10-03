import type { PhotoSourceAsset } from '../photo-evidence.ts';

const record = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(record) : [];

/** Checkpoint progress describes the supplied views, never unseen surfaces or a finished estimate. */
export function summarizePhotoCoverage(assets: readonly PhotoSourceAsset[], steps: readonly { photo_asset_id: string; status: string }[], result: unknown) {
  const saved = record(result) ? result : {};
  const processedAssetIds = assets.filter(asset => {
    const matches = steps.filter(step => step.photo_asset_id === asset.id);
    return matches.length === 1 && matches[0]!.status === 'completed';
  }).map(asset => asset.id);
  const pendingAssetIds = assets.filter(asset => !processedAssetIds.includes(asset.id)).map(asset => asset.id);
  const quality = rows(saved.photoQuality);
  const observations = rows(saved.observations);
  const decisions = rows(saved.decisions);
  const approved = rows(saved.approvedMeasurements);
  const references = rows(saved.references);
  const unresolved = observations.filter(observation => {
    const decision = decisions.find(item => item.observationId === observation.id);
    if (decision?.disposition === 'rejected') return false;
    if (Array.isArray(saved.blockers) && saved.blockers.some((blocker: unknown) => typeof blocker === 'string' && blocker.startsWith(`${observation.id}:`))) return true;
    return decision?.disposition !== 'approved' || !approved.some(item => item.objectIdentityKey === decision.objectIdentityKey
      && rows(item.sourceRegions).some(region => rows(observation.regions).some(source => source.sourceAssetId === region.sourceAssetId && source.surfaceKey === region.surfaceKey)));
  });
  return {
    version: 'photo-evidence-v1' as const, totalAssets: assets.length, processedAssetIds, pendingAssetIds,
    unassessedAssetIds: assets.filter(asset => quality.filter(item => item.sourceAssetId === asset.id).length !== 1).map(asset => asset.id),
    unusableAssetIds: assets.filter(asset => quality.some(item => item.sourceAssetId === asset.id && item.usable === false)).map(asset => asset.id),
    additionalViewAssetIds: assets.filter(asset => quality.some(item => item.sourceAssetId === asset.id && item.additionalViewsNeeded === true)).map(asset => asset.id),
    unresolvedObservationIds: unresolved.map(item => String(item.id)),
    referenceRequiredObservationIds: unresolved.filter(item => item.method !== 'visible_count' && !references.some(reference => reference.verified === true
      && typeof reference.value === 'number' && Number.isFinite(reference.value) && reference.value > 0 && record(reference.region)
      && rows(item.regions).some(region => region.sourceAssetId === reference.region.sourceAssetId && region.surfaceKey === reference.region.surfaceKey))).map(item => String(item.id)),
    processingComplete: assets.length > 0 && pendingAssetIds.length === 0,
    completeTakeoffVerified: false as const,
    estimateStatus: 'pending' as const,
  };
}

/** Re-derived from immutable source checkpoints; a quantity edit cannot remove source limitations. */
export function photoSourceBlockers(assets: readonly PhotoSourceAsset[], steps: readonly { photo_asset_id: string; status: string; result?: unknown }[]): string[] {
  const blockers: string[] = [];
  for (const asset of assets) {
    const matches = steps.filter(step => step.photo_asset_id === asset.id);
    const step = matches.length === 1 ? matches[0] : undefined;
    if (!step || step.status !== 'completed' || !record(step.result)) {
      blockers.push(`${asset.id}:photo_checkpoint_pending`); continue;
    }
    const quality = step.result.quality;
    if (!record(quality) || typeof quality.usable !== 'boolean' || typeof quality.additionalViewsNeeded !== 'boolean') blockers.push(`${asset.id}:photo_quality_review_required`);
    else {
      if (!quality.usable) blockers.push(`${asset.id}:photo_unusable_source`);
      if (quality.additionalViewsNeeded) blockers.push(`${asset.id}:additional_photo_views_required`);
    }
    if (Array.isArray(step.result.blockers)) for (const blocker of step.result.blockers) {
      if (typeof blocker === 'string' && blocker.trim() && blocker.length <= 160) blockers.push(`${asset.id}:${blocker}`);
    }
  }
  return [...new Set(blockers)];
}
