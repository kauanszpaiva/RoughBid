export const ROUGHBID_TRIAL_CREDITS = 2;
export const TRIAL_COGS_SOFT_CAP_USD = 0.8;
export const TRIAL_COGS_HARD_CAP_USD = 1;
export const TARGET_PROJECT_COGS_USD = 0.75;
export const PROJECT_COGS_REVIEW_CAP_USD = 0.9;
export const MINIMUM_GROSS_MARGIN_PERCENT = 50;

export type RoughBidPlanId = 'credit_1' | 'credit_5' | 'credit_20' | 'starter' | 'pro' | 'team';

export type RoughBidCommercialPlan = {
  id: RoughBidPlanId;
  name: string;
  kind: 'credit_pack' | 'subscription';
  priceUsd: number;
  includedProjectCredits: number;
  extraProjectPriceUsd: number | null;
  billingInterval: 'one_time' | 'month';
};

export const ROUGHBID_COMMERCIAL_PLANS: Record<RoughBidPlanId, RoughBidCommercialPlan> = {
  credit_1: {
    id: 'credit_1',
    name: '1 Project Credit',
    kind: 'credit_pack',
    priceUsd: 7,
    includedProjectCredits: 1,
    extraProjectPriceUsd: null,
    billingInterval: 'one_time',
  },
  credit_5: {
    id: 'credit_5',
    name: '5 Project Credits',
    kind: 'credit_pack',
    priceUsd: 25,
    includedProjectCredits: 5,
    extraProjectPriceUsd: null,
    billingInterval: 'one_time',
  },
  credit_20: {
    id: 'credit_20',
    name: '20 Project Credits',
    kind: 'credit_pack',
    priceUsd: 80,
    includedProjectCredits: 20,
    extraProjectPriceUsd: null,
    billingInterval: 'one_time',
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    kind: 'subscription',
    priceUsd: 19,
    includedProjectCredits: 5,
    extraProjectPriceUsd: 4,
    billingInterval: 'month',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    kind: 'subscription',
    priceUsd: 49,
    includedProjectCredits: 20,
    extraProjectPriceUsd: 3,
    billingInterval: 'month',
  },
  team: {
    id: 'team',
    name: 'Team',
    kind: 'subscription',
    priceUsd: 149,
    includedProjectCredits: 80,
    extraProjectPriceUsd: 2.5,
    billingInterval: 'month',
  },
};

export type UnitEconomicsInput = {
  revenueUsd: number;
  variableCogsUsd: number;
  paymentFeeUsd?: number;
  marketplaceRoyaltyUsd?: number;
};

export type UnitEconomicsResult = {
  grossProfitUsd: number;
  grossMarginPercent: number;
  meetsMinimumMargin: boolean;
};

const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function assertMoney(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite non-negative amount.`);
}

export function calculateUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  assertMoney(input.revenueUsd, 'Revenue');
  assertMoney(input.variableCogsUsd, 'Variable COGS');
  assertMoney(input.paymentFeeUsd ?? 0, 'Payment fee');
  assertMoney(input.marketplaceRoyaltyUsd ?? 0, 'Marketplace royalty');
  const grossProfitUsd = money(
    input.revenueUsd - input.variableCogsUsd - (input.paymentFeeUsd ?? 0) - (input.marketplaceRoyaltyUsd ?? 0),
  );
  const grossMarginPercent = input.revenueUsd === 0 ? 0 : (grossProfitUsd / input.revenueUsd) * 100;
  return {
    grossProfitUsd,
    grossMarginPercent,
    meetsMinimumMargin: grossMarginPercent >= MINIMUM_GROSS_MARGIN_PERCENT,
  };
}

export function assertTrialCogsAllowed(spendToDateUsd: number, nextOperationCostUsd: number): void {
  assertMoney(spendToDateUsd, 'Trial spend to date');
  assertMoney(nextOperationCostUsd, 'Next operation cost');
  if (money(spendToDateUsd + nextOperationCostUsd) >= TRIAL_COGS_HARD_CAP_USD) {
    throw new RangeError('Trial COGS hard cap would be reached.');
  }
}

export function projectCreditUnitPrice(plan: RoughBidCommercialPlan): number {
  return money(plan.priceUsd / plan.includedProjectCredits);
}

export function subscriptionProjectDiscountPercent(subscriptionPlan: RoughBidCommercialPlan, referenceCreditPack = ROUGHBID_COMMERCIAL_PLANS.credit_1): number {
  if (subscriptionPlan.kind !== 'subscription' || subscriptionPlan.extraProjectPriceUsd == null) {
    throw new TypeError('A subscription plan with extra project pricing is required.');
  }
  const referencePrice = projectCreditUnitPrice(referenceCreditPack);
  return ((referencePrice - subscriptionPlan.extraProjectPriceUsd) / referencePrice) * 100;
}
