export const ROUGHBID_TRIAL_CREDITS = 2;
export const TRIAL_COGS_SOFT_CAP_USD = 0.8;
export const TRIAL_COGS_HARD_CAP_USD = 1;
export const TARGET_PROJECT_COGS_USD = 0.75;
export const PROJECT_COGS_REVIEW_CAP_USD = 0.9;
export const MINIMUM_GROSS_MARGIN_PERCENT = 50;
export const STRIPE_PERCENT_FEE = 0.029;
export const STRIPE_FIXED_FEE_USD = 0.3;
export const CHEAP_MODEL_PROJECT_BUDGET_USD = 0.45;
export const EXPENSIVE_MODEL_REVIEW_BUDGET_USD = 0.3;

export type RoughBidPlanId = 'starter' | 'pro' | 'team';
export type RoughBidProjectSizeId = 'small' | 'standard' | 'large' | 'complex';
export type RoughBidMarketplaceFeedId =
  | 'new_england_codes'
  | 'regional_material_prices'
  | 'labor_benchmarks'
  | 'supplier_import';

export type RoughBidCommercialPlan = {
  id: RoughBidPlanId;
  name: string;
  kind: 'subscription';
  priceUsd: number;
  projectDiscountPercent: number;
  billingInterval: 'one_time' | 'month';
};

export type RoughBidProjectSizePricing = {
  id: RoughBidProjectSizeId;
  name: string;
  basePriceUsd: number;
  targetCogsUsd: number;
  reviewCapUsd: number;
  maxPdfMb: number;
  maxPlanPages: number;
  aiGenerations: number;
  examples: string[];
};

export type RoughBidPlanLimits = {
  activeProjects: number;
  seats: number;
  maxPdfMb: number;
  aiGenerationsPerProject: number;
  clientProposalLinksPerMonth: number;
  marketplaceFeedsIncluded: RoughBidMarketplaceFeedId[];
};

export type RoughBidMarketplaceFeed = {
  id: RoughBidMarketplaceFeedId;
  name: string;
  priceUsd: number;
  billingInterval: 'month';
  includedRegions: string[];
  royaltyOrDataCogsUsd: number;
};

export const ROUGHBID_COMMERCIAL_PLANS: Record<RoughBidPlanId, RoughBidCommercialPlan> = {
  starter: {
    id: 'starter',
    name: 'Starter',
    kind: 'subscription',
    priceUsd: 9,
    projectDiscountPercent: 10,
    billingInterval: 'month',
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    kind: 'subscription',
    priceUsd: 29,
    projectDiscountPercent: 25,
    billingInterval: 'month',
  },
  team: {
    id: 'team',
    name: 'Team',
    kind: 'subscription',
    priceUsd: 79,
    projectDiscountPercent: 40,
    billingInterval: 'month',
  },
};

export const ROUGHBID_PROJECT_SIZE_PRICES: Record<RoughBidProjectSizeId, RoughBidProjectSizePricing> = {
  small: {
    id: 'small',
    name: 'Small Repair / Simple Remodel',
    basePriceUsd: 7,
    targetCogsUsd: 0.75,
    reviewCapUsd: 0.9,
    maxPdfMb: 25,
    maxPlanPages: 8,
    aiGenerations: 3,
    examples: ['bath refresh', 'small deck repair', 'single-room finish update'],
  },
  standard: {
    id: 'standard',
    name: 'Standard Remodel',
    basePriceUsd: 15,
    targetCogsUsd: 1.25,
    reviewCapUsd: 1.5,
    maxPdfMb: 35,
    maxPlanPages: 20,
    aiGenerations: 4,
    examples: ['kitchen remodel', 'basement finish', 'small addition'],
  },
  large: {
    id: 'large',
    name: 'Large Residential Project',
    basePriceUsd: 29,
    targetCogsUsd: 2.5,
    reviewCapUsd: 3,
    maxPdfMb: 60,
    maxPlanPages: 50,
    aiGenerations: 6,
    examples: ['whole-home remodel', 'multi-room addition', 'large deck and exterior package'],
  },
  complex: {
    id: 'complex',
    name: 'Complex / Light Commercial',
    basePriceUsd: 49,
    targetCogsUsd: 5,
    reviewCapUsd: 6,
    maxPdfMb: 100,
    maxPlanPages: 100,
    aiGenerations: 8,
    examples: ['small commercial fit-out', 'multi-trade renovation', 'dense plan set'],
  },
};

export const ROUGHBID_PLAN_LIMITS: Record<RoughBidPlanId, RoughBidPlanLimits> = {
  starter: {
    activeProjects: 5,
    seats: 1,
    maxPdfMb: 25,
    aiGenerationsPerProject: 3,
    clientProposalLinksPerMonth: 25,
    marketplaceFeedsIncluded: ['new_england_codes'],
  },
  pro: {
    activeProjects: 20,
    seats: 3,
    maxPdfMb: 50,
    aiGenerationsPerProject: 5,
    clientProposalLinksPerMonth: 100,
    marketplaceFeedsIncluded: ['new_england_codes', 'regional_material_prices'],
  },
  team: {
    activeProjects: 80,
    seats: 10,
    maxPdfMb: 75,
    aiGenerationsPerProject: 8,
    clientProposalLinksPerMonth: 400,
    marketplaceFeedsIncluded: ['new_england_codes', 'regional_material_prices', 'labor_benchmarks'],
  },
};

export const ROUGHBID_MARKETPLACE_FEEDS: Record<RoughBidMarketplaceFeedId, RoughBidMarketplaceFeed> = {
  new_england_codes: {
    id: 'new_england_codes',
    name: 'New England Code Assistant',
    priceUsd: 9,
    billingInterval: 'month',
    includedRegions: ['CT', 'MA', 'ME', 'NH', 'RI', 'VT'],
    royaltyOrDataCogsUsd: 1,
  },
  regional_material_prices: {
    id: 'regional_material_prices',
    name: 'Regional Material Price Tables',
    priceUsd: 19,
    billingInterval: 'month',
    includedRegions: ['CT', 'MA', 'ME', 'NH', 'RI', 'VT'],
    royaltyOrDataCogsUsd: 3,
  },
  labor_benchmarks: {
    id: 'labor_benchmarks',
    name: 'Local Labor Benchmarks',
    priceUsd: 29,
    billingInterval: 'month',
    includedRegions: ['CT', 'MA', 'ME', 'NH', 'RI', 'VT'],
    royaltyOrDataCogsUsd: 5,
  },
  supplier_import: {
    id: 'supplier_import',
    name: 'Supplier Price Import',
    priceUsd: 49,
    billingInterval: 'month',
    includedRegions: ['workspace'],
    royaltyOrDataCogsUsd: 8,
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

export function estimateStripeCardFee(revenueUsd: number): number {
  assertMoney(revenueUsd, 'Revenue');
  return revenueUsd === 0 ? 0 : money(revenueUsd * STRIPE_PERCENT_FEE + STRIPE_FIXED_FEE_USD);
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

export function calculateProjectUnitEconomics(revenueUsd: number, cogsUsd = TARGET_PROJECT_COGS_USD): UnitEconomicsResult {
  return calculateUnitEconomics({
    revenueUsd,
    variableCogsUsd: cogsUsd,
    paymentFeeUsd: estimateStripeCardFee(revenueUsd),
  });
}

export function calculateAllInProcessingPrice(
  allInCostUsd: number,
  membershipTier?: RoughBidPlanId | null,
): {
  bufferedCostUsd: number;
  markupPercent: number;
  finalPriceUsd: number;
  finalPriceCents: number;
} {
  assertMoney(allInCostUsd, 'All-in cost');
  const bufferedCostUsd = money(allInCostUsd * 1.30);
  let markupPercent = 50;
  if (membershipTier === 'starter') markupPercent = 40;
  else if (membershipTier === 'pro') markupPercent = 33;
  else if (membershipTier === 'team') markupPercent = 25;

  const rawFinalPrice = bufferedCostUsd * (1 + markupPercent / 100);
  const finalPriceCents = Math.round((rawFinalPrice + Number.EPSILON) * 100);
  const finalPriceUsd = finalPriceCents / 100;

  return {
    bufferedCostUsd,
    markupPercent,
    finalPriceUsd,
    finalPriceCents,
  };
}

export function projectPriceForSize(size: RoughBidProjectSizePricing, subscriptionPlan?: RoughBidCommercialPlan | null): number {
  const discount = subscriptionPlan ? subscriptionPlan.projectDiscountPercent / 100 : 0;
  return money(size.basePriceUsd * (1 - discount));
}

export function calculateSizedProjectUnitEconomics(size: RoughBidProjectSizePricing, subscriptionPlan?: RoughBidCommercialPlan | null): UnitEconomicsResult {
  const revenueUsd = projectPriceForSize(size, subscriptionPlan);
  return calculateUnitEconomics({
    revenueUsd,
    variableCogsUsd: size.targetCogsUsd,
    paymentFeeUsd: estimateStripeCardFee(revenueUsd),
  });
}

export function assertTrialCogsAllowed(spendToDateUsd: number, nextOperationCostUsd: number): void {
  assertMoney(spendToDateUsd, 'Trial spend to date');
  assertMoney(nextOperationCostUsd, 'Next operation cost');
  if (money(spendToDateUsd + nextOperationCostUsd) >= TRIAL_COGS_HARD_CAP_USD) {
    throw new RangeError('Trial COGS hard cap would be reached.');
  }
}

export function subscriptionProjectDiscountPercent(subscriptionPlan: RoughBidCommercialPlan): number {
  if (subscriptionPlan.kind !== 'subscription') {
    throw new TypeError('A subscription plan is required.');
  }
  return subscriptionPlan.projectDiscountPercent;
}

export function marketplaceFeedEconomics(feed: RoughBidMarketplaceFeed): UnitEconomicsResult {
  return calculateUnitEconomics({
    revenueUsd: feed.priceUsd,
    variableCogsUsd: feed.royaltyOrDataCogsUsd,
    paymentFeeUsd: estimateStripeCardFee(feed.priceUsd),
  });
}
