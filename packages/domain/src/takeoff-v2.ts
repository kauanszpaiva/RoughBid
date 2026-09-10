export const UNIT_REGISTRY = {
  SF: { dimension: 'area', baseUnit: 'SF', factor: '1' },
  LF: { dimension: 'length', baseUnit: 'LF', factor: '1' },
  EA: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  CY: { dimension: 'volume', baseUnit: 'CF', factor: '27' },
  SY: { dimension: 'area', baseUnit: 'SF', factor: '9' },
  HR: { dimension: 'time', baseUnit: 'HR', factor: '1' },
  LS: { dimension: 'allowance', baseUnit: 'LS', factor: '1' },
  SQ: { dimension: 'area', baseUnit: 'SF', factor: '100' },
  TON: { dimension: 'mass', baseUnit: 'LB', factor: '2000' },
  LB: { dimension: 'mass', baseUnit: 'LB', factor: '1' },
  GAL: { dimension: 'volume_liquid', baseUnit: 'GAL', factor: '1' },
  SHEET: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  BAG: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  BOX: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  ROLL: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  PAIR: { dimension: 'count', baseUnit: 'EA', factor: '2' },
  SET: { dimension: 'count', baseUnit: 'EA', factor: '1' },
  MBF: { dimension: 'board_foot', baseUnit: 'BF', factor: '1000' },
  CF: { dimension: 'volume', baseUnit: 'CF', factor: '1' },
  CFM: { dimension: 'air_flow', baseUnit: 'CFM', factor: '1' },
  GPM: { dimension: 'liquid_flow', baseUnit: 'GPM', factor: '1' },
  KW: { dimension: 'power', baseUnit: 'KW', factor: '1' },
  AMP: { dimension: 'current', baseUnit: 'AMP', factor: '1' },
  DAY: { dimension: 'duration', baseUnit: 'DAY', factor: '1' },
  WK: { dimension: 'duration', baseUnit: 'DAY', factor: '7' },
  MO: { dimension: 'duration', baseUnit: 'DAY', factor: '30' },
} as const;

export type CanonicalUnit = keyof typeof UNIT_REGISTRY;
export type V2CostCategory = 'material' | 'labor' | 'equipment' | 'subcontract' | 'other';
export type PriceSourceType = 'project_quote' | 'workspace_price_book' | 'job_cost_actual' | 'vendor_catalog' | 'licensed_database' | 'regional_benchmark' | 'provisional_assumption';
export type RecommendationStatus = 'suggested' | 'accepted' | 'rejected' | 'overridden';

export interface PriceProvenance {
  sourceType: PriceSourceType;
  sourceName: string;
  effectiveDate: string;
  geography: string | null;
  vendor: string | null;
  sku: string | null;
  expiresAt: string | null;
  confidence: number;
}

export interface EstimateLineV2Input {
  id: string;
  description: string;
  unit: CanonicalUnit;
  rawQuantity: string | number;
  wastePercent: string | number;
  packageSize?: string | number;
  roundingRule?: 'none' | 'round_up_package';
  materialUnitRate?: string | number;
  materialFreight?: string | number;
  materialTaxPercent?: string | number;
  materialTaxable?: boolean;
  laborProductionRate?: string | number;
  laborHourlyCost?: string | number;
  laborProductivityModifier?: string | number;
  equipmentTotal?: string | number;
  subcontractTotal?: string | number;
  otherDirectTotal?: string | number;
  priceSource?: PriceProvenance;
}

export interface EstimateV2Input {
  lineItems: readonly EstimateLineV2Input[];
  generalConditions: string | number;
  overheadPercent: string | number;
  contingencies: readonly { id: string; label: string; percent: string | number }[];
  profit: { method: 'markup'; percent: string | number } | { method: 'gross_margin'; percent: string | number };
}

export interface CalculatedEstimateLineV2 extends EstimateLineV2Input {
  wasteQuantity: number;
  purchasingQuantity: number;
  laborHours: number;
  materialSubtotal: number;
  materialFreightTotal: number;
  materialTax: number;
  materialTotal: number;
  laborTotal: number;
  equipmentTotalCalculated: number;
  subcontractTotalCalculated: number;
  otherDirectTotalCalculated: number;
  directTotal: number;
  pricingStatus: 'priced' | 'unpriced' | 'provisional';
}

export interface EstimateV2Result {
  lineItems: CalculatedEstimateLineV2[];
  categoryTotals: Record<V2CostCategory, number>;
  directCost: number;
  generalConditions: number;
  overheadAmount: number;
  contingencyAmounts: Array<{ id: string; label: string; amount: number }>;
  contingencyTotal: number;
  costBeforeProfit: number;
  profitAmount: number;
  finalBid: number;
  grossProfit: number;
  grossMarginPercent: number;
  effectiveMarkupPercent: number;
  blockers: string[];
}

const SCALE = 1_000_000n;
const CENT = 10_000n;
const ZERO = 0n;

function decimal(value: string | number | undefined, field: string, fallback = ZERO): bigint {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`${field} must be a decimal.`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError(`${field} must be finite and non-negative.`);
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new RangeError(`${field} must be a non-negative decimal.`);
  const fraction = match[2] ?? '';
  if (fraction.length > 6) throw new RangeError(`${field} supports at most 6 decimal places.`);
  return BigInt(match[1]!) * SCALE + BigInt(fraction.padEnd(6, '0') || '0');
}

const mul = (a: bigint, b: bigint) => (a * b + SCALE / 2n) / SCALE;
const div = (a: bigint, b: bigint, field: string) => {
  if (b <= ZERO) throw new RangeError(`${field} must be greater than zero.`);
  return (a * SCALE + b / 2n) / b;
};
const percentOf = (amount: bigint, rate: bigint) => mul(amount, rate) / 100n;
const ceilToPackage = (quantity: bigint, size: bigint) => ((quantity + size - 1n) / size) * size;
const money = (v: bigint) => Number(((v + CENT / 2n) / CENT) * CENT) / Number(SCALE);
const quantity = (v: bigint) => Number(v) / Number(SCALE);
const ratioPercent = (num: bigint, den: bigint) => den === ZERO ? 0 : Number((num * 100n * SCALE) / den) / Number(SCALE);

export function isCanonicalUnit(value: string): value is CanonicalUnit {
  return Object.hasOwn(UNIT_REGISTRY, value);
}

export function calculateEstimateV2(input: EstimateV2Input): EstimateV2Result {
  if (!input || !Array.isArray(input.lineItems)) throw new TypeError('lineItems must be an array.');
  const totals: Record<V2CostCategory, bigint> = { material: ZERO, labor: ZERO, equipment: ZERO, subcontract: ZERO, other: ZERO };
  const ids = new Set<string>();
  const blockers: string[] = [];

  const lineItems = input.lineItems.map((line, index): CalculatedEstimateLineV2 => {
    if (!line || !line.id || ids.has(line.id)) throw new RangeError(`lineItems[${index}].id must be unique and non-empty.`);
    ids.add(line.id);
    if (!isCanonicalUnit(line.unit)) throw new RangeError(`lineItems[${index}].unit is not canonical.`);
    const raw = decimal(line.rawQuantity, `lineItems[${index}].rawQuantity`);
    const wasteRate = decimal(line.wastePercent, `lineItems[${index}].wastePercent`);
    if (wasteRate > 100n * SCALE) throw new RangeError(`lineItems[${index}].wastePercent must not exceed 100.`);
    const waste = percentOf(raw, wasteRate);
    const withWaste = raw + waste;
    const packageSize = decimal(line.packageSize, `lineItems[${index}].packageSize`, SCALE);
    const purchasing = line.roundingRule === 'round_up_package' ? ceilToPackage(withWaste, packageSize) : withWaste;

    const materialRate = decimal(line.materialUnitRate, `lineItems[${index}].materialUnitRate`);
    const freight = decimal(line.materialFreight, `lineItems[${index}].materialFreight`);
    const materialSubtotal = mul(purchasing, materialRate);
    const materialTax = line.materialTaxable ? percentOf(materialSubtotal + freight, decimal(line.materialTaxPercent, `lineItems[${index}].materialTaxPercent`)) : ZERO;
    const material = materialSubtotal + freight + materialTax;

    const production = line.laborProductionRate === undefined ? ZERO : decimal(line.laborProductionRate, `lineItems[${index}].laborProductionRate`);
    const hourly = decimal(line.laborHourlyCost, `lineItems[${index}].laborHourlyCost`);
    const productivity = decimal(line.laborProductivityModifier, `lineItems[${index}].laborProductivityModifier`, SCALE);
    const laborHours = production === ZERO ? ZERO : mul(div(raw, production, `lineItems[${index}].laborProductionRate`), productivity);
    const labor = mul(laborHours, hourly);
    const equipment = decimal(line.equipmentTotal, `lineItems[${index}].equipmentTotal`);
    const subcontract = decimal(line.subcontractTotal, `lineItems[${index}].subcontractTotal`);
    const other = decimal(line.otherDirectTotal, `lineItems[${index}].otherDirectTotal`);
    const direct = material + labor + equipment + subcontract + other;
    totals.material += material; totals.labor += labor; totals.equipment += equipment; totals.subcontract += subcontract; totals.other += other;

    const hasRate = materialRate > ZERO || hourly > ZERO || equipment > ZERO || subcontract > ZERO || other > ZERO;
    const pricingStatus = !hasRate ? 'unpriced' : line.priceSource?.sourceType === 'provisional_assumption' ? 'provisional' : 'priced';
    if (raw > ZERO && !hasRate) blockers.push(`${line.id}: quantity has no price source.`);
    if (hasRate && !line.priceSource) blockers.push(`${line.id}: applied price is missing provenance.`);

    return {
      ...line,
      wasteQuantity: quantity(waste), purchasingQuantity: quantity(purchasing), laborHours: quantity(laborHours),
      materialSubtotal: money(materialSubtotal), materialFreightTotal: money(freight), materialTax: money(materialTax), materialTotal: money(material),
      laborTotal: money(labor), equipmentTotalCalculated: money(equipment), subcontractTotalCalculated: money(subcontract),
      otherDirectTotalCalculated: money(other), directTotal: money(direct), pricingStatus,
    };
  });

  const direct = Object.values(totals).reduce((sum, value) => sum + value, ZERO);
  const generalConditions = decimal(input.generalConditions, 'generalConditions');
  const overhead = percentOf(direct + generalConditions, decimal(input.overheadPercent, 'overheadPercent'));
  const contingencyBase = direct + generalConditions + overhead;
  const contingencyAmounts = input.contingencies.map((entry, index) => ({
    id: entry.id,
    label: entry.label,
    raw: percentOf(contingencyBase, decimal(entry.percent, `contingencies[${index}].percent`)),
  }));
  const contingencyTotalRaw = contingencyAmounts.reduce((sum, entry) => sum + entry.raw, ZERO);
  const costBeforeProfit = contingencyBase + contingencyTotalRaw;
  const profitRate = decimal(input.profit.percent, 'profit.percent');
  let profitAmount: bigint;
  if (input.profit.method === 'gross_margin') {
    if (profitRate >= 100n * SCALE) throw new RangeError('Gross margin must be less than 100 percent.');
    const final = div(mul(costBeforeProfit, 100n * SCALE), 100n * SCALE - profitRate, 'gross margin denominator');
    profitAmount = final - costBeforeProfit;
  } else {
    profitAmount = percentOf(costBeforeProfit, profitRate);
  }
  const finalBid = costBeforeProfit + profitAmount;

  return {
    lineItems,
    categoryTotals: { material: money(totals.material), labor: money(totals.labor), equipment: money(totals.equipment), subcontract: money(totals.subcontract), other: money(totals.other) },
    directCost: money(direct), generalConditions: money(generalConditions), overheadAmount: money(overhead),
    contingencyAmounts: contingencyAmounts.map(({ id, label, raw }) => ({ id, label, amount: money(raw) })),
    contingencyTotal: money(contingencyTotalRaw), costBeforeProfit: money(costBeforeProfit), profitAmount: money(profitAmount),
    finalBid: money(finalBid), grossProfit: money(profitAmount), grossMarginPercent: ratioPercent(profitAmount, finalBid),
    effectiveMarkupPercent: ratioPercent(profitAmount, costBeforeProfit), blockers,
  };
}
