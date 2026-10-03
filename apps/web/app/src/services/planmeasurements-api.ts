import { request } from './api';
import type { MeasurementGeometry } from '../../../../api/src/takeoff-v2/types.ts';
import type { MeasurementReviewInput, ReviewedScaleReference } from '../../../../api/src/takeoff-v2/measurement-review.ts';
export type { MeasurementGeometry, MeasurementReviewInput, ReviewedScaleReference };
export type PlanMeasurementContext = {
  projectId?: string;
  fileId: string; fileSha256: string; physicalPageCount: number | null;
  sheet: { physicalPageNumber: number; pageSha256: string; pageWidthPoints: number; pageHeightPoints: number;
    rotationDegrees: number; displayWidthPoints: number; displayHeightPoints: number };
};
export type PlanMeasurementRow = {
  id: string; physical_page_number: number; page_sha256: string; file_sha256: string;
  region_key: string; region_bounds: [number, number, number, number]; canonical_element_key: string; canonical_trade: string; label: string;
  geometry: MeasurementGeometry; source_kind: MeasurementReviewInput['sourceKind']; source_candidate_id: string | null;
  quantity: number | null; unit: 'LF' | 'SF' | 'EA' | null; calibration: { verificationStatus: string } | null;
  proof: { sourceExcerpt: string; geometryReviewed: boolean; identityReviewed: boolean; duplicateReviewComplete: boolean; calibrationEvidence: ReviewedScaleReference[];
    boundaryEvidence?: { method: 'human_trace' | 'verified_rectangular_surface'; reviewed: boolean; sourceExcerpt: string } };
  uncertainty: string[]; review_status: MeasurementReviewInput['decision']; review_revision: number; reviewed_by: string; reviewed_at: string;
};
export type PlanMeasurementPage = PlanMeasurementContext & { runId: string; measurements: PlanMeasurementRow[]; offset: number; nextOffset: number | null;
  humanReviewRequired: true; scopeCoverage: 'selected_elements_only'; pricingStatus: string };
export type NativePlanCandidate = { id: string; kind: 'native_outline' | 'enclosed_space_candidate' | 'opening_candidate'; bbox: [number, number, number, number];
  status: 'candidate'; quantity: null; unit: null; physicalPageNumber: number; pageSha256: string; source: 'native_pdf_vector' };
export type NativePlanCandidates = PlanMeasurementContext & { candidates: NativePlanCandidate[]; truncated: boolean; limitations: string[] };
const base = (runId: string) => `/api/takeoff-runs/${encodeURIComponent(runId)}/measurements`;
export const getPlanMeasurements = (workspaceId: string, runId: string, pageNumber: number, offset = 0) =>
  request<PlanMeasurementPage>(`${base(runId)}?page_number=${pageNumber}&offset=${offset}`, { workspaceId });
export const getNativePlanCandidates = (workspaceId: string, runId: string, pageNumber: number) =>
  request<NativePlanCandidates>(`${base(runId)}?page_number=${pageNumber}&native_candidates=true`, { workspaceId });
export const getSavedPlanMeasurement = (workspaceId: string, runId: string, pageNumber: number, measurementId: string) =>
  request<PlanMeasurementPage>(`${base(runId)}?page_number=${pageNumber}&measurement_id=${encodeURIComponent(measurementId)}`, { workspaceId });
export const savePlanMeasurement = (workspaceId: string, runId: string, input: MeasurementReviewInput) =>
  request<{ measurement: PlanMeasurementRow; humanReviewRequired: true; pricingStatus: string }>(base(runId), { method: 'POST', workspaceId, body: input });
