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
 * Drawing elements that carry construction meaning without their own printed
 * sentence: an icon, a legend symbol, hatching, line work, a graphic scale bar.
 * Recording them is what lets a reading cover the sheet, not just its text.
 */
export type PlanVisualElementKind =
  | 'symbol'
  | 'icon'
  | 'hatch_pattern'
  | 'line_work'
  | 'dimension_string'
  | 'graphic_scale_bar'
  | 'north_arrow'
  | 'grid_reference'
  | 'legend_mark'
  | 'callout'
  | 'detail'
  | 'title_block'
  | 'schedule_table';

export const ALLOWED_VISUAL_ELEMENT_KINDS: ReadonlySet<PlanVisualElementKind> = new Set<PlanVisualElementKind>([
  'symbol', 'icon', 'hatch_pattern', 'line_work', 'dimension_string',
  'graphic_scale_bar', 'north_arrow', 'grid_reference', 'legend_mark',
  'callout', 'detail', 'title_block', 'schedule_table',
]);

/**
 * Graphic evidence for one drawing element. It identifies what was seen and
 * where, and is deliberately NOT a quantity: a picture never becomes a trusted
 * number, it only becomes a located, reviewable observation.
 */
export interface PlanVisualEvidence {
  kind: PlanVisualElementKind;
  description: string;
  legend_mark?: string;
  confidence: number;
}

/** What a provider could actually see when it produced a reading. */
export type PlanReadingMode = 'visual_pdf' | 'visual_page_images' | 'text_only' | 'unknown';

/** Server-side declaration of a reader's ability to inspect the drawing itself. */
export type PlanReaderVisualCapability = 'pdf_native' | 'page_images' | 'text_only' | 'unknown';

export const TEXT_ONLY_READING_REFUSED =
  'The configured plan reader extracts PDF text only and cannot inspect the drawing itself (line work, symbols, icons, hatches, graphic scale). No reading was started.';

export const TEXT_ONLY_READING_NOTICE =
  'This reading was produced from extracted PDF text only. Drawings, symbols, icons, line work and graphic scale were NOT visually inspected.';

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
  /**
   * What the provider could actually see. Assigned by the trusted server-side
   * reader, never by model output: `text_only` means the drawing itself was
   * never inspected.
   */
  reading_mode?: PlanReadingMode;
  /** How many findings rest on graphic drawing evidence instead of a printed text excerpt. */
  visual_evidence_count?: number;
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

const MAX_FINDINGS = 200;
const MAX_VISUAL_DESCRIPTION = 300;

function safeNullableText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : null;
}

function normalizedBox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  const [x, y, width, height] = value as number[];
  if (!width || !height || x! + width > 1 || y! + height > 1) return null;
  return [x!, y!, width!, height!];
}

function normalizedPoint(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  if (!value.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return null;
  return [value[0] as number, value[1] as number];
}

/** Bounded, validated graphic evidence. Anything not on the allow-list is dropped. */
export function sanitizePlanVisualEvidence(raw: unknown): PlanVisualEvidence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (!ALLOWED_VISUAL_ELEMENT_KINDS.has(input.kind as PlanVisualElementKind)) return null;
  const description = safeNullableText(input.description, MAX_VISUAL_DESCRIPTION);
  if (!description) return null;
  const legendMark = safeNullableText(input.legend_mark, 80);
  const confidence = typeof input.confidence === 'number' && Number.isFinite(input.confidence)
    ? Math.max(0.1, Math.min(1, input.confidence))
    : 0.5;
  return {
    kind: input.kind as PlanVisualElementKind,
    description,
    confidence,
    ...(legendMark ? { legend_mark: legendMark } : {}),
  };
}

const GEOMETRY_TEXT_FIELDS: ReadonlyArray<readonly [string, number]> = [
  ['area', 100], ['room', 100], ['element', 60], ['legend_mark', 80],
  ['sheet_reference', 40], ['scale_note', 60], ['grid_reference', 40],
];

/**
 * Only normalized page coordinates, bounded drawing descriptors and validated
 * graphic evidence survive; provider pricing is never persisted.
 */
export function sanitizePlanGeometry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const geometry: Record<string, unknown> = {};
  const box = normalizedBox(input.bbox);
  const point = normalizedPoint(input.point);
  if (box) geometry.bbox = box;
  if (point) geometry.point = point;
  if (box || point) geometry.coordinate_space = 'normalized';
  for (const [key, max] of GEOMETRY_TEXT_FIELDS) {
    const text = safeNullableText(input[key], max);
    if (text) geometry[key] = text;
  }
  const visual = sanitizePlanVisualEvidence(input.visual);
  if (visual) geometry.visual = visual;
  return geometry;
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
 * Cleans raw model (or fallback-generator) output into safe, storable
 * findings — the same hard validation rule an untrusted model output needs
 * regardless of provider: a quantity is only ever trusted alongside a
 * verbatim source excerpt and an allowed imperial unit. Anything that fails
 * is dropped and disclosed in `summary.limitations`, never silently coerced.
 *
 * `readingMode` is supplied by the trusted server-side reader (never by model
 * output) so a stored reading always records whether the drawing itself was
 * inspected.
 */
export function sanitizePlanReadingResult(raw: unknown, notices: readonly string[] = [], synthetic = false, readingMode: PlanReadingMode = 'unknown'): PlanReadingResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawSummary = (input.summary && typeof input.summary === 'object' ? input.summary : {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(input.findings) ? input.findings : [];

  const sheetCount = typeof rawSummary.sheet_count === 'number' && Number.isInteger(rawSummary.sheet_count) && rawSummary.sheet_count > 0
    ? rawSummary.sheet_count
    : 1;
  const projectAddress = sanitizeProjectAddressEvidence(rawSummary.project_address, sheetCount);
  const dropped: string[] = [];
  const findings: PlanReadingFinding[] = [];
  let visualEvidenceCount = 0;

  for (const entry of rawFindings) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 160) : null;
    if (!label) { dropped.push('a finding with no label'); continue; }

    const hasQuantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0;
    const unit = typeof item.unit === 'string' ? item.unit.trim().toUpperCase() : null;
    const sourceExcerpt = typeof item.source_excerpt === 'string' && item.source_excerpt.trim() ? item.source_excerpt.trim() : null;

    if (hasQuantity) {
      if (!sourceExcerpt) { dropped.push(`"${label}": quantity without a verbatim source excerpt`); continue; }
      if (!unit || !ALLOWED_UNITS.has(unit)) { dropped.push(`"${label}": unit "${String(item.unit)}" is not an allowed imperial unit`); continue; }
    }

    const findingType = ALLOWED_FINDING_TYPES.has(item.finding_type as PlanReadingFindingType)
      ? (item.finding_type as PlanReadingFindingType)
      : (hasQuantity ? 'measurement' : 'scope_note');
    const pageNumber = typeof item.page_number === 'number' && Number.isInteger(item.page_number) && item.page_number > 0
      ? item.page_number
      : null;
    if (hasQuantity && (pageNumber === null || pageNumber > sheetCount)) {
      dropped.push(`"${label}": quantity without a valid source page`); continue;
    }
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0.1, Math.min(1, item.confidence))
      : 0.75;

    // A located drawing element may rest on printed text OR on validated
    // graphic evidence. It never bypasses the quantity rule above: graphic
    // evidence can place and name an element, never invent its amount.
    const geometry = pageNumber ? sanitizePlanGeometry(item.geometry) : {};
    const keepsGeometry = pageNumber !== null && (Boolean(sourceExcerpt) || Boolean(geometry.visual));
    if (geometry.visual) visualEvidenceCount += 1;

    findings.push({
      page_number: pageNumber,
      finding_type: findingType,
      label,
      value_text: typeof item.value_text === 'string' ? item.value_text.slice(0, 500) : null,
      quantity: hasQuantity ? Math.round((item.quantity as number) * 100) / 100 : null,
      unit: hasQuantity ? unit : null,
      confidence,
      geometry: keepsGeometry ? geometry : {},
      source_excerpt: sourceExcerpt,
    });
  }

  const capped = findings.slice(0, MAX_FINDINGS);
  const limitations = [...notices, ...(Array.isArray(rawSummary.limitations) ? rawSummary.limitations.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 1000)) : [])];
  if (projectAddress.limitation) limitations.push(projectAddress.limitation);
  if (dropped.length) limitations.push(`${dropped.length} item(s) dropped for missing a verbatim source citation or an invalid unit.`);
  if (findings.length > MAX_FINDINGS) limitations.push(`Findings capped at ${MAX_FINDINGS} (${findings.length} detected).`);
  if (visualEvidenceCount) {
    limitations.push(`${visualEvidenceCount} finding(s) rest on graphic drawing evidence (symbols, icons, hatch, line work or graphic scale) instead of a printed text excerpt. Verify each one on the drawing before it affects an estimate.`);
  }
  if (readingMode === 'text_only') limitations.push(TEXT_ONLY_READING_NOTICE);

  return {
    summary: {
      sheet_count: sheetCount,
      detected_trade_scope: Array.isArray(rawSummary.detected_trade_scope) ? rawSummary.detected_trade_scope.map(String) : [],
      scale_status: rawSummary.scale_status === 'detected' || rawSummary.scale_status === 'conflicting' ? rawSummary.scale_status : 'missing',
      human_review_required: true,
      limitations,
      reading_mode: readingMode,
      ...(visualEvidenceCount ? { visual_evidence_count: visualEvidenceCount } : {}),
      ...(projectAddress.address ? { project_address: projectAddress.address } : {}),
      ...(synthetic ? { synthetic: true } : {}),
    },
    findings: capped,
  };
}