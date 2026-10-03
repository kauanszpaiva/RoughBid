import type { FullTakeoffApprovalProfile, FullTakeoffSpendInput } from '../services/api';

export function fullTakeoffSpendInput(profile: FullTakeoffApprovalProfile | null,
  amounts: Record<string, string>, confirmed: boolean): FullTakeoffSpendInput | null {
  if (!profile || !profile.providers.length || !confirmed) return null;
  const budgetsUsd: Record<string, number> = {};
  for (const provider of profile.providers) {
    const raw = amounts[provider.provider]?.trim();
    if (!raw || !/^\d+(?:\.\d{1,6})?$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < provider.minimumUsd || value > provider.maximumUsd) return null;
    budgetsUsd[provider.provider] = value;
  }
  return { confirmed: true, policyId: profile.policyId, budgetsUsd };
}
