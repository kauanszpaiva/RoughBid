import {
  previewSaasMonthlyPrice, previewSaasPerDocumentPrice, parseSaasPercentBps,
  parseSaasUsdCents, parseSaasUsdMicros,
  type SaasCostBasis, type SaasCostDriver, type SaasCostLine, type SaasPricingPreviewResult,
} from '../../../../../packages/domain/src/saas-pricing.ts';
import type { ProjectMembership } from '../../../../../packages/domain/src/project-charge.ts';

export { SAAS_PROJECT_MARGIN_POLICY } from '../../../../../packages/domain/src/saas-pricing.ts';
export type { SaasPricingPreviewResult, SaasCostBasis, SaasCostDriver, ProjectMembership };

export type SaasCostDraft = {
  id: string; label: string; driver: SaasCostDriver; unit: string; quantity: string;
  unitCostUsd: string; basis: SaasCostBasis; source: string; priceVersion: string; documentedDate: string;
};
export type SaasPricingDraft = {
  kind: 'per_document' | 'monthly_membership';
  membership: ProjectMembership;
  costs: SaasCostDraft[];
  coverageConfirmed: boolean;
  fixedPaymentUsd: string;
  paymentPercent: string;
  paymentSource: string;
  monthlyMarginPercent: string;
  monthlyMarginSource: string;
  monthlyMarginVersion: string;
  membershipAllocationConfirmed: boolean;
};

export function createSaasCostDraft(id: string): SaasCostDraft {
  return { id, label: '', driver: 'provider_calls', unit: 'call', quantity: '', unitCostUsd: '', basis: 'pending', source: '', priceVersion: '', documentedDate: '' };
}

export function createSaasPricingDraft(kind: SaasPricingDraft['kind']): SaasPricingDraft {
  return {
    kind, membership: 'standard', costs: [createSaasCostDraft(`${kind}-1`)], coverageConfirmed: false,
    fixedPaymentUsd: '', paymentPercent: '', paymentSource: '', monthlyMarginPercent: '',
    monthlyMarginSource: '', monthlyMarginVersion: '', membershipAllocationConfirmed: false,
  };
}

const wholeQuantity = (value: string): number | null => {
  if (!/^\d+$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : null;
};

/** Browser-only calculation: no credentials, network, usage reservation or payment activation. */
export function calculateSaasPricingDraft(draft: SaasPricingDraft): SaasPricingPreviewResult {
  const costs: SaasCostLine[] = draft.costs.map(row => ({
    id: row.id, label: row.label, driver: row.driver, unit: row.unit,
    quantity: wholeQuantity(row.quantity), unitCostMicrosUsd: parseSaasUsdMicros(row.unitCostUsd),
    basis: row.basis, source: row.source || null, priceVersion: row.priceVersion || null,
    documentedAt: /^\d{4}-\d{2}-\d{2}$/.test(row.documentedDate) ? `${row.documentedDate}T00:00:00.000Z` : null,
  }));
  const shared = {
    costs, costCoverageComplete: draft.coverageConfirmed,
    fees: { fixedCents: parseSaasUsdCents(draft.fixedPaymentUsd), variableBps: parseSaasPercentBps(draft.paymentPercent), source: draft.paymentSource || null },
  };
  return draft.kind === 'per_document'
    ? previewSaasPerDocumentPrice({ ...shared, membership: draft.membership })
    : previewSaasMonthlyPrice({ ...shared, targetGrossMarginBps: parseSaasPercentBps(draft.monthlyMarginPercent), marginPolicySource: draft.monthlyMarginSource || null, marginPolicyVersion: draft.monthlyMarginVersion || null, costAllocation: draft.membershipAllocationConfirmed ? 'membership_only' : 'undetermined' });
}

export function exportSaasPricingPreview(draft: SaasPricingDraft, result: SaasPricingPreviewResult): string {
  return JSON.stringify({ schema: 'roughbid-saas-pricing-preview-v1', commercialActivation: 'not_enabled_by_preview', draft, result }, null, 2);
}
