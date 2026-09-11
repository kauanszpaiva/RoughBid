export type PlanReadingFindingType =
  | 'measurement'
  | 'symbol'
  | 'room'
  | 'scope_note'
  | 'risk'
  | 'question'
  | 'material'
  | 'labor';

export const ALLOWED_FINDING_TYPES: ReadonlySet<PlanReadingFindingType> = new Set([
  'measurement', 'symbol', 'room', 'scope_note', 'risk', 'question', 'material', 'labor',
]);

/** The AI plan reader is asked to report quantities using only these short imperial unit codes. */
export const ALLOWED_UNITS: ReadonlySet<string> = new Set(['SF', 'LF', 'EA', 'CY', 'SY', 'HR', 'LS']);

/**
 * Visual object classes are deliberately coarse. They describe what the model
 * can actually point to on a sheet without pretending it has already produced
 * a construction-grade CAD model.
 */
export const ALLOWED_VISUAL_OBJECT_TYPES: ReadonlySet<string> = new Set([
  'room', 'wall', 'door', 'window', 'opening', 'closet', 'cabinet', 'counter',
  'stair', 'column', 'fixture', 'appliance', 'plumbing_fixture', 'electrical_fixture',
  'hvac_fixture', 'dimension', 'symbol', 'detail', 'section', 'elevation', 'other',
]);

export interface PlanReadingFinding {
  page_number: number | null;
  finding_type: PlanReadingFindingType;
  label: string;
  value_text: string | null;
  quantity: number | null;
  unit: string | null;
  confidence: number;
  geometry: Record<string, unknown>;
  source_excerpt: string | null;
}

export interface PlanProjectAddressEvidence {
  project_name: string | null;
  street_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  building_lot_unit: string | null;
  page_number: number;
  source_excerpt: string;
  confidence: number;
}

export interface PlanReadingSummary {
  sheet_count: number;
  detected_trade_scope: string[];
  scale_status: 'detected' | 'missing' | 'conflicting';
  human_review_required: true;
  /** Honesty-over-coverage disclosures: unreadable pages, ambiguous scale, dropped findings, fallback notices. */
  limitations: string[];
  /** EVIDENCE only. Pricing/address resolution code decides whether this address may drive market lookup. */
  project_address?: PlanProjectAddressEvidence;
  /** True when this result is the deterministic placeholder takeoff, not a real model reading — lets a multi-provider orchestrator know to try the next provider instead of trusting it. */
  synthetic?: boolean;
  pilot_usage?: { model: string; counted_input_tokens: number; reserved_cents: number; provider_usage?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } };
}

export interface PlanReadingResult {
  summary: PlanReadingSummary;
  findings: PlanReadingFinding[];
}

const MAX_FINDINGS = 400;

function isNormalizedPoint(raw: unknown): raw is [number, number] {
  return Array.isArray(raw)
    && raw.length === 2
    && raw.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

/**
 * Keep only bounded normalized PDF geometry. Provider pricing and arbitrary
 * model metadata are never persisted. Visual-only geometry is valid evidence
 * even when an object has no nearby printed label (for example a door swing).
 */
export function sanitizePlanGeometry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  const box = input.bbox;
  if (Array.isArray(box) && box.length === 4 && box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) {
    const [x, y, width, height] = box as number[];
    if (width! > 0 && height! > 0 && x! + width! <= 1 && y! + height! <= 1) output.bbox = box;
  }

  if (isNormalizedPoint(input.point)) output.point = input.point;

  if (Array.isArray(input.points) && input.points.length >= 2 && input.points.length <= 64 && input.points.every(isNormalizedPoint)) {
    output.points = input.points;
  }

  if (!output.bbox && !output.point && !output.points) return {};

  output.coordinate_space = 'normalized';
  if (input.evidence_kind === 'visual' || input.evidence_kind === 'text') output.evidence_kind = input.evidence_kind;
  if (typeof input.object_type === 'string' && ALLOWED_VISUAL_OBJECT_TYPES.has(input.object_type)) output.object_type = input.object_type;
  if (input.shape === 'bbox' || input.shape === 'point' || input.shape === 'polyline' || input.shape === 'polygon') output.shape = input.shape;
  if (typeof input.area === 'string' && input.area.trim()) output.area = input.area.trim().slice(0, 100);
  if (typeof input.host === 'string' && input.host.trim()) output.host = input.host.trim().slice(0, 120);
  if (typeof input.room === 'string' && input.room.trim()) output.room = input.room.trim().slice(0, 120);
  return output;
}

function safeNullableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function sanitizeProjectAddressEvidence(raw: unknown, sheetCount: number): { address?: PlanProjectAddressEvidence; limitation?: string } {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { limitation: 'Project address evidence dropped because the provider returned an invalid address object.' };
  }
  const input = raw as Record<string, unknown>;
  const pageNumber = typeof input.page_number === 'number' && Number.isInteger(input.page_number) ? input.page_number : null;
  const sourceExcerpt = safeNullableText(input.source_excerpt, 1000);
  if (pageNumber === null || pageNumber < 1 || pageNumber > sheetCount || !sourceExcerpt) {
    return { limitation: 'Project address evidence dropped because it did not include a valid physical page and verbatim source excerpt.' };
  }

  const streetAddress = safeNullableText(input.street_address, 240);
  const city = safeNullableText(input.city, 120);
  const state = safeNullableText(input.state, 80);
  const postalCode = safeNullableText(input.postal_code, 24);
  const buildingLotUnit = safeNullableText(input.building_lot_unit, 120);
  if (!streetAddress && !city && !state && !postalCode && !buildingLotUnit) {
    return { limitation: 'Project address evidence dropped because no physical address component was visibly supported.' };
  }

  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.max(0.1, Math.min(1, input.confidence))
    : 0.75;
  return {
    address: {
      project_name: safeNullableText(input.project_name, 160),
      street_address: streetAddress,
      city,
      state,
      postal_code: postalCode,
      building_lot_unit: buildingLotUnit,
      page_number: pageNumber,
      source_excerpt: sourceExcerpt,
      confidence,
    },
  };
}

/**
 * Cleans raw model output into safe, reviewable findings. Text-derived numeric
 * measurements still require a verbatim source citation. The only citationless
 * numeric value allowed from visual evidence is a discrete EA=1 object whose
 * normalized location survived geometry validation. This lets RoughBid retain
 * a visibly detected door/window/fixture without allowing the model to invent
 * LF/SF/CY measurements from an uncalibrated drawing.
 */
export function sanitizePlanReadingResult(raw: unknown, notices: readonly string[] = [], synthetic = false): PlanReadingResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawSummary = (input.summary && typeof input.summary === 'object' ? input.summary : {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(input.findings) ? input.findings : [];

  const sheetCount = typeof rawSummary.sheet_count === 'number' && Number.isInteger(rawSummary.sheet_count) && rawSummary.sheet_count > 0
    ? rawSummary.sheet_count
    : 1;
  const projectAddress = sanitizeProjectAddressEvidence(rawSummary.project_address, sheetCount);
  const dropped: string[] = [];
  const findings: PlanReadingFinding[] = [];

  for (const entry of rawFindings) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 160) : null;
    if (!label) { dropped.push('a finding with no label'); continue; }

    const pageNumber = typeof item.page_number === 'number' && Number.isInteger(item.page_number) && item.page_number > 0
      ? item.page_number
      : null;
    const geometry = pageNumber && pageNumber <= sheetCount ? sanitizePlanGeometry(item.geometry) : {};
    const visualEvidence = geometry.evidence_kind === 'visual' && Object.keys(geometry).length > 0;
    const hasQuantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0;
    const unit = typeof item.unit === 'string' ? item.unit.trim().toUpperCase() : null;
    const sourceExcerpt = typeof item.source_excerpt === 'string' && item.source_excerpt.trim() ? item.source_excerpt.trim().slice(0, 1000) : null;

    if (hasQuantity) {
      if (!unit || !ALLOWED_UNITS.has(unit)) { dropped.push(`"${label}": unit "${String(item.unit)}" is not an allowed imperial unit`); continue; }
      const visualDiscreteCount = visualEvidence && unit === 'EA' && item.quantity === 1;
      if (!sourceExcerpt && !visualDiscreteCount) { dropped.push(`"${label}": quantity without acceptable text or visual evidence`); continue; }
    }

    const findingType = ALLOWED_FINDING_TYPES.has(item.finding_type as PlanReadingFindingType)
      ? (item.finding_type as PlanReadingFindingType)
      : (hasQuantity ? 'measurement' : 'scope_note');
    if (hasQuantity && (pageNumber === null || pageNumber > sheetCount)) {
      dropped.push(`"${label}": quantity without a valid source page`); continue;
    }
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0.1, Math.min(1, item.confidence))
      : 0.75;

    findings.push({
      page_number: pageNumber,
      finding_type: findingType,
      label,
      value_text: typeof item.value_text === 'string' ? item.value_text.slice(0, 500) : null,
      quantity: hasQuantity ? Math.round((item.quantity as number) * 100) / 100 : null,
      unit: hasQuantity ? unit : null,
      confidence,
      geometry,
      source_excerpt: sourceExcerpt,
    });
  }

  const capped = findings.slice(0, MAX_FINDINGS);
  const limitations = [...notices, ...(Array.isArray(rawSummary.limitations) ? rawSummary.limitations.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 1000)) : [])];
  if (projectAddress.limitation) limitations.push(projectAddress.limitation);
  if (dropped.length) limitations.push(`${dropped.length} item(s) dropped because their evidence, page identity, or unit was not safe to persist.`);
  if (findings.length > MAX_FINDINGS) limitations.push(`Findings capped at ${MAX_FINDINGS} (${findings.length} detected).`);

  return {
    summary: {
      sheet_count: sheetCount,
      detected_trade_scope: Array.isArray(rawSummary.detected_trade_scope) ? rawSummary.detected_trade_scope.map(String) : [],
      scale_status: rawSummary.scale_status === 'detected' || rawSummary.scale_status === 'conflicting' ? rawSummary.scale_status : 'missing',
      human_review_required: true,
      limitations,
      ...(projectAddress.address ? { project_address: projectAddress.address } : {}),
      ...(synthetic ? { synthetic: true } : {}),
    },
    findings: capped,
  };
}
