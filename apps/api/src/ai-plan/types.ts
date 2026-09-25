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
 * A file name is user-controlled text and it is interpolated into a system
 * instruction, so it is cleaned before it ever reaches a provider: control
 * characters, line separators and quotes are removed, whitespace is collapsed
 * and the length is bounded. A crafted upload name cannot then rewrite the
 * reader's rules or close the surrounding instruction.
 */
export function sanitizeSheetLabel(value: unknown, max = 120): string {
  const raw = typeof value === 'string' ? value : '';
  const cleaned = raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/[`"'\u2018\u2019\u201C\u201D]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return cleaned || 'uploaded plan';
}

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

export interface PlanScanCoverage {
  physical_page_count: number;
  base_pages_attempted: number[];
  base_pages_failed: number[];
  base_pages_unread: number[];
  dense_pages_selected: number[];
  regional_pages_completed: number[];
  regional_pages_failed: number[];
  exhaustive_scan_completed: boolean;
}

export interface PlanReadingSummary {
  sheet_count: number;
  detected_trade_scope: string[];
  scale_status: 'detected' | 'missing' | 'conflicting';
  human_review_required: true;
  /** Honesty-over-coverage disclosures: unreadable pages, ambiguous scale, dropped findings, fallback notices. */
  limitations: string[];
  /** Deterministic server-side execution coverage. Model assertions never populate this field. */
  scan_coverage?: PlanScanCoverage;
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

export const MAX_FINDINGS = 1_000;

/** Only normalized PDF coordinates survive; provider pricing is never persisted. */
export function sanitizePlanGeometry(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const box = input.bbox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return {};
  const [x, y, width, height] = box as number[];
  if (!width || !height || x! + width > 1 || y! + height > 1) return {};
  return { bbox: box, coordinate_space: 'normalized', ...(typeof input.area === 'string' ? { area: input.area.trim().slice(0, 100) } : {}) };
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

/** Units that describe a size, never an amount. `IN`/`GA`/`MM` are dimensions. */
const DIMENSION_UNITS: ReadonlySet<string> = new Set(['IN', 'INCH', 'INCHES', 'GA', 'GAUGE', 'MM', 'CM', 'MIL']);

/**
 * Printed dimension designators: `4"`, `4 in`, `5/8 in`, `4 thk`, `20 ga`, `#4`.
 *
 * The allowed unit list is SF/LF/EA/CY/SY/HR/LS — it has no thickness code. A 4"
 * slab thickness therefore had to be expressed as a quantity, and the nearest
 * available unit was a length, producing "4 LF". That misread is exactly what the
 * 2026-09-10 estimator review rejected, and no unit whitelist can catch it because
 * LF is a valid unit. The guard below is dimensional, not lexical: it only fires
 * when the reported quantity restates a designator printed in that same finding.
 */
const PRINTED_DESIGNATOR = /(?:(\d+(?:[./]\d+)?)\s*(?:"|''|in\b|in\.|inch(?:es)?\b|thk\b|thick(?:ness)?\b|ga\b|gauge\b|mm\b|cm\b))|(?:#\s*(\d+))/gi;

const roundQuantity = (value: number) => Math.round(value * 1000) / 1000;

/** Every number printed as a dimension designator in `text`. */
function printedDesignatorValues(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(PRINTED_DESIGNATOR)) {
    const raw = match[1] ?? match[2];
    if (!raw) continue;
    // 5/8 is one dimension, not a quotient of two measurements.
    const [numerator, denominator] = raw.split('/');
    const value = denominator ? Number(numerator) / Number(denominator) : Number(numerator);
    if (Number.isFinite(value) && value > 0) values.push(roundQuantity(value));
  }
  return values;
}

/** True when the reported quantity merely restates a designator printed in the same evidence. */
function restatesPrintedDimension(quantity: number, evidence: string): boolean {
  const rounded = roundQuantity(quantity);
  // A model may round a printed fraction (5/8 in -> 0.63), so allow a hundredth.
  return printedDesignatorValues(evidence).some(value => Math.abs(value - rounded) <= 0.01);
}

/** Keeps a printed dimension as evidence without inventing or overwriting the printed value text. */
function evidenceValueText(rawValueText: unknown, printedDimension: string | null): string | null {
  const base = typeof rawValueText === 'string' ? rawValueText.trim().slice(0, 400) : '';
  if (!printedDimension) return base ? base.slice(0, 500) : null;
  const dimension = printedDimension.trim();
  if (base.toLowerCase().includes(dimension.toLowerCase())) return base.slice(0, 500);
  return `${base ? `${base} ` : ''}[printed dimension: ${dimension}]`.slice(0, 500);
}

/**
 * Cleans raw model (or fallback-generator) output into safe, storable
 * findings — the same hard validation rule an untrusted model output needs
 * regardless of provider: a quantity is only ever trusted alongside a
 * verbatim source excerpt and an allowed imperial unit. Anything that fails
 * is dropped and disclosed in `summary.limitations`, never silently coerced.
 *
 * Dimensional consistency is part of that rule: a thickness, gauge or nominal
 * size is specification evidence, so it is kept in `value_text` and never
 * becomes a quantity, however valid its unit would otherwise be.
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
  const dimensionRestatements: string[] = [];

  for (const entry of rawFindings) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 160) : null;
    if (!label) { dropped.push('a finding with no label'); continue; }

    const reportedQuantity = typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : null;
    const unit = typeof item.unit === 'string' ? item.unit.trim().toUpperCase() : null;
    const sourceExcerpt = typeof item.source_excerpt === 'string' && item.source_excerpt.trim() ? item.source_excerpt.trim() : null;
    const reportedDimension = safeNullableText(item.dimension, 60);
    const evidence = [label, reportedDimension, typeof item.value_text === 'string' ? item.value_text : null, sourceExcerpt].filter(Boolean).join(' ');

    let hasQuantity = reportedQuantity !== null;
    let printedDimension = reportedDimension;

    if (hasQuantity) {
      if (!sourceExcerpt) { dropped.push(`"${label}": quantity without a verbatim source excerpt`); continue; }
      if (unit && DIMENSION_UNITS.has(unit)) {
        // 4" is a thickness, not four of anything. Keep it as evidence instead of dropping it.
        printedDimension = printedDimension ?? `${roundQuantity(reportedQuantity!)} ${unit.toLowerCase()}`;
        hasQuantity = false;
      } else if (!unit || !ALLOWED_UNITS.has(unit)) {
        dropped.push(`"${label}": unit "${String(item.unit)}" is not an allowed imperial unit`); continue;
      } else if (restatesPrintedDimension(reportedQuantity!, evidence)) {
        hasQuantity = false;
        dimensionRestatements.push(label);
      }
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

    findings.push({
      page_number: pageNumber,
      finding_type: findingType,
      label,
      value_text: evidenceValueText(item.value_text, printedDimension),
      quantity: hasQuantity ? Math.round((item.quantity as number) * 100) / 100 : null,
      unit: hasQuantity ? unit : null,
      confidence,
      geometry: pageNumber && sourceExcerpt ? sanitizePlanGeometry(item.geometry) : {},
      source_excerpt: sourceExcerpt,
    });
  }

  const capped = findings.slice(0, MAX_FINDINGS);
  const limitations = [...notices, ...(Array.isArray(rawSummary.limitations) ? rawSummary.limitations.filter((v): v is string => typeof v === 'string').map(v => v.slice(0, 1000)) : [])];
  if (projectAddress.limitation) limitations.push(projectAddress.limitation);
  if (dropped.length) limitations.push(`${dropped.length} item(s) dropped for missing a verbatim source citation or an invalid unit.`);
  if (dimensionRestatements.length) {
    limitations.push(`${dimensionRestatements.length} item(s) restated a printed dimension (thickness, gauge or nominal size) as a quantity. The quantity was removed and the printed dimension kept as evidence: ${dimensionRestatements.slice(0, 3).join('; ')}.`);
  }
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