export * from './auth.ts';
export * from './workspace.ts';
export * from './calculation.ts';
export * from './billing.ts';

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

export type AccessWindow = {
  startsAt: Date;
  expiresAt: Date;
  requiresPaymentMethod: false;
};

export const ENTITLED_OPERATIONS = [
  'project:read',
  'project:write',
  'estimate:read',
  'estimate:write',
  'plan-file:read',
  'plan-file:write',
] as const;

export type EntitledOperation = (typeof ENTITLED_OPERATIONS)[number];

export type AccessEntitlement = {
  startsAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
};

export class EntitlementRequiredError extends Error {
  readonly code = 'ENTITLEMENT_REQUIRED';
  readonly operation: EntitledOperation;

  constructor(operation: EntitledOperation) {
    super(`An active entitlement is required for ${operation}.`);
    this.name = 'EntitlementRequiredError';
    this.operation = operation;
  }
}

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

export function createAccessWindow(startsAt: Date, durationDays: number): AccessWindow {
  if (Number.isNaN(startsAt.getTime())) {
    throw new TypeError('Access start date must be valid.');
  }
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 366) {
    throw new RangeError('Access duration must be between 1 and 366 days.');
  }
  const expiresAt = new Date(startsAt.getTime());
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);

  return {
    startsAt: new Date(startsAt.getTime()),
    expiresAt,
    requiresPaymentMethod: false,
  };
}

export function isAccessWindowActive(pass: AccessWindow, at: Date = new Date()): boolean {
  const timestamp = at.getTime();
  return timestamp >= pass.startsAt.getTime() && timestamp < pass.expiresAt.getTime();
}

export function hasActiveEntitlement(
  entitlements: readonly AccessEntitlement[],
  at: Date = new Date(),
): boolean {
  if (Number.isNaN(at.getTime())) throw new TypeError('Access check date must be valid.');
  const timestamp = at.getTime();
  return entitlements.some((entitlement) => (
    entitlement.revokedAt == null
    && timestamp >= entitlement.startsAt.getTime()
    && timestamp < entitlement.expiresAt.getTime()
  ));
}

export function assertEntitled(
  operation: EntitledOperation,
  entitlements: readonly AccessEntitlement[],
  at: Date = new Date(),
): void {
  if (!ENTITLED_OPERATIONS.includes(operation)) {
    throw new TypeError(`Unsupported entitled operation: ${operation as string}.`);
  }
  if (!hasActiveEntitlement(entitlements, at)) throw new EntitlementRequiredError(operation);
}
