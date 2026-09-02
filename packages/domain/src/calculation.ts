export type DecimalInput = number | string;

export type CostCategory = 'material' | 'labor' | 'equipment' | 'other';

export type CalculationLineItem = {
  id: string;
  category: CostCategory;
  quantity: DecimalInput;
  unitRate: DecimalInput;
};

export type ProjectCalculationInput = {
  lineItems: readonly CalculationLineItem[];
  overheadPercent: DecimalInput;
  markupPercent: DecimalInput;
};

export type CalculatedLineItem = CalculationLineItem & { unitCost: number };

export type ProjectCalculationResult = {
  lineItems: CalculatedLineItem[];
  categoryTotals: Record<CostCategory, number>;
  directCost: number;
  overheadAmount: number;
  costWithOverhead: number;
  markupAmount: number;
  finalPrice: number;
  grossMarginAmount: number;
  grossMarginPercent: number;
  effectiveMarkupPercent: number;
};

// Six fixed decimal places retain sub-cent unit-rate precision while all public
// currency totals are rounded, half-up, to cents. No arithmetic uses IEEE floats.
const SCALE = 1_000_000n;
const CENT = 10_000n;

function decimal(value: DecimalInput, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError(`${field} must be a number or decimal string.`);
  }
  const text = typeof value === 'number' ? String(value) : value.trim();
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite and non-negative.`);
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`${field} must be a non-negative decimal.`);
  const fraction = match[2] ?? '';
  if (fraction.length > 6) throw new RangeError(`${field} supports at most 6 decimal places.`);
  return BigInt(match[1]!) * SCALE + BigInt(fraction.padEnd(6, '0') || '0');
}

const multiply = (left: bigint, right: bigint) => (left * right + SCALE / 2n) / SCALE;
const roundCents = (value: bigint) => ((value + CENT / 2n) / CENT) * CENT;
const money = (value: bigint) => Number(roundCents(value)) / Number(SCALE);
const percent = (numerator: bigint, denominator: bigint) => denominator === 0n
  ? 0
  : Number((numerator * 100n * 1_000_000n) / denominator) / 1_000_000;

/** Deterministic, fixed-point construction estimate calculation. */
export function calculateProject(input: ProjectCalculationInput): ProjectCalculationResult {
  if (!input || !Array.isArray(input.lineItems)) throw new TypeError('lineItems must be an array.');
  const overheadRate = decimal(input.overheadPercent, 'overheadPercent');
  const markupRate = decimal(input.markupPercent, 'markupPercent');
  const rawTotals: Record<CostCategory, bigint> = {
    material: 0n, labor: 0n, equipment: 0n, other: 0n,
  };
  const ids = new Set<string>();
  const lineItems = input.lineItems.map((line, index) => {
    if (!line || typeof line.id !== 'string' || !line.id || ids.has(line.id)) {
      throw new RangeError(`lineItems[${index}].id must be a unique, non-empty string.`);
    }
    ids.add(line.id);
    if (!Object.hasOwn(rawTotals, line.category)) throw new RangeError(`lineItems[${index}].category is invalid.`);
    const total = multiply(
      decimal(line.quantity, `lineItems[${index}].quantity`),
      decimal(line.unitRate, `lineItems[${index}].unitRate`),
    );
    rawTotals[line.category] += total;
    return { ...line, unitCost: money(total) };
  });
  const direct = Object.values(rawTotals).reduce((sum, value) => sum + value, 0n);
  const overhead = multiply(direct, overheadRate) / 100n;
  const withOverhead = direct + overhead;
  const markup = multiply(withOverhead, markupRate) / 100n;
  const final = withOverhead + markup;

  return {
    lineItems,
    categoryTotals: {
      material: money(rawTotals.material), labor: money(rawTotals.labor),
      equipment: money(rawTotals.equipment), other: money(rawTotals.other),
    },
    directCost: money(direct),
    overheadAmount: money(overhead),
    costWithOverhead: money(withOverhead),
    markupAmount: money(markup),
    finalPrice: money(final),
    grossMarginAmount: money(final - withOverhead),
    grossMarginPercent: percent(final - withOverhead, final),
    effectiveMarkupPercent: percent(final - withOverhead, withOverhead),
  };
}
