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

export interface PlanReadingSummary {
  sheet_count: number;
  detected_trade_scope: string[];
  scale_status: 'detected' | 'missing' | 'conflicting';
  human_review_required: true;
  /** Honesty-over-coverage disclosures: unreadable pages, ambiguous scale, dropped findings, fallback notices. */
  limitations: string[];
}

export interface PlanReadingResult {
  summary: PlanReadingSummary;
  findings: PlanReadingFinding[];
}

const MAX_FINDINGS = 200;

/**
 * Cleans raw model (or fallback-generator) output into safe, storable
 * findings — the same hard validation rule an untrusted model output needs
 * regardless of provider: a quantity is only ever trusted alongside a
 * verbatim source excerpt and an allowed imperial unit. Anything that fails
 * is dropped and disclosed in `summary.limitations`, never silently coerced.
 */
export function sanitizePlanReadingResult(raw: unknown, notices: readonly string[] = []): PlanReadingResult {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawSummary = (input.summary && typeof input.summary === 'object' ? input.summary : {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(input.findings) ? input.findings : [];

  const dropped: string[] = [];
  const findings: PlanReadingFinding[] = [];

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
      geometry: (item.geometry && typeof item.geometry === 'object') ? item.geometry as Record<string, unknown> : {},
      source_excerpt: sourceExcerpt,
    });
  }

  const capped = findings.slice(0, MAX_FINDINGS);
  const limitations = [...notices];
  if (dropped.length) limitations.push(`${dropped.length} item(s) dropped for missing a verbatim source citation or an invalid unit.`);
  if (findings.length > MAX_FINDINGS) limitations.push(`Findings capped at ${MAX_FINDINGS} (${findings.length} detected).`);

  return {
    summary: {
      sheet_count: typeof rawSummary.sheet_count === 'number' ? rawSummary.sheet_count : 1,
      detected_trade_scope: Array.isArray(rawSummary.detected_trade_scope) ? rawSummary.detected_trade_scope.map(String) : [],
      scale_status: rawSummary.scale_status === 'missing' || rawSummary.scale_status === 'conflicting' ? rawSummary.scale_status : 'detected',
      human_review_required: true,
      limitations,
    },
    findings: capped,
  };
}
