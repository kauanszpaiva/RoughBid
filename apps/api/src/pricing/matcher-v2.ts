import type { CanonicalUnit, PriceSourceType } from '../../../../packages/domain/src/takeoff-v2.ts';

export const PRICE_SOURCE_PRECEDENCE: Record<PriceSourceType, number> = {
  project_quote: 1,
  workspace_price_book: 2,
  job_cost_actual: 3,
  vendor_catalog: 4,
  licensed_database: 5,
  regional_benchmark: 6,
  provisional_assumption: 7,
};

export interface PriceCandidate {
  id: string;
  description: string;
  unit: CanonicalUnit;
  sourceType: PriceSourceType;
  effectiveDate: string;
  expiresAt: string | null;
  geography: string | null;
  specification: string | null;
}

export interface PriceMatchRequest {
  description: string;
  unit: CanonicalUnit;
  geography: string | null;
  specification: string | null;
  asOfDate: string;
}

/** Candidate ranking only. Human/rule selection authorizes the final price snapshot. */
export function rankPriceCandidates(request: PriceMatchRequest, candidates: readonly PriceCandidate[]): Array<PriceCandidate & { reasons: string[] }> {
  const normalizedGeography = request.geography?.trim().toLowerCase();
  return candidates
    .filter(candidate => candidate.unit === request.unit)
    .filter(candidate => !candidate.expiresAt || candidate.expiresAt >= request.asOfDate)
    .map(candidate => {
      const reasons = [`exact unit ${request.unit}`, `source precedence ${PRICE_SOURCE_PRECEDENCE[candidate.sourceType]}`];
      if (normalizedGeography && candidate.geography?.trim().toLowerCase() === normalizedGeography) reasons.push('exact geography');
      if (request.specification && candidate.specification === request.specification) reasons.push('exact specification');
      return { ...candidate, reasons };
    })
    .sort((left, right) => {
      const source = PRICE_SOURCE_PRECEDENCE[left.sourceType] - PRICE_SOURCE_PRECEDENCE[right.sourceType];
      if (source) return source;
      const exactSpec = Number(right.reasons.includes('exact specification')) - Number(left.reasons.includes('exact specification'));
      if (exactSpec) return exactSpec;
      const exactGeo = Number(right.reasons.includes('exact geography')) - Number(left.reasons.includes('exact geography'));
      return exactGeo || right.effectiveDate.localeCompare(left.effectiveDate);
    });
}

export function authorizePriceSelection(request: PriceMatchRequest, selected: PriceCandidate): PriceCandidate {
  if (selected.unit !== request.unit) throw new Error(`Price unit ${selected.unit} is incompatible with takeoff unit ${request.unit}.`);
  if (selected.expiresAt && selected.expiresAt < request.asOfDate) throw new Error('The selected price snapshot is expired.');
  if (selected.sourceType === 'regional_benchmark' && !selected.geography) throw new Error('Regional benchmarks require declared geography.');
  return selected;
}
