/** RoughBid processing revenue, distinct from the contractor's construction estimate. */
export const PROJECT_MARGIN_BPS = { standard: 5000, starter: 4000, pro: 3500, team: 3000, enterprise: 2000 } as const;
export type ProjectMembership = keyof typeof PROJECT_MARGIN_BPS;

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
