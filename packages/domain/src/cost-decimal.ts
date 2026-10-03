/** Decimal arithmetic shared by documented quotes and construction costs. Six decimal places; money rounds half up to cents. */
export const COST_SCALE = 1_000_000n;
export function costDecimal(value: number, name = 'value'): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000 || !/^\d+(?:\.\d{1,6})?$/.test(String(value))) throw new RangeError(`${name} must be a nonnegative decimal with at most six places.`);
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole!) * COST_SCALE + BigInt(fraction.padEnd(6, '0'));
}
export function costNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Construction cost exceeds the supported exact range.');
  return Number(value) / Number(COST_SCALE);
}
export function costMultiply(a: bigint, b: bigint): bigint { return (a * b + COST_SCALE / 2n) / COST_SCALE; }
export function costDivide(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('Construction divisor must be positive.');
  return (a * COST_SCALE + b / 2n) / b;
}
export function costMoney(value: bigint): number { return costNumber(((value + 5_000n) / 10_000n) * 10_000n); }
/** Ceil the rational coverage conversion once; do not round division before package rounding. */
export function costPurchaseQuantity(required: bigint, coverage: bigint, increment: bigint, minimum: bigint): bigint {
  if (required < 0n || minimum < 0n) throw new RangeError('Purchase demand and minimum must be nonnegative.');
  if (required === 0n) return 0n;
  if (coverage <= 0n || increment <= 0n) throw new RangeError('Coverage and purchase increment must be positive.');
  const rawNumerator = required * COST_SCALE, minimumNumerator = minimum * coverage;
  const numerator = rawNumerator > minimumNumerator ? rawNumerator : minimumNumerator, denominator = coverage * increment;
  return ((numerator + denominator - 1n) / denominator) * increment;
}
