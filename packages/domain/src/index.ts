export type EstimateInput = {
  materialCost: number;
  laborCost: number;
  equipmentCost: number;
  otherCost: number;
  overheadPercent: number;
  markupPercent: number;
};

export type EstimateResult = {
  directCost: number;
  overheadAmount: number;
  costWithOverhead: number;
  markupAmount: number;
  finalPrice: number;
  grossMarginPercent: number;
};

export type ClassPassWindow = {
  startsAt: Date;
  expiresAt: Date;
  requiresPaymentMethod: false;
};

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateEstimate(input: EstimateInput): EstimateResult {
  const numericValues = Object.values(input);
  if (numericValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Estimate values must be finite, non-negative numbers.');
  }

  const directCost = cents(
    input.materialCost + input.laborCost + input.equipmentCost + input.otherCost,
  );
  const overheadAmount = cents(directCost * (input.overheadPercent / 100));
  const costWithOverhead = cents(directCost + overheadAmount);
  const markupAmount = cents(costWithOverhead * (input.markupPercent / 100));
  const finalPrice = cents(costWithOverhead + markupAmount);
  const grossMarginPercent = finalPrice === 0
    ? 0
    : ((finalPrice - costWithOverhead) / finalPrice) * 100;

  return {
    directCost,
    overheadAmount,
    costWithOverhead,
    markupAmount,
    finalPrice,
    grossMarginPercent,
  };
}

export function createClassPassWindow(startsAt: Date): ClassPassWindow {
  if (Number.isNaN(startsAt.getTime())) {
    throw new TypeError('Class Pass start date must be valid.');
  }
  const expiresAt = new Date(startsAt.getTime());
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 60);

  return {
    startsAt: new Date(startsAt.getTime()),
    expiresAt,
    requiresPaymentMethod: false,
  };
}

export function isClassPassActive(pass: ClassPassWindow, at: Date = new Date()): boolean {
  const timestamp = at.getTime();
  return timestamp >= pass.startsAt.getTime() && timestamp < pass.expiresAt.getTime();
}
