/** RoughBid processing revenue, distinct from the contractor's construction estimate. */
export const PROJECT_MARGIN_BPS = { standard: 5000, starter: 4000, pro: 3500, team: 3000, enterprise: 2000 } as const;
export type ProjectMembership = keyof typeof PROJECT_MARGIN_BPS;

/**
 * Owner pricing rule (2026-09-24): charge per project is the measured project
 * cost, plus 30%, then multiplied by the membership factor.
 *
 *   charge = ceil(cost * 13_000 / 10_000 * factor)
 *
 * A bigger plan carries a lower factor, so the subscription pays part of each
 * project's work while a non-member pays full cost-plus:
 *
 *   no membership (standard)  2.00   50.0% implied margin
 *   Starter (cheapest plan)   1.85   45.9%
 *   Pro                       1.70   41.2%
 *   Team (priciest plan)      1.60   37.5%
 *
 * Every factor stays above that membership's floor in `projectChargeCents`.
 */
export const PROJECT_COST_UPLIFT_BPS = 13_000;
export const PROJECT_CHARGE_MULTIPLIER_BPS = {
  standard: 20_000, starter: 18_500, pro: 17_000, team: 16_000, enterprise: 16_000,
} as const satisfies Record<ProjectMembership, number>;

export function projectChargeMultiplierBps(membership: ProjectMembership): number {
  const multiplierBps = PROJECT_CHARGE_MULTIPLIER_BPS[membership];
  if (multiplierBps === undefined) throw new Error('Invalid membership');
  return multiplierBps;
}

export function projectCostPlusChargeCents(costCents: number, membership: ProjectMembership = 'standard'): number {
  if (!Number.isSafeInteger(costCents) || costCents <= 0) throw new Error('Invalid project cost');
  const numerator = BigInt(costCents) * BigInt(PROJECT_COST_UPLIFT_BPS) * BigInt(projectChargeMultiplierBps(membership));
  const denominator = 100_000_000n;
  const result = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(result) || result > 99_999_999) throw new Error('Project charge is too large');
  return result;
}

/**
 * Minimum-margin charge for the same cost: the floor the live price must never
 * fall below. Kept as the guardrail that a misconfigured uplift or multiplier
 * cannot quietly undercut.
 */
export function projectChargeCents(costCents: number, fixedFeeCents: number, feeBps: number, membership: ProjectMembership): number {
  if (![costCents, fixedFeeCents, feeBps].every(Number.isSafeInteger) || costCents <= 0 || fixedFeeCents < 0 || feeBps < 0) throw new Error('Invalid project cost or fee');
  const margin = PROJECT_MARGIN_BPS[membership];
  if (margin === undefined || margin + feeBps >= 10000) throw new Error('Invalid margin or payment fee');
  const numerator = (BigInt(costCents) + BigInt(fixedFeeCents)) * 10000n;
  const denominator = BigInt(10000 - margin - feeBps);
  const result = Number((numerator + denominator - 1n) / denominator);
  if (!Number.isSafeInteger(result) || result > 99_999_999) throw new Error('Project charge is too large');
  return result;
}
