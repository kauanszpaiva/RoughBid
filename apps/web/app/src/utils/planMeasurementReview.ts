import type { MeasurementGeometry, MeasurementReviewInput, PlanMeasurementContext, PlanMeasurementRow, ReviewedScaleReference } from '../services/planmeasurements-api.ts';
export type PlanPoint = [number, number];
export type ScaleReferenceDraft = {
  sourceId: string; sourceType: ReviewedScaleReference['sourceType']; sourceExcerpt: string; drawingLength: string;
  unit: ReviewedScaleReference['unit']; referenceLine: PlanPoint[]; independenceVerified: boolean;
};
export type PlanMeasurementDraft = {
  measurementId: string; expectedRevision: number; label: string; regionKey: string; regionBounds: [number, number, number, number] | null;
  canonicalElementKey: string; canonicalTrade: string; geometryType: MeasurementGeometry['type']; points: PlanPoint[];
  sourceKind: MeasurementReviewInput['sourceKind']; sourceCandidateId: string | null; sourceExcerpt: string;
  decision: MeasurementReviewInput['decision']; geometryReviewed: boolean; identityReviewed: boolean; duplicateReviewComplete: boolean;
  uncertainty: string; references: ScaleReferenceDraft[];
  boundaryMethod: 'human_trace' | 'verified_rectangular_surface'; boundaryReviewed: boolean; boundaryExcerpt: string;
};
export function emptyPlanMeasurementDraft(id: string): PlanMeasurementDraft {
  return { measurementId: id, expectedRevision: 0, label: '', regionKey: '', regionBounds: null, canonicalElementKey: '', canonicalTrade: '',
    geometryType: 'line', points: [], sourceKind: 'manual_trace', sourceCandidateId: null, sourceExcerpt: '', decision: 'candidate',
    geometryReviewed: false, identityReviewed: false, duplicateReviewComplete: false, uncertainty: '',
    boundaryMethod: 'human_trace', boundaryReviewed: false, boundaryExcerpt: '',
    references: [0, 1].map(() => ({ sourceId: '', sourceType: 'explicit_dimension', sourceExcerpt: '', drawingLength: '', unit: 'ft', referenceLine: [], independenceVerified: false })) };
}
export function planPointFromPointer(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }): PlanPoint | null {
  if (![clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return null;
  const x = (clientX - bounds.left) / bounds.width, y = (clientY - bounds.top) / bounds.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [Number(x.toFixed(6)), Number(y.toFixed(6))];
}
export function planRegionFromPoints(a: PlanPoint, b: PlanPoint): [number, number, number, number] | null {
  const width = Math.abs(a[0] - b[0]), height = Math.abs(a[1] - b[1]);
  return width > 0 && height > 0 ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), width, height] : null;
}
export function pointInsidePlanRegion(point: PlanPoint, region: [number, number, number, number]): boolean {
  return point[0] >= region[0] && point[1] >= region[1] && point[0] <= region[0] + region[2] + 1e-9 && point[1] <= region[1] + region[3] + 1e-9;
}
export function isUsablePlanRegion(region: readonly number[]): boolean {
  return region.length === 4 && region.every(Number.isFinite) && region[0]! >= 0 && region[1]! >= 0 && region[2]! > 0 && region[3]! > 0
    && region[0]! + region[2]! <= 1 + 1e-9 && region[1]! + region[3]! <= 1 + 1e-9;
}
export function planReferencePdfLength(points: readonly PlanPoint[], context: PlanMeasurementContext): number | null {
  if (points.length !== 2) return null;
  const distance = Math.hypot((points[1]![0] - points[0]![0]) * context.sheet.displayWidthPoints, (points[1]![1] - points[0]![1]) * context.sheet.displayHeightPoints);
  return distance > 0 && Number.isFinite(distance) ? distance : null;
}
export function planViewportMatches(width: number, height: number, context: PlanMeasurementContext): boolean {
  return width > 0 && height > 0 && Math.abs(width - context.sheet.displayWidthPoints) <= 0.01 && Math.abs(height - context.sheet.displayHeightPoints) <= 0.01;
}
export function draftFromSavedPlanMeasurement(row: PlanMeasurementRow): PlanMeasurementDraft {
  const draft = emptyPlanMeasurementDraft(row.id);
  return { ...draft, expectedRevision: row.review_revision, label: row.label, regionKey: row.region_key, regionBounds: row.region_bounds,
    canonicalElementKey: row.canonical_element_key, canonicalTrade: row.canonical_trade, geometryType: row.geometry.type,
    points: row.geometry.points, sourceKind: row.source_kind, sourceCandidateId: row.source_candidate_id, sourceExcerpt: row.proof.sourceExcerpt,
    decision: row.review_status, geometryReviewed: row.proof.geometryReviewed, identityReviewed: row.proof.identityReviewed,
    boundaryMethod: row.proof.boundaryEvidence?.method ?? 'human_trace', boundaryReviewed: row.proof.boundaryEvidence?.reviewed === true,
    boundaryExcerpt: row.proof.boundaryEvidence?.sourceExcerpt ?? '',
    duplicateReviewComplete: row.proof.duplicateReviewComplete, uncertainty: row.uncertainty.join('\n'),
    references: row.proof.calibrationEvidence.length ? row.proof.calibrationEvidence.map(reference => ({ ...reference, drawingLength: String(reference.drawingLength) })) : draft.references };
}

/** Draft coordinates are evidence requests; the server computes every accepted quantity. */
export function buildPlanMeasurementInput(draft: PlanMeasurementDraft, context: PlanMeasurementContext): MeasurementReviewInput {
  if (!draft.regionBounds || !isUsablePlanRegion(draft.regionBounds)) throw new Error('Select a reviewed drawing region with width and height first.');
  if (!draft.label.trim() || !draft.sourceExcerpt.trim() || !draft.regionKey.trim() || !draft.canonicalTrade.trim() || !draft.canonicalElementKey.trim()) throw new Error('Identify the region, trade, physical element and source evidence.');
  const minimum = draft.geometryType === 'polygon' ? 3 : ['point', 'count'].includes(draft.geometryType) ? 1 : 2;
  if (draft.points.length < minimum || draft.points.length > 128 || draft.points.some(point => !pointInsidePlanRegion(point, draft.regionBounds!))) throw new Error('Trace the actual element inside its reviewed region.');
  if (['line', 'rectangle'].includes(draft.geometryType) && draft.points.length !== 2 || ['point', 'count'].includes(draft.geometryType) && draft.points.length !== 1) throw new Error('This geometry has an invalid number of trace points.');
  const count = draft.geometryType === 'point' || draft.geometryType === 'count';
  const references: ReviewedScaleReference[] = [];
  if (!count) for (const reference of draft.references) {
    if (!reference.sourceId && !reference.sourceExcerpt && !reference.drawingLength && !reference.referenceLine.length) continue;
    const pdfPoints = planReferencePdfLength(reference.referenceLine, context);
    if (!reference.sourceId.trim() || !reference.sourceExcerpt.trim() || !/^\d+(?:\.\d{1,6})?$/.test(reference.drawingLength)
      || Number(reference.drawingLength) <= 0 || !pdfPoints || !reference.independenceVerified) throw new Error('Each scale reference needs its own identity, visible physical dimension, traced line and confirmed independence.');
    references.push({ sourceId: reference.sourceId.trim(), sourceType: reference.sourceType, sourceExcerpt: reference.sourceExcerpt.trim(),
      unit: reference.unit, drawingLength: Number(reference.drawingLength), pdfPoints,
      referenceLine: reference.referenceLine as [[number, number], [number, number]], independenceVerified: true });
  }
  const uncertainty = draft.uncertainty.split('\n').map(value => value.trim()).filter(Boolean);
  if (draft.decision === 'accepted' && (!draft.geometryReviewed || !draft.identityReviewed || !draft.duplicateReviewComplete || uncertainty.length || !count && references.length < 2)) {
    throw new Error('Acceptance requires reviewed geometry, physical identity, duplicate checks, resolved uncertainty and two independent scale references for lengths/areas.');
  }
  if (draft.decision === 'accepted' && !count && (!draft.boundaryReviewed || !draft.boundaryExcerpt.trim())) throw new Error('Explain and confirm the actual measured boundary; a detected bounding box is not a measured surface.');
  if (!count && draft.boundaryReviewed && draft.boundaryMethod === 'verified_rectangular_surface' && draft.geometryType !== 'rectangle') throw new Error('Rectangular-surface verification requires a rectangular trace.');
  return { measurementId: draft.measurementId, expectedRevision: draft.expectedRevision, fileSha256: context.fileSha256,
    pageSha256: context.sheet.pageSha256, physicalPageNumber: context.sheet.physicalPageNumber,
    regionKey: draft.regionKey.trim(), regionBounds: draft.regionBounds, canonicalElementKey: draft.canonicalElementKey.trim(),
    canonicalTrade: draft.canonicalTrade.trim(), label: draft.label.trim(), geometry: { type: draft.geometryType, points: draft.points } as MeasurementGeometry,
    sourceKind: count && draft.sourceKind === 'manual_trace' ? 'manual_observed_count' : draft.sourceKind,
    ...(draft.sourceKind === 'native_vector_candidate' && draft.sourceCandidateId ? { sourceCandidateId: draft.sourceCandidateId } : {}),
    sourceExcerpt: draft.sourceExcerpt.trim(), decision: draft.decision, geometryReviewed: draft.geometryReviewed,
    identityReviewed: draft.identityReviewed, duplicateReviewComplete: draft.duplicateReviewComplete, uncertainty, calibrationEvidence: references,
    ...(!count && draft.boundaryReviewed && draft.boundaryExcerpt.trim() ? { boundaryEvidence: { method: draft.boundaryMethod, reviewed: true as const, sourceExcerpt: draft.boundaryExcerpt.trim() } } : {}) };
}
