import { costDecimal, costMoney } from './cost-decimal.ts';

export type ConstructionTaxTreatment = 'embedded_in_direct_line' | 'added_once_to_direct_line' | 'embedded_in_overhead_or_contingency'
  | 'unallocated_nonrecoverable_cost_tax' | 'recoverable_tax_excluded_from_cost' | 'output_tax_separate_from_profit' | 'pending';
export interface ConstructionTaxCharge {
  id: string; sourceChargeReference: string | null; sourceRef: string | null; supplierQuoteId: string | null;
  amount: number | null; currency: 'USD'; jurisdiction: string | null; taxType: string | null;
  recoverability: 'nonrecoverable' | 'recoverable' | 'output' | 'pending'; includedInQuotedAmount: boolean | null;
  treatment: ConstructionTaxTreatment; reviewed: boolean;
  allocations: Array<{ lineId: string; amount: number | null; basis: string | null; sourceRef: string | null }>;
}
export interface ConstructionLandedCostLine {
  id: string; category: 'direct' | 'overhead' | 'contingency'; landedCost: number | null; taxChargeIds: string[];
}
export interface ConstructionTaxCostBase {
  directCost: number; allocatedOverhead: number; explicitContingency: number; unallocatedNonrecoverableTaxes: number;
  knownCostBase: number; total: number | null; pending: string[];
}
const reference = (value: string | null): value is string => typeof value === 'string' && Boolean(value.trim());
const identity = (value: string) => value.trim().normalize('NFKC').toLowerCase();
function cents(value: number): bigint { const amount = costDecimal(value); if (amount % 10_000n !== 0n) throw new RangeError('Tax amounts must use exact cents.'); return amount; }
function chargePending(charge: ConstructionTaxCharge): string[] {
  const pending: string[] = [];
  if (!reference(charge.sourceChargeReference) || !reference(charge.sourceRef)) pending.push('economic_source_identity_pending');
  if (charge.amount === null) pending.push('amount_pending'); else cents(charge.amount);
  if (!reference(charge.jurisdiction) || !reference(charge.taxType) || !charge.reviewed) pending.push('jurisdiction_and_tax_review_pending');
  if (charge.includedInQuotedAmount === null) pending.push('quoted_inclusion_pending');
  if (charge.recoverability === 'pending' || charge.treatment === 'pending') pending.push('tax_treatment_pending');
  if (charge.currency !== 'USD') pending.push('currency_mismatch');
  return pending;
}
/** Normalize a tax-inclusive quote only from identified amounts/evidence. Unknown tax is never guessed from a rate. */
export function normalizeConstructionQuotedTax(input: { quotedAmount: number | null; taxInclusion: 'exclusive' | 'inclusive' | 'unknown';
  charges: readonly ConstructionTaxCharge[]; notApplicableEvidenceRef: string | null }): { nonTaxAmount: number | null; nonrecoverableTax: number | null; landedCost: number | null; pending: string[] } {
  const pending: string[] = [], seen = new Set<string>(), ids = new Set<string>();
  const quoted = input.quotedAmount === null ? null : cents(input.quotedAmount);
  if (quoted === null) pending.push('quoted_amount_pending');
  if (input.taxInclusion === 'unknown') pending.push('quoted_tax_inclusion_pending');
  if (!input.charges.length && !reference(input.notApplicableEvidenceRef)) pending.push('tax_not_applicable_evidence_required');
  let embedded = 0n, nonrecoverable = 0n;
  for (const charge of input.charges) {
    if (!charge.id || ids.has(charge.id)) pending.push('duplicate_or_missing_tax_identity'); ids.add(charge.id);
    pending.push(...chargePending(charge).map(reason => `${charge.id}:${reason}`));
    if (charge.sourceChargeReference) { const key = identity(charge.sourceChargeReference); if (seen.has(key)) pending.push('duplicate_economic_tax_charge'); seen.add(key); }
    if (charge.includedInQuotedAmount !== null && ((input.taxInclusion === 'inclusive') !== charge.includedInQuotedAmount)) pending.push(`${charge.id}:tax_inclusion_mismatch`);
    if (charge.amount !== null) {
      const amount = cents(charge.amount); if (charge.includedInQuotedAmount === true) embedded += amount;
      if (charge.recoverability === 'nonrecoverable') nonrecoverable += amount;
    }
  }
  if (quoted !== null && embedded > quoted) pending.push('embedded_tax_exceeds_gross_quote');
  if (pending.length || quoted === null) return { nonTaxAmount: null, nonrecoverableTax: null, landedCost: null, pending: [...new Set(pending)] };
  const nonTax = quoted - embedded;
  return { nonTaxAmount: costMoney(nonTax), nonrecoverableTax: costMoney(nonrecoverable), landedCost: costMoney(nonTax + nonrecoverable), pending: [] };
}
/** Line totals already contain allocated nonrecoverable tax. Add only charges proven not allocated anywhere. */
export function guardConstructionTaxCostBase(input: { lines: readonly ConstructionLandedCostLine[]; charges: readonly ConstructionTaxCharge[];
  notApplicableEvidenceRef: string | null }): ConstructionTaxCostBase {
  const pending: string[] = [], lines = new Map<string, ConstructionLandedCostLine>(), charges = new Map<string, ConstructionTaxCharge>(), economicRefs = new Set<string>();
  const totals = { direct: 0n, overhead: 0n, contingency: 0n }; let unallocated = 0n;
  for (const line of input.lines) {
    if (!line.id || lines.has(line.id) || !['direct', 'overhead', 'contingency'].includes(line.category)) throw new TypeError('Cost line identities/categories must be unique and valid.');
    lines.set(line.id, line);
    if (line.landedCost === null) pending.push(`${line.id}:landed_cost_pending`); else totals[line.category] += cents(line.landedCost);
    if (new Set(line.taxChargeIds).size !== line.taxChargeIds.length) pending.push(`${line.id}:duplicate_tax_charge_reference`);
  }
  if (!input.charges.length && !reference(input.notApplicableEvidenceRef)) pending.push('tax_ledger_empty_without_explicit_evidence');
  for (const charge of input.charges) {
    if (!charge.id || charges.has(charge.id)) throw new TypeError('Tax charge IDs must be unique.'); charges.set(charge.id, charge);
    pending.push(...chargePending(charge).map(reason => `${charge.id}:${reason}`));
    let duplicateEconomicCharge = false;
    if (charge.sourceChargeReference) { const key = identity(charge.sourceChargeReference); duplicateEconomicCharge = economicRefs.has(key); if (duplicateEconomicCharge) pending.push(`${charge.id}:duplicate_economic_tax_charge`); economicRefs.add(key); }
    const allocationLines = new Set<string>(); let allocated = 0n;
    for (const allocation of charge.allocations) {
      const line = lines.get(allocation.lineId);
      if (allocationLines.has(allocation.lineId)) pending.push(`${charge.id}:duplicate_allocation`); allocationLines.add(allocation.lineId);
      if (!line || !line.taxChargeIds.includes(charge.id)) pending.push(`${charge.id}:allocation_line_reference_mismatch`);
      if (!reference(allocation.basis) || !reference(allocation.sourceRef) || allocation.amount === null) pending.push(`${charge.id}:allocation_evidence_pending`);
      else allocated += cents(allocation.amount);
      if (line && ((charge.treatment === 'embedded_in_overhead_or_contingency') === (line.category === 'direct'))) pending.push(`${charge.id}:allocation_category_mismatch`);
    }
    const referenced = [...lines.values()].filter(line => line.taxChargeIds.includes(charge.id));
    if (referenced.some(line => !allocationLines.has(line.id))) pending.push(`${charge.id}:line_tax_not_allocated`);
    const amount = charge.amount === null ? null : cents(charge.amount);
    if (charge.treatment === 'unallocated_nonrecoverable_cost_tax') {
      if (charge.allocations.length || referenced.length || charge.includedInQuotedAmount !== false || charge.recoverability !== 'nonrecoverable') pending.push(`${charge.id}:unallocated_tax_already_embedded_or_allocated`);
      else if (amount !== null && !chargePending(charge).length && !duplicateEconomicCharge) unallocated += amount;
    } else if (['embedded_in_direct_line', 'added_once_to_direct_line', 'embedded_in_overhead_or_contingency'].includes(charge.treatment)) {
      if (!charge.allocations.length || amount === null || allocated !== amount) pending.push(`${charge.id}:allocation_sum_mismatch`);
      if (charge.recoverability !== 'nonrecoverable') pending.push(`${charge.id}:recoverable_or_output_tax_cannot_enter_cost`);
      if (charge.treatment === 'embedded_in_direct_line' && charge.includedInQuotedAmount !== true) pending.push(`${charge.id}:embedded_tax_inclusion_mismatch`);
      if (charge.treatment === 'added_once_to_direct_line' && charge.includedInQuotedAmount !== false) pending.push(`${charge.id}:added_tax_inclusion_mismatch`);
    } else if (charge.treatment !== 'pending') {
      if (charge.allocations.length || referenced.length) pending.push(`${charge.id}:excluded_tax_allocated_to_cost`);
      if ((charge.treatment === 'recoverable_tax_excluded_from_cost' && charge.recoverability !== 'recoverable')
        || (charge.treatment === 'output_tax_separate_from_profit' && charge.recoverability !== 'output')) pending.push(`${charge.id}:exclusion_treatment_mismatch`);
    }
  }
  for (const line of input.lines) for (const chargeId of line.taxChargeIds) if (!charges.has(chargeId)) pending.push(`${line.id}:tax_charge_missing`);
  const known = totals.direct + totals.overhead + totals.contingency + unallocated;
  return { directCost: costMoney(totals.direct), allocatedOverhead: costMoney(totals.overhead), explicitContingency: costMoney(totals.contingency),
    unallocatedNonrecoverableTaxes: costMoney(unallocated), knownCostBase: costMoney(known), total: pending.length ? null : costMoney(known), pending: [...new Set(pending)] };
}
