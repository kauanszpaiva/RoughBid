import { calculateEstimateV2, isCanonicalUnit, type CanonicalUnit, type EstimateLineV2Input, type EstimateV2Input, type EstimateV2Result, type PriceProvenance } from '../../../../packages/domain/src/takeoff-v2.ts';

/** An approved measurement, never an LLM observation or a displayed folder. */
export interface BudgetMeasurement {
  id: string;
  physicalPageNumber: number;
  sourceRef: string;
  revision: string;
  quantity: number | null;
  unit: CanonicalUnit;
  reviewed: boolean;
  scaleVerified: boolean;
}

export interface SourcedRate {
  amount: number | null;
  source: PriceProvenance | null;
}

/** Explicitly selected material/labor composition; no automatic catalog match. */
export interface BudgetAssembly {
  id: string;
  description: string;
  unit: CanonicalUnit;
  reviewed: boolean;
  wastePercent: number | null;
  material?: SourcedRate;
  labor?: SourcedRate & { unitsPerHour: number | null; productivityModifier: number | null };
}

export interface EvidenceBudgetInput {
  asOf: string;
  physicalPageCount: number;
  coverage: Array<{ physicalPageNumber: number; reviewed: boolean; revision: string }>;
  unresolvedConflicts: readonly string[];
  measurements: readonly BudgetMeasurement[];
  assemblies: readonly BudgetAssembly[];
  selections: readonly { measurementId: string; assemblyId: string }[];
  policies: Omit<EstimateV2Input, 'lineItems'>;
}

export interface EvidenceBudgetResult {
  releaseStatus: 'blocked' | 'review_ready';
  humanReviewRequired: true;
  estimate: EstimateV2Result | null;
  blockers: string[];
  provenance: Array<{ measurementId: string; assemblyId: string; revision: string; sourceRef: string; materialSource: PriceProvenance | null; laborSource: PriceProvenance | null }>;
}

/** Convert provider SI evidence once; never apply drawing scale to SI values. */
export function canonicalizeSiEvidence(value: number | null, sourceUnit: 'm2' | 'm' | 'count') {
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER
    || (sourceUnit === 'count' && !Number.isSafeInteger(value)))) throw new RangeError('Invalid SI measurement evidence.');
  if (sourceUnit !== 'm2' && sourceUnit !== 'm' && sourceUnit !== 'count') throw new RangeError('Unsupported SI evidence unit.');
  const factor = sourceUnit === 'm2' ? 1_562_500 / 145_161 : sourceUnit === 'm' ? 1_250 / 381 : 1;
  const converted = value === null ? null : Number((value * factor).toFixed(6));
  if (converted !== null && converted > Number.MAX_SAFE_INTEGER) throw new RangeError('Converted measurement exceeds supported precision.');
  return { quantity: converted, unit: (sourceUnit === 'm2' ? 'SF' : sourceUnit === 'm' ? 'LF' : 'EA') as CanonicalUnit,
    formula: { version: 'si-to-canonical-v1' as const, sourceValue: value, sourceUnit, factor } };
}

function validDecimal(value: number | null, positive = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    && value <= Number.MAX_SAFE_INTEGER && /^(\d+)(?:\.(\d{1,6}))?$/.test(String(value));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function priceSourceValid(source: PriceProvenance | null, asOf: string): boolean {
  return Boolean(source && ['project_quote', 'workspace_price_book', 'job_cost_actual', 'vendor_catalog', 'licensed_database', 'regional_benchmark'].includes(source.sourceType)
    && source.sourceName?.trim() && validDate(source.effectiveDate) && source.effectiveDate <= asOf
    && (source.expiresAt === null || (validDate(source.expiresAt) && source.expiresAt >= asOf))
    && Number.isFinite(source.confidence) && source.confidence >= 0 && source.confidence <= 1);
}

/**
 * Deterministic join after measurement and reconciliation. Missing evidence
 * prevents calculation altogether: an unknown rate never becomes a $0 bid.
 * The result is for estimator review, not automatic proposal publication.
 */
export function buildEvidenceBudget(input: EvidenceBudgetInput): EvidenceBudgetResult {
  const blockers: string[] = [];
  const provenance: EvidenceBudgetResult['provenance'] = [];
  const lines: EstimateLineV2Input[] = [];
  if (!validDate(input.asOf)) blockers.push('invalid_pricing_date');
  if (!Number.isInteger(input.physicalPageCount) || input.physicalPageCount < 1 || input.physicalPageCount > 200) blockers.push('invalid_physical_page_count');
  const coverage = new Map<number, EvidenceBudgetInput['coverage'][number]>();
  for (const page of input.coverage) {
    if (coverage.has(page.physicalPageNumber) || !Number.isInteger(page.physicalPageNumber) || page.physicalPageNumber < 1 || page.physicalPageNumber > input.physicalPageCount) blockers.push('ambiguous_page_coverage');
    coverage.set(page.physicalPageNumber, page);
  }
  for (let page = 1; page <= Math.min(input.physicalPageCount, 200); page++) {
    if (!coverage.get(page)?.reviewed || !coverage.get(page)?.revision?.trim()) blockers.push(`page_${page}_requires_review`);
  }
  if (input.unresolvedConflicts.length) blockers.push('unresolved_drawing_conflicts');
  const measurements = new Map<string, BudgetMeasurement>();
  for (const item of input.measurements) {
    if (!item.id?.trim() || measurements.has(item.id)) blockers.push('ambiguous_measurement_identity');
    measurements.set(item.id, item);
  }
  const assemblies = new Map<string, BudgetAssembly>();
  for (const assembly of input.assemblies) {
    if (!assembly.id?.trim() || assemblies.has(assembly.id)) blockers.push('ambiguous_assembly_identity');
    assemblies.set(assembly.id, assembly);
  }
  if (!input.selections.length) blockers.push('no_approved_assembly_selections');
  const used = new Set<string>();
  for (const selection of input.selections) {
    const item = measurements.get(selection.measurementId);
    const assembly = assemblies.get(selection.assemblyId);
    if (used.has(selection.measurementId)) { blockers.push('measurement_selected_more_than_once'); continue; }
    used.add(selection.measurementId);
    if (!item || !assembly) { blockers.push('missing_measurement_or_assembly'); continue; }
    const page = coverage.get(item.physicalPageNumber);
    if (!item.reviewed || !item.sourceRef?.trim() || !item.revision?.trim() || !page || item.revision !== page.revision
      || !validDecimal(item.quantity) || !isCanonicalUnit(item.unit) || (item.unit !== 'EA' && !item.scaleVerified)) {
      blockers.push('measurement_evidence_requires_review'); continue;
    }
    if (!assembly.reviewed || !assembly.description?.trim() || assembly.unit !== item.unit || !validDecimal(assembly.wastePercent) || assembly.wastePercent > 100) {
      blockers.push('assembly_or_unit_requires_review'); continue;
    }
    if (!assembly.material && !assembly.labor) { blockers.push('missing_price_components'); continue; }
    if ((assembly.material && (!validDecimal(assembly.material.amount) || !priceSourceValid(assembly.material.source, input.asOf)))
      || (assembly.labor && (!validDecimal(assembly.labor.amount) || !priceSourceValid(assembly.labor.source, input.asOf)
        || !validDecimal(assembly.labor.unitsPerHour, true) || !validDecimal(assembly.labor.productivityModifier, true)))) {
      blockers.push('missing_expired_or_unapproved_price_source'); continue;
    }
    const source = assembly.material?.source ?? assembly.labor?.source ?? undefined;
    lines.push({ id: item.id, description: assembly.description, unit: item.unit, rawQuantity: item.quantity, wastePercent: assembly.wastePercent,
      ...(assembly.material ? { materialUnitRate: assembly.material.amount! } : {}),
      ...(assembly.labor ? { laborHourlyCost: assembly.labor.amount!, laborProductionRate: assembly.labor.unitsPerHour!, laborProductivityModifier: assembly.labor.productivityModifier! } : {}),
      ...(source ? { priceSource: source } : {}),
    });
    provenance.push({ measurementId: item.id, assemblyId: assembly.id, revision: item.revision, sourceRef: item.sourceRef,
      materialSource: assembly.material?.source ?? null, laborSource: assembly.labor?.source ?? null });
  }
  for (const item of input.measurements) if (!used.has(item.id)) blockers.push('unmapped_measurement');
  if (blockers.length) return { releaseStatus: 'blocked', humanReviewRequired: true, estimate: null, blockers: [...new Set(blockers)], provenance };
  try {
    const estimate = calculateEstimateV2({ ...input.policies, lineItems: lines });
    if (estimate.blockers.length) return { releaseStatus: 'blocked', humanReviewRequired: true, estimate: null, blockers: ['estimate_requires_price_review'], provenance };
    return { releaseStatus: 'review_ready', humanReviewRequired: true, estimate, blockers: [], provenance };
  } catch {
    return { releaseStatus: 'blocked', humanReviewRequired: true, estimate: null, blockers: ['invalid_estimate_policy'], provenance };
  }
}
