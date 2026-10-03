import { COST_SCALE, costDecimal, costMultiply, costNumber } from './cost-decimal.ts';

export const CATALOG_EXPRESSION_UNITS = ['ft', 'ft2', 'ft3', 'yd3', 'lb', 'ea', 'ratio', 'crew_hour', 'worker_hour', 'package', 'ft3/yd3'] as const;
export type CatalogExpressionUnit = typeof CATALOG_EXPRESSION_UNITS[number];
export type CatalogExpression = { op: 'input'; key: string; unit: CatalogExpressionUnit }
  | { op: 'constant'; value: number; unit: CatalogExpressionUnit; reason: string }
  | { op: 'multiply'; args: CatalogExpression[] };
export interface ConfirmedCatalogInput { value: number | null; unit: CatalogExpressionUnit; reviewed: boolean; sourceRef: string | null }
export interface CatalogExpressionResult {
  quantity: number | null; unit: CatalogExpressionUnit; pending: string[];
  trace: Array<{ op: CatalogExpression['op']; inputKey: string | null; value: number | null; unit: string; sourceRef: string | null }>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function isCatalogExpressionUnit(value: unknown): value is CatalogExpressionUnit { return typeof value === 'string' && CATALOG_EXPRESSION_UNITS.some(unit => unit === value); }
/** Parse only the three whitelisted AST operations. Formula strings are never executed. */
export function validateCatalogExpression(value: unknown): CatalogExpression {
  let nodes = 0;
  const parse = (node: unknown, depth: number): CatalogExpression => {
    if (++nodes > 200 || depth > 20 || !record(node)) throw new TypeError('Catalog expression exceeds structural limits.');
    if (node.op === 'input' && typeof node.key === 'string' && /^[a-z][a-z0-9_]{0,119}$/.test(node.key) && isCatalogExpressionUnit(node.unit)) return { op: 'input', key: node.key, unit: node.unit };
    if (node.op === 'constant' && typeof node.value === 'number' && isCatalogExpressionUnit(node.unit) && typeof node.reason === 'string' && node.reason.trim()) {
      costDecimal(node.value, 'expression constant');
      if (node.unit === 'ft3/yd3' && node.value !== 27) throw new TypeError('The exact cubic-yard conversion is 27 ft3/yd3.');
      if (node.unit !== 'ratio' && node.unit !== 'ft3/yd3') throw new TypeError('Physical dimensions must come from reviewed inputs, not arbitrary constants.');
      return { op: 'constant', value: node.value, unit: node.unit, reason: node.reason.trim() };
    }
    if (node.op === 'multiply' && Array.isArray(node.args) && node.args.length >= 2 && node.args.length <= 10) return { op: 'multiply', args: node.args.map(arg => parse(arg, depth + 1)) };
    throw new TypeError('Invalid catalog expression; input, constant and multiply are the supported operations.');
  };
  return parse(value, 0);
}
type Dimensions = [number, number, number, number, number, number, number];
const dimensions: Record<CatalogExpressionUnit, Dimensions> = {
  ft: [1, 0, 0, 0, 0, 0, 0], ft2: [2, 0, 0, 0, 0, 0, 0], ft3: [3, 0, 0, 0, 0, 0, 0], yd3: [0, 3, 0, 0, 0, 0, 0],
  lb: [0, 0, 1, 0, 0, 0, 0], ea: [0, 0, 0, 1, 0, 0, 0], ratio: [0, 0, 0, 0, 0, 0, 0],
  crew_hour: [0, 0, 0, 0, 1, 0, 0], worker_hour: [0, 0, 0, 0, 0, 1, 0], package: [0, 0, 0, 0, 0, 0, 1], 'ft3/yd3': [3, -3, 0, 0, 0, 0, 0],
};
export function validateCatalogExpressionDimensions(value: unknown, expectedUnit: CatalogExpressionUnit): CatalogExpression {
  const expression = validateCatalogExpression(value);
  const infer = (node: CatalogExpression): number[] => node.op === 'multiply'
    ? node.args.map(infer).reduce((sum, next) => sum.map((v, i) => v + next[i]!), [0, 0, 0, 0, 0, 0, 0]) : dimensions[node.unit];
  if (infer(expression).some((value, index) => value !== dimensions[expectedUnit][index])) throw new TypeError('Catalog expression dimension does not match the material measure unit.');
  return expression;
}
/** Every input is local to a component. Only the separately reviewed assembly quantity may be shared. */
export function evaluateCatalogExpression(value: unknown, expectedUnit: CatalogExpressionUnit, inputs: Readonly<Record<string, ConfirmedCatalogInput>>,
  assemblyQuantity: ConfirmedCatalogInput | null): CatalogExpressionResult {
  const expression = validateCatalogExpressionDimensions(value, expectedUnit), pending: string[] = [], trace: CatalogExpressionResult['trace'] = [];
  const evaluate = (node: CatalogExpression): bigint | null => {
    if (node.op === 'multiply') {
      const factors = node.args.map(evaluate);
      const result = factors.some(factor => factor === null) ? null : factors.reduce<bigint>((product, factor) => costMultiply(product, factor!), COST_SCALE);
      trace.push({ op: 'multiply', inputKey: null, value: result === null ? null : costNumber(result), unit: expectedUnit, sourceRef: null }); return result;
    }
    if (node.op === 'constant') { trace.push({ op: 'constant', inputKey: null, value: node.value, unit: node.unit, sourceRef: node.reason }); return costDecimal(node.value); }
    const supplied = node.key === 'assembly_quantity' ? assemblyQuantity : Object.hasOwn(inputs, node.key) ? inputs[node.key]! : null;
    let number: bigint | null = null;
    if (!supplied || supplied.value === null) pending.push(`${node.key}:input_missing`);
    else if (supplied.unit !== node.unit) pending.push(`${node.key}:input_unit_mismatch`);
    else if (!supplied.reviewed || !supplied.sourceRef?.trim()) pending.push(`${node.key}:input_review_required`);
    else number = costDecimal(supplied.value, node.key);
    trace.push({ op: 'input', inputKey: node.key, value: number === null ? null : costNumber(number), unit: node.unit, sourceRef: supplied?.sourceRef ?? null }); return number;
  };
  const quantity = evaluate(expression);
  return { quantity: quantity === null ? null : costNumber(quantity), unit: expectedUnit, pending: [...new Set(pending)], trace };
}
