import type { CanonicalUnit } from '../../../../packages/domain/src/takeoff-v2.ts';

export type SheetCoverageStatus = 'reviewed' | 'non_takeoff_informational' | 'superseded' | 'duplicate' | 'unreadable' | 'blocked' | 'review_required';
export type DeepPassType = 'classification' | 'legends_schedules' | 'geometry' | 'discipline' | 'reconciliation' | 'conflict_detection' | 'completeness' | 'arithmetic_qa' | 'pricing_assemblies' | 'risk_review';

export interface PlanSheetManifestEntry {
  physicalPageNumber: number;
  pageSha256: string;
  widthPoints: number;
  heightPoints: number;
  orientation: 'portrait' | 'landscape' | 'square';
  rotationDegrees: 0 | 90 | 180 | 270;
  contentKind: 'vector' | 'raster' | 'mixed' | 'blank' | 'unknown';
  textQuality: 'good' | 'partial' | 'none' | 'unreadable' | 'unknown';
  status: SheetCoverageStatus;
  statusReason: string;
}

export interface PlanSetManifest {
  fileSha256: string;
  physicalPageCount: number;
  sheets: PlanSheetManifestEntry[];
}

export interface ScaleEvidence {
  sourceType: 'printed_scale' | 'graphic_scale' | 'explicit_dimension' | 'known_reference' | 'vector_coordinates';
  drawingUnits: number;
  pdfPoints: number;
  sourceExcerpt: string;
}

export interface ScaleCalibration {
  drawingUnitsPerPoint: number;
  confidence: number;
  verificationStatus: 'single_source' | 'verified' | 'conflicting' | 'blocked';
  evidence: ScaleEvidence[];
}

export type MeasurementGeometry =
  | { type: 'point' | 'count'; points: [[number, number]] }
  | { type: 'line'; points: [[number, number], [number, number]] }
  | { type: 'polyline' | 'polygon'; points: Array<[number, number]> }
  | { type: 'rectangle'; points: [[number, number], [number, number]] };

export interface MeasuredQuantity {
  quantity: number;
  unit: CanonicalUnit;
  formula: { version: 'geometry-v1'; operation: string; inputs: Record<string, unknown> };
}

export interface DeepPassRequest {
  runId: string;
  sheet: PlanSheetManifestEntry;
  passType: DeepPassType;
  attempt: number;
  idempotencyKey: string;
  reasoningEffort: 'high';
}

export interface DeepPassResult {
  status: 'succeeded' | 'blocked';
  checkpoint: Record<string, unknown>;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface DeepPassProvider { runPass(request: DeepPassRequest): Promise<DeepPassResult>; }
export interface DeepCheckpointRepository {
  begin(request: DeepPassRequest): Promise<'run' | 'already_succeeded' | 'already_blocked'>;
  succeed(request: DeepPassRequest, result: DeepPassResult): Promise<void>;
  fail(request: DeepPassRequest, failure: { classification: string; message: string }): Promise<void>;
}
