import type { GeometryCandidate, GeometryReviewInput } from '../services/geometry-api.ts';
export type GeometryReviewDraft = { identityReviewed: boolean; geometryReviewed: boolean; duplicateReviewComplete: boolean; reviewNote: string };
export const emptyGeometryReview = (): GeometryReviewDraft => ({ identityReviewed: false, geometryReviewed: false, duplicateReviewComplete: false, reviewNote: '' });
export function geometryQuantityLabel(candidate: Pick<GeometryCandidate, 'quantity' | 'unit'>): string {
  if (candidate.quantity === null || !Number.isFinite(candidate.quantity)) return 'Measurement undetermined';
  return `${candidate.quantity.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${candidate.unit === 'm2' ? 'm²' : candidate.unit}`;
}
export function buildGeometryReview(candidate: GeometryCandidate, draft: GeometryReviewDraft, decision: 'accepted' | 'rejected', requestKey: string,
  fileSha256: string, pageNumber: number): GeometryReviewInput {
  if (candidate.fileSha256 !== fileSha256 || candidate.physicalPageNumber !== pageNumber) throw new Error('This proposal belongs to a different source revision or unassigned page. Reload its evidence.');
  if (!Number.isSafeInteger(candidate.reviewRevision) || candidate.reviewRevision < 0 || !draft.reviewNote.trim() || draft.reviewNote.length > 1200) throw new Error('Add a review note and reload the saved proposal before writing.');
  if (!draft.identityReviewed || !draft.geometryReviewed || !draft.duplicateReviewComplete) throw new Error('Review the source geometry, physical element and overlapping or duplicate views.');
  if (decision === 'accepted' && (candidate.status !== 'candidate' || candidate.quantity === null || !Number.isFinite(candidate.quantity) || candidate.quantity < 0)) throw new Error('This proposal needs measurement evidence before it can be accepted.');
  return { candidateId: candidate.id, decision, expectedRevision: candidate.reviewRevision, requestKey,
    identityReviewed: true, geometryReviewed: true, duplicateReviewComplete: true, reviewNote: draft.reviewNote.trim() };
}
/** Fit provider geometry for inspection only; never map it to PDF or compute a physical quantity. */
export function geometryPreviewPaths(geometry: Record<string, unknown> | null): { paths: number[][][]; viewBox: string } | null {
  if (!geometry || typeof geometry.type !== 'string' || !Array.isArray(geometry.coordinates)) return null;
  let paths: unknown[];
  if (geometry.type === 'LineString') paths = [geometry.coordinates];
  else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') paths = geometry.coordinates;
  else if (geometry.type === 'MultiPolygon') paths = geometry.coordinates.flatMap(value => Array.isArray(value) ? value : []);
  else return null;
  const found: number[][][] = [], coordinates: number[][] = [];
  for (const path of paths) {
    if (!Array.isArray(path) || !path.length || path.some(point => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return null;
    const points = path.map(point => [point[0], point[1]] as number[]); found.push(points); coordinates.push(...points);
    if (coordinates.length > 2_000) return null;
  }
  if (!coordinates.length) return null;
  const x = coordinates.map(point => point[0]!), y = coordinates.map(point => point[1]!);
  const left = Math.min(...x), top = Math.min(...y), width = Math.max(...x) - left, height = Math.max(...y) - top;
  const padding = Math.max(width, height, 1) * 0.06;
  return { paths: found, viewBox: `${left - padding} ${top - padding} ${width + padding * 2} ${height + padding * 2}` };
}
