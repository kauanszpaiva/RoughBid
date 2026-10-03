import { PROJECT_MARGIN_BPS, projectChargeCents, type ProjectMembership } from './project-charge.ts';

/** Processing revenue only. Construction materials, labor and equipment belong to the job estimate. */
export const SAAS_PROJECT_MARGIN_POLICY = {
  version: '2026-09-05-v1',
  source: 'docs/business-finance-pricing.md#project-reading-price-formula',
  marginsBps: PROJECT_MARGIN_BPS,
} as const;

export type SaasCostDriver = 'base' | 'pages' | 'regions' | 'provider_calls' | 'storage' | 'worker' | 'support' | 'other';
export type SaasCostBasis = 'measured' | 'reviewed_forecast' | 'pending';
export type SaasCostLine = {
  id: string;
  label: string;
  driver: SaasCostDriver;
  unit: string;
  quantity: number | null;
  /** Integer micro-USD preserves provider rates smaller than a cent. */
  unitCostMicrosUsd: number | null;
  basis: SaasCostBasis;
  source: string | null;
  priceVersion: string | null;
  documentedAt: string | null;
};

export type SaasPaymentFees = {
  fixedCents: number | null;
  variableBps: number | null;
  source: string | null;
};

export type SaasPricingIssue = { code: string; path: string; message: string };
export type SaasPricingAuditLine = SaasCostLine & { amountMicrosUsd: number };
export type SaasPricingPreviewResult = {
  kind: 'per_document' | 'monthly_membership';
  currency: 'USD';
  status: 'pending_inputs' | 'ready_for_review';
  commercialActivation: 'not_enabled_by_preview';
  constructionEstimateIncluded: false;
  technicalCostCents: number | null;
  knownCostMicrosUsd: number;
  proposedChargeCents: number | null;
  expectedPaymentFeesMicrosUsd: number | null;
  expectedGrossProfitMicrosUsd: number | null;
  targetGrossMarginBps: number | null;
  marginPolicySource: string | null;
  marginPolicyVersion: string | null;
  containsForecast: boolean;
  calculation: {
    formula: 'ceil((technical_cost_cents + fixed_fee_cents) * 10000 / (10000 - margin_bps - payment_fee_bps))';
    numerator: string | null;
    denominator: string | null;
    rounding: 'aggregate_micro_usd_to_cent_then_charge_up_to_cent';
  };
  audit: SaasPricingAuditLine[];
  issues: SaasPricingIssue[];
};

export type SaasPerDocumentPricingInput = {
  membership: ProjectMembership;
  costs: SaasCostLine[];
  /** Must explicitly include all applicable costs, failed attempts and unmetered operations. */
  costCoverageComplete: boolean;
  fees: SaasPaymentFees;
};

export type SaasMonthlyPricingInput = {
  costs: SaasCostLine[];
  costCoverageComplete: boolean;
  fees: SaasPaymentFees;
  /** No monthly margin was approved in the versioned primary business policy. */
  targetGrossMarginBps: number | null;
  marginPolicySource: string | null;
  marginPolicyVersion: string | null;
  /** Membership operating costs only; project reads are priced independently. */
  costAllocation: 'membership_only' | 'undetermined';
};

const MAX_CHARGE_CENTS = 99_999_999;
const MICRO_USD_PER_CENT = 10_000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validDate = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);

function preview(
  kind: SaasPricingPreviewResult['kind'],
  input: { costs: SaasCostLine[]; costCoverageComplete: boolean; fees: SaasPaymentFees },
  margin: number | null,
  marginSource: string | null,
  marginVersion: string | null,
  extraIssues: SaasPricingIssue[] = [],
  membership?: ProjectMembership,
): SaasPricingPreviewResult {
  const issues: SaasPricingIssue[] = [...extraIssues];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const audit: SaasPricingAuditLine[] = [];
  let knownCost = 0n;
  const ids = new Set<string>();
  const drivers = new Set(['base', 'pages', 'regions', 'provider_calls', 'storage', 'worker', 'support', 'other']);
  if (input.costCoverageComplete !== true) issue('cost_coverage_incomplete', 'costCoverageComplete', 'Confirm the full technical-cost coverage. Unknown provider costs and failed attempts cannot become zero.');
  if (!Array.isArray(input.costs) || input.costs.length === 0) issue('costs_missing', 'costs', 'Add documented technical costs before calculating a processing price.');
  for (const [index, line] of (Array.isArray(input.costs) ? input.costs : []).entries()) {
    const path = `costs.${index}`;
    let valid = true;
    const reject = (code: string, field: string, message: string) => { issue(code, `${path}.${field}`, message); valid = false; };
    if (!text(line.id) || ids.has(line.id)) reject('cost_identity_invalid', 'id', 'Every cost line needs a unique identity; duplicates must be reconciled.');
    else ids.add(line.id);
    if (!text(line.label) || !text(line.unit) || !drivers.has(line.driver)) reject('cost_description_invalid', 'label', 'Describe the cost driver and its billing unit.');
    if (!integer(line.quantity)) reject('cost_quantity_missing', 'quantity', 'Enter a nonnegative whole count in the documented billing unit.');
    if (!integer(line.unitCostMicrosUsd)) reject('unit_cost_missing', 'unitCostMicrosUsd', 'Enter a documented unit cost. A blank cost is unknown, not zero.');
    if (!['measured', 'reviewed_forecast'].includes(line.basis)) reject('cost_basis_pending', 'basis', 'Review the forecast or supply measured cost evidence.');
    if (!text(line.source)) reject('cost_source_missing', 'source', 'Supply the invoice, usage-ledger reference or reviewed forecast source.');
    if (!text(line.priceVersion)) reject('cost_version_missing', 'priceVersion', 'Record the cost policy or provider rate version.');
    if (!validDate(line.documentedAt)) reject('cost_date_missing', 'documentedAt', 'Record when the cost evidence was documented.');
    if (!valid || line.quantity === null || line.unitCostMicrosUsd === null) continue;
    const amount = BigInt(line.quantity) * BigInt(line.unitCostMicrosUsd);
    if (amount > MAX_SAFE || knownCost + amount > MAX_SAFE) { issue('cost_amount_too_large', path, 'Technical costs exceed the safe supported amount.'); continue; }
    knownCost += amount;
    audit.push({ ...line, amountMicrosUsd: Number(amount) });
  }
  if (!integer(input.fees.fixedCents)) issue('payment_fixed_fee_missing', 'fees.fixedCents', 'Document the fixed payment fee; do not infer it from a historical Stripe reference.');
  if (!integer(input.fees.variableBps) || input.fees.variableBps >= 10_000) issue('payment_variable_fee_missing', 'fees.variableBps', 'Document a payment percentage below 100%.');
  if (!text(input.fees.source)) issue('payment_fee_source_missing', 'fees.source', 'Document the payment-fee source and applicable payment method.');
  if (!integer(margin) || margin >= 10_000) issue('margin_policy_missing', 'targetGrossMarginBps', 'A valid target margin is pending; enter an explicitly sourced planning parameter.');
  if (!text(marginSource) || !text(marginVersion)) issue('margin_policy_source_missing', 'marginPolicySource', 'A pricing policy needs its source and version.');
  if (integer(margin) && integer(input.fees.variableBps) && margin + input.fees.variableBps >= 10_000) issue('invalid_margin_denominator', 'fees.variableBps', 'Margin plus payment percentage must be below 100%.');

  const knownCostMicrosUsd = Number(knownCost);
  const result: SaasPricingPreviewResult = {
    kind, currency: 'USD', status: 'pending_inputs', commercialActivation: 'not_enabled_by_preview', constructionEstimateIncluded: false,
    technicalCostCents: null, knownCostMicrosUsd, proposedChargeCents: null,
    expectedPaymentFeesMicrosUsd: null, expectedGrossProfitMicrosUsd: null,
    targetGrossMarginBps: margin, marginPolicySource: marginSource, marginPolicyVersion: marginVersion,
    containsForecast: Array.isArray(input.costs) && input.costs.some(line => line.basis === 'reviewed_forecast'),
    calculation: { formula: 'ceil((technical_cost_cents + fixed_fee_cents) * 10000 / (10000 - margin_bps - payment_fee_bps))', numerator: null, denominator: null, rounding: 'aggregate_micro_usd_to_cent_then_charge_up_to_cent' },
    audit, issues,
  };
  // Partial known costs are available in the audit but never represented as complete COGS.
  if (issues.some(entry => entry.path.startsWith('cost'))) return result;
  const costCents = (knownCost + MICRO_USD_PER_CENT - 1n) / MICRO_USD_PER_CENT;
  if (costCents > MAX_SAFE) { issue('cost_amount_too_large', 'costs', 'Technical costs exceed the supported amount.'); return result; }
  result.technicalCostCents = Number(costCents);
  if (costCents === 0n) { issue('zero_cost_policy_pending', 'costs', 'A zero-cost service price needs an explicit commercial policy; no free processing is assumed.'); return result; }
  if (issues.length || margin === null || input.fees.fixedCents === null || input.fees.variableBps === null) return result;
  const denominator = BigInt(10_000 - margin - input.fees.variableBps);
  const numerator = (costCents + BigInt(input.fees.fixedCents)) * 10_000n;
  const charge = (numerator + denominator - 1n) / denominator;
  if (charge > BigInt(MAX_CHARGE_CENTS)) { issue('price_amount_too_large', 'proposedChargeCents', 'The proposed price exceeds the supported amount.'); return result; }
  // Keep the existing per-project margin guardrail as the source of truth.
  const chargeCents = membership ? projectChargeCents(Number(costCents), input.fees.fixedCents, input.fees.variableBps, membership) : Number(charge);
  const paymentMicros = BigInt(chargeCents) * BigInt(input.fees.variableBps) + BigInt(input.fees.fixedCents) * MICRO_USD_PER_CENT;
  const profitMicros = BigInt(chargeCents) * MICRO_USD_PER_CENT - costCents * MICRO_USD_PER_CENT - paymentMicros;
  result.status = 'ready_for_review';
  result.proposedChargeCents = chargeCents;
  result.expectedPaymentFeesMicrosUsd = Number(paymentMicros);
  result.expectedGrossProfitMicrosUsd = Number(profitMicros);
  result.calculation.numerator = numerator.toString();
  result.calculation.denominator = denominator.toString();
  return result;
}

export function previewSaasPerDocumentPrice(input: SaasPerDocumentPricingInput): SaasPricingPreviewResult {
  const margin = PROJECT_MARGIN_BPS[input.membership] ?? null;
  return preview('per_document', input, margin, SAAS_PROJECT_MARGIN_POLICY.source, SAAS_PROJECT_MARGIN_POLICY.version, [], input.membership);
}

export function previewSaasMonthlyPrice(input: SaasMonthlyPricingInput): SaasPricingPreviewResult {
  const allocationIssues = input.costAllocation === 'membership_only' ? [] : [{ code: 'monthly_cost_allocation_pending', path: 'costAllocation', message: 'Separate membership operating costs from the project reads billed independently. Monthly pricing cannot assume unlimited processing.' }];
  return preview('monthly_membership', input, input.targetGrossMarginBps, input.marginPolicySource, input.marginPolicyVersion, allocationIssues);
}

/** Strict user-entered decimal parsing; blanks and invalid input stay unknown. */
export function parseSaasUsdMicros(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match || match[1] === undefined) return null;
  const amount = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  return amount <= MAX_SAFE ? Number(amount) : null;
}

export function parseSaasUsdCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match || match[1] === undefined) return null;
  const amount = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  return amount <= MAX_SAFE ? Number(amount) : null;
}

export function parseSaasPercentBps(value: string): number | null {
  const parsed = parseSaasUsdCents(value);
  return parsed !== null && parsed < 10_000 ? parsed : null;
}
