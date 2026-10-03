import { isCanonicalUnit, type CanonicalUnit, type EstimateLineV2Input, type PriceProvenance, type V2CostCategory } from './takeoff-v2.ts';
import { COST_SCALE, costDecimal, costDivide, costMoney, costMultiply, costNumber, costPurchaseQuantity } from './cost-decimal.ts';

export const CONSTRUCTION_CATALOG_SCHEMA = 'roughbid-construction-catalog-v1';
export interface CatalogSpecificationSource {
  name: string; url: string | null; documentRef: string | null; effectiveDate: string | null; place: string | null;
}
export interface CatalogRate { amount: number | null; source: PriceProvenance | null; reviewed: boolean }
export interface ConstructionCatalogBase {
  id: string; name: string; unit: CanonicalUnit; specification: string; specificationSource: CatalogSpecificationSource | null; reviewed: boolean;
}
export interface ConstructionMaterial extends ConstructionCatalogBase {
  kind: 'material'; rate: CatalogRate;
  pack: { pricedUnit: CanonicalUnit | null; coverageQuantity: number | null; coverageUnit: CanonicalUnit | null;
    unitsPerPackage: number | null; minimumOrderPackages: number | null; orderIncrement: number | null; roundingRule: 'none' | 'round_up_increment' | null };
  wastePercent: number | null;
}
export interface ConstructionLabor extends ConstructionCatalogBase {
  kind: 'labor'; hourlyRate: CatalogRate; rateBasis: 'person' | 'crew' | null;
  productivity: { quantityPerHour: number | null; quantityUnit: CanonicalUnit | null; hourBasis: 'person' | 'crew' | null;
    crewSize: number | null; modifier: number | null; setupHours: number | null; cleanupHours: number | null; source: CatalogSpecificationSource | null; reviewed: boolean };
}
export interface EquipmentCostComponent {
  required: boolean | null; quantity: number | null; unit: CanonicalUnit | null; rate: CatalogRate;
}
export interface ConstructionEquipment extends ConstructionCatalogBase {
  kind: 'equipment'; costs: Record<'rental' | 'operator' | 'transport' | 'pickup' | 'fuel' | 'mobilization' | 'assemblyDismantling' | 'extraMeterHours' | 'fees' | 'tax', EquipmentCostComponent>;
  rentalPeriod: { quantity: number | null; unit: 'HR' | 'DAY' | 'WK' | 'MO' | null };
  /** No equipment selection or structural load inference is made by this calculator. */
  access: { required: boolean | null; reviewed: boolean; workingHeightFt: number | null; platformHeightFt: number | null;
    clearWidthIn: number | null; clearHeightIn: number | null; loadCapacityLb: number | null;
    groundAndFloorCapacityReviewed: boolean; indoorOutdoorReviewed: boolean; source: CatalogSpecificationSource | null };
  refundableDeposit: number | null;
}
export interface ConstructionService extends ConstructionCatalogBase {
  kind: 'service'; components: Array<{ id: string; itemId: string; quantityPerUnit: number | null; unit: CanonicalUnit }>;
}
export type ConstructionCatalogItem = ConstructionMaterial | ConstructionLabor | ConstructionEquipment | ConstructionService;
export interface ConstructionCatalog { schema: typeof CONSTRUCTION_CATALOG_SCHEMA; revision: string; items: ConstructionCatalogItem[] }
export interface CatalogQuantity { id: string; itemId: string; quantity: number | null; unit: CanonicalUnit; reviewed: boolean; sourceRef: string | null }
export interface CatalogEstimateContext { effectiveDate: string; place: string | null }
export interface CatalogFormula { expression: string; inputs: Record<string, number | string>; result: number; unit: CanonicalUnit | 'USD' }
export interface CatalogCostLine {
  id: string; itemId: string; description: string; category: V2CostCategory; quantity: number | null; unit: CanonicalUnit;
  cost: number | null; knownSubtotal: number; pending: string[]; formulas: CatalogFormula[]; priceSources: PriceProvenance[];
}
export interface CatalogCostResult {
  schema: 'roughbid-catalog-cost-v1'; catalogRevision: string; lines: CatalogCostLine[]; knownSubtotal: number; total: number | null;
  pending: string[]; releaseStatus: 'blocked' | 'cost_ready'; calculationVersion: 'decimal6-money-half-up-v1';
}
function date(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; }
function specification(source: CatalogSpecificationSource | null): boolean {
  return source !== null && Boolean(source.name.trim()) && Boolean(source.url || source.documentRef)
    && (source.effectiveDate === null || date(source.effectiveDate));
}
function usableRate(rate: CatalogRate, context: CatalogEstimateContext): string | null {
  if (rate.amount === null) return 'missing_price';
  costDecimal(rate.amount, 'rate');
  if (!rate.reviewed || !rate.source || !rate.source.sourceName.trim() || rate.source.sourceType === 'provisional_assumption') return 'price_source_review_required';
  if (!date(rate.source.effectiveDate) || rate.source.effectiveDate > context.effectiveDate
    || (rate.source.expiresAt !== null && (!date(rate.source.expiresAt) || rate.source.expiresAt < context.effectiveDate))) return 'price_date_invalid_or_expired';
  if (!context.place || rate.source.geography !== context.place) return 'price_place_mismatch';
  if (!Number.isFinite(rate.source.confidence) || rate.source.confidence < 0 || rate.source.confidence > 1) return 'price_confidence_invalid';
  return null;
}
export interface CatalogPurchaseInput { measure: number | null; wasteFraction: number | null; coveragePerPackage: number | null; minimumOrderPackages: number | null; orderIncrement: number | null }
/** Reviewed zero scope has no minimum purchase. Positive scope requires every explicit packaging input. */
export function calculateCatalogPurchase(input: CatalogPurchaseInput): { quantity: number | null; pending: string[] } {
  for (const [name, value] of Object.entries(input)) if (value !== null) costDecimal(value, name);
  if (input.measure === 0) return { quantity: 0, pending: [] };
  const pending = Object.entries(input).filter(([, value]) => value === null).map(([name]) => `${name}_pending`);
  if (pending.length) return { quantity: null, pending };
  if (input.wasteFraction! > 1) throw new RangeError('Waste fraction must not exceed one.');
  return { quantity: costNumber(costPurchaseQuantity(costMultiply(costDecimal(input.measure!), COST_SCALE + costDecimal(input.wasteFraction!)),
    costDecimal(input.coveragePerPackage!), costDecimal(input.orderIncrement!), costDecimal(input.minimumOrderPackages!))), pending: [] };
}
/** Extensible catalog: missing rates, production, waste, packaging or site constraints remain explicit null values. */
export function estimateCatalogCost(catalog: ConstructionCatalog, quantities: readonly CatalogQuantity[], context: CatalogEstimateContext): CatalogCostResult {
  if (catalog.schema !== CONSTRUCTION_CATALOG_SCHEMA || !catalog.revision || !date(context.effectiveDate)) throw new TypeError('Invalid construction catalog or costing date.');
  const items = new Map<string, ConstructionCatalogItem>(), lines: CatalogCostLine[] = [], topIds = new Set<string>();
  for (const item of catalog.items) {
    if (!item.id || items.has(item.id) || !isCanonicalUnit(item.unit) || !['service', 'material', 'labor', 'equipment'].includes(item.kind)) throw new TypeError('Catalog item identity, kind and canonical unit are required.');
    items.set(item.id, item);
  }
  const visit = (itemId: string, quantity: number | null, unit: CanonicalUnit, path: string, ancestry: Set<string>, reviewed: boolean, sourceRef: string | null): void => {
    const item = items.get(itemId), pending: string[] = [], formulas: CatalogFormula[] = [], priceSources: PriceProvenance[] = [];
    const category: V2CostCategory = item?.kind === 'labor' ? 'labor' : item?.kind === 'equipment' ? 'equipment' : item?.kind === 'service' ? 'other' : 'material';
    const line: CatalogCostLine = { id: path, itemId, description: item?.name ?? itemId, category, quantity, unit, cost: null, knownSubtotal: 0, pending, formulas, priceSources };
    if (!item) { pending.push('catalog_item_missing'); lines.push(line); return; }
    if (ancestry.has(itemId)) { pending.push('composition_cycle'); lines.push(line); return; }
    if (quantity === null) pending.push('quantity_missing'); else costDecimal(quantity, 'quantity');
    if (unit !== item.unit) pending.push('quantity_unit_mismatch');
    if (!reviewed || !sourceRef) pending.push('measurement_review_required');
    if (!item.reviewed || !specification(item.specificationSource)) pending.push('catalog_specification_review_required');
    if (item.kind === 'service') {
      if (!item.components.length) pending.push('composition_missing');
      if (pending.length) { lines.push(line); return; }
      const next = new Set(ancestry).add(itemId), componentIds = new Set<string>();
      for (const component of item.components) {
        if (!component.id || componentIds.has(component.id)) throw new TypeError('Composition component IDs must be unique.'); componentIds.add(component.id);
        if (!isCanonicalUnit(component.unit)) throw new TypeError('Composition component unit must be canonical.');
        const childQuantity = component.quantityPerUnit === null ? null : costNumber(costMultiply(costDecimal(quantity!), costDecimal(component.quantityPerUnit, 'quantityPerUnit')));
        visit(component.itemId, childQuantity, component.unit, `${path}/${component.id}`, next, reviewed, sourceRef);
      }
      return;
    }
    let known = 0n;
    const trace = (expression: string, inputs: CatalogFormula['inputs'], result: bigint, traceUnit: CatalogFormula['unit']) => formulas.push({ expression, inputs, result: traceUnit === 'USD' ? costMoney(result) : costNumber(result), unit: traceUnit });
    const rateCost = (rate: CatalogRate, amount: bigint, label: string) => {
      const reason = usableRate(rate, context); if (reason) { pending.push(`${label}:${reason}`); return; }
      const value = costMultiply(amount, costDecimal(rate.amount!)); known += value; priceSources.push(rate.source!);
      trace(`${label}_quantity × documented_unit_rate`, { quantity: costNumber(amount), unitRate: rate.amount! }, value, 'USD');
    };
    if (!pending.length && item.kind === 'material') {
      const pack = item.pack;
      if (item.wastePercent === null) pending.push('waste_pending'); else if (item.wastePercent > 100) throw new RangeError('Waste must not exceed 100 percent.');
      if (pack.pricedUnit === null || pack.coverageQuantity === null || pack.coverageUnit === null || pack.roundingRule === null || pack.orderIncrement === null || pack.minimumOrderPackages === null) pending.push('purchase_packaging_pending');
      if (pack.coverageUnit !== null && pack.coverageUnit !== unit) pending.push('coverage_unit_mismatch');
      if (!pending.length) {
        const raw = costDecimal(quantity!), waste = costDecimal(item.wastePercent!), required = costMultiply(raw, COST_SCALE + costDivide(waste, 100n * COST_SCALE));
        const coverage = costDecimal(pack.coverageQuantity!), increment = costDecimal(pack.orderIncrement!);
        if (!coverage || !increment) throw new RangeError('Coverage and order increment must be positive.');
        const minimum = costDecimal(pack.minimumOrderPackages!);
        if (pack.roundingRule === 'none' && minimum !== 0n) pending.push('minimum_requires_documented_purchase_rounding');
        const purchasing = pack.roundingRule === 'round_up_increment' ? costPurchaseQuantity(required, coverage, increment, minimum) : costDivide(required, coverage);
        line.quantity = costNumber(purchasing); line.unit = pack.pricedUnit!;
        trace('measured_quantity × (1 + waste_percent / 100)', { quantity: quantity!, wastePercent: item.wastePercent! }, required, unit);
        trace(pack.roundingRule === 'round_up_increment' ? 'zero_scope ? 0 : ceil(max(minimum_order_packages, required_coverage / coverage_per_priced_unit) / order_increment) × order_increment' : 'required_coverage / coverage_per_priced_unit',
          { requiredCoverage: costNumber(required), coveragePerPricedUnit: pack.coverageQuantity!, minimumOrderPackages: pack.minimumOrderPackages!, orderIncrement: pack.orderIncrement! }, purchasing, pack.pricedUnit!);
        rateCost(item.rate, purchasing, 'material');
      }
    }
    if (!pending.length && item.kind === 'labor') {
      const production = item.productivity;
      if (production.quantityPerHour === null || production.quantityUnit === null || production.hourBasis === null || production.modifier === null || production.setupHours === null || production.cleanupHours === null || item.rateBasis === null) pending.push('labor_productivity_pending');
      if (!production.reviewed || !specification(production.source)) pending.push('labor_productivity_source_review_required');
      if (production.quantityUnit !== null && production.quantityUnit !== unit) pending.push('productivity_unit_mismatch');
      if (production.hourBasis !== item.rateBasis && (production.crewSize === null || !Number.isInteger(production.crewSize) || production.crewSize <= 0)) pending.push('crew_size_pending');
      if (!pending.length) {
        const hours = costMultiply(costDivide(costDecimal(quantity!), costDecimal(production.quantityPerHour!)), costDecimal(production.modifier!)) + costDecimal(production.setupHours!) + costDecimal(production.cleanupHours!);
        const billedHours = production.hourBasis === item.rateBasis ? hours : production.hourBasis === 'crew' ? costMultiply(hours, costDecimal(production.crewSize!)) : costDivide(hours, costDecimal(production.crewSize!));
        trace('measured_quantity / documented_quantity_per_hour × productivity_modifier + setup_hours + cleanup_hours', { quantity: quantity!, quantityPerHour: production.quantityPerHour!, modifier: production.modifier!, setupHours: production.setupHours!, cleanupHours: production.cleanupHours! }, hours, 'HR');
        trace('convert documented productivity hour basis to documented wage basis', { productionBasis: production.hourBasis!, wageBasis: item.rateBasis!, crewSize: production.crewSize ?? 0 }, billedHours, 'HR');
        line.quantity = costNumber(billedHours); line.unit = 'HR'; rateCost(item.hourlyRate, billedHours, 'labor');
      }
    }
    if (!pending.length && item.kind === 'equipment') {
      if (item.access.required === null) pending.push('equipment_access_scope_pending');
      else if (item.access.required && (!item.access.reviewed || !item.access.groundAndFloorCapacityReviewed || !item.access.indoorOutdoorReviewed || !specification(item.access.source)
        || item.access.workingHeightFt === null || item.access.platformHeightFt === null || item.access.clearWidthIn === null || item.access.clearHeightIn === null || item.access.loadCapacityLb === null)) pending.push('equipment_site_and_access_review_required');
      for (const [name, component] of Object.entries(item.costs)) {
        if (component.required === false) continue;
        if (component.required === null) { pending.push(`${name}:scope_pending`); continue; }
        if (component.quantity === null || component.unit === null) { pending.push(`${name}:quantity_pending`); continue; }
        if (name === 'rental' && (item.rentalPeriod.quantity === null || item.rentalPeriod.unit === null || item.rentalPeriod.unit !== component.unit || item.rentalPeriod.quantity !== component.quantity)) { pending.push('rental:period_pending_or_mismatch'); continue; }
        const componentQuantity = costMultiply(costDecimal(quantity!), costDecimal(component.quantity));
        rateCost(component.rate, componentQuantity, name);
      }
    }
    line.knownSubtotal = costMoney(known); line.cost = pending.length ? null : line.knownSubtotal; lines.push(line);
  };
  for (const selected of quantities) {
    if (!selected.id || topIds.has(selected.id) || !isCanonicalUnit(selected.unit)) throw new TypeError('Selected quantity IDs must be unique and units canonical.'); topIds.add(selected.id);
    visit(selected.itemId, selected.quantity, selected.unit, selected.id, new Set(), selected.reviewed, selected.sourceRef);
  }
  const pending = lines.flatMap(line => line.pending.map(reason => `${line.id}:${reason}`));
  if (!quantities.length) pending.push('quantities_required');
  const knownSubtotal = costMoney(lines.reduce((sum, line) => sum + costDecimal(line.knownSubtotal), 0n));
  return { schema: 'roughbid-catalog-cost-v1', catalogRevision: catalog.revision, lines, knownSubtotal, total: pending.length ? null : knownSubtotal,
    pending, releaseStatus: pending.length ? 'blocked' : 'cost_ready', calculationVersion: 'decimal6-money-half-up-v1' };
}

/** Preserves category totals in the existing estimate calculator. Call only after the independent evidence/coverage approval gate. */
export function catalogCostToEstimateLines(result: CatalogCostResult): EstimateLineV2Input[] {
  if (result.releaseStatus !== 'cost_ready' || result.total === null || result.lines.some(line => line.cost === null || line.quantity === null)) throw new Error('Catalog costing is blocked; no final estimate lines can be emitted.');
  return result.lines.map(line => {
    const common: EstimateLineV2Input = { id: line.id, description: line.description, unit: line.unit, rawQuantity: line.quantity!, wastePercent: 0, ...(line.priceSources[0] ? { priceSource: line.priceSources[0] } : {}) };
    // Cost is already determined, packaged and sourced; avoid repeating rounding, waste or labor production.
    if (line.category === 'equipment') return { ...common, equipmentTotal: line.cost! };
    if (line.category === 'labor') return { ...common, laborTotal: line.cost! };
    if (line.category === 'material') return { ...common, materialDirectTotal: line.cost! };
    return { ...common, otherDirectTotal: line.cost! };
  });
}
