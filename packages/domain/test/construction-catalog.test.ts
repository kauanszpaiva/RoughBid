import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCatalogCost, catalogCostToEstimateLines, calculateCatalogPurchase, CONSTRUCTION_CATALOG_SCHEMA,
  type ConstructionCatalog, type ConstructionMaterial, type ConstructionLabor, type ConstructionEquipment, type ConstructionService } from '../src/construction-catalog.ts';
import { calculateEstimateV2, type PriceProvenance } from '../src/takeoff-v2.ts';

const source = { name: 'Reviewed supplier specification', url: null, documentRef: 'spec42', effectiveDate: '2026-10-02', place: 'US 02110' };
const price: PriceProvenance = { sourceType: 'project_quote', sourceName: 'Reviewed quote42', effectiveDate: '2026-10-02', expiresAt: '2026-10-02', geography: 'US 02110', vendor: 'Fixture supplier', sku: 'fixture', confidence: 1 };
const rate = (amount: number | null) => ({ amount, source: price, reviewed: true });
const material = (): ConstructionMaterial => ({ id: 'tile', kind: 'material', name: 'Documented tile fixture', unit: 'SF', specification: 'Fixture specification', specificationSource: source, reviewed: true,
  rate: rate(3.19), pack: { pricedUnit: 'EA', coverageQuantity: 0.43, coverageUnit: 'SF', unitsPerPackage: 25, minimumOrderPackages: 0, orderIncrement: 1, roundingRule: 'round_up_increment' }, wastePercent: 0 });
const labor = (): ConstructionLabor => ({ id: 'labor', kind: 'labor', name: 'Reviewed crew fixture', unit: 'SF', specification: 'Fixture labor scope', specificationSource: source, reviewed: true,
  hourlyRate: rate(20), rateBasis: 'person', productivity: { quantityPerHour: 10, quantityUnit: 'SF', hourBasis: 'crew', crewSize: 3, modifier: 1, setupHours: 0, cleanupHours: 0, source, reviewed: true } });
const equipment = (): ConstructionEquipment => {
  const skipped = () => ({ required: false, quantity: null, unit: null, rate: rate(null) });
  return { id: 'equipment', kind: 'equipment', name: 'Quoted equipment fixture', unit: 'EA', specification: 'Review exact model/terms', specificationSource: source, reviewed: true,
    costs: { rental: { required: true, quantity: 2, unit: 'DAY', rate: rate(100) }, operator: skipped(), transport: { required: true, quantity: 1, unit: 'LS', rate: rate(40) }, pickup: skipped(), fuel: skipped(), mobilization: skipped(), assemblyDismantling: skipped(), extraMeterHours: skipped(), fees: skipped(), tax: skipped() },
    rentalPeriod: { quantity: 2, unit: 'DAY' }, access: { required: false, reviewed: false, workingHeightFt: null, platformHeightFt: null, clearWidthIn: null, clearHeightIn: null, loadCapacityLb: null, groundAndFloorCapacityReviewed: false, indoorOutdoorReviewed: false, source: null }, refundableDeposit: 500 };
};
const catalog = (...items: ConstructionCatalog['items']): ConstructionCatalog => ({ schema: CONSTRUCTION_CATALOG_SCHEMA, revision: 'fixture-v1', items });
const selected = (itemId: string, quantity: number | null, unit: 'SF' | 'EA' = 'SF') => [{ id: 'measure42', itemId, quantity, unit, reviewed: true, sourceRef: 'reviewed-measure42' }];
const context = { effectiveDate: '2026-10-02', place: 'US 02110' };
test('coverage and explicit purchase increment determine units; box contents alone do not force a box', () => {
  const each = estimateCatalogCost(catalog(material()), selected('tile', 10), context);
  assert.equal(each.lines[0]!.quantity, 24); assert.equal(each.total, 76.56);
  const wholeBox = material(); wholeBox.pack.orderIncrement = 25;
  assert.equal(estimateCatalogCost(catalog(wholeBox), selected('tile', 10), context).total, 79.75);
  const withWaste = material(); withWaste.wastePercent = 10;
  assert.equal(estimateCatalogCost(catalog(withWaste), selected('tile', 10), context).lines[0]!.quantity, 26);
});
test('confirmed zero bypasses minimum; positive demand rounds the confirmed minimum up to the confirmed increment', () => {
  const input = { measure: 1, wasteFraction: 0, coveragePerPackage: 10, minimumOrderPackages: 3, orderIncrement: 2 };
  assert.equal(calculateCatalogPurchase(input).quantity, 4);
  assert.equal(calculateCatalogPurchase({ ...input, measure: 0 }).quantity, 0);
  assert.equal(calculateCatalogPurchase({ measure: 0, wasteFraction: null, coveragePerPackage: null, minimumOrderPackages: null, orderIncrement: null }).quantity, 0);
  assert.equal(calculateCatalogPurchase({ ...input, minimumOrderPackages: null }).quantity, null);
  assert.throws(() => calculateCatalogPurchase({ ...input, minimumOrderPackages: -1 }));
  assert.throws(() => calculateCatalogPurchase({ ...input, coveragePerPackage: 0 }));
});
test('missing rates, waste, packaging, review and price place/date keep final total null', () => {
  for (const mutate of [(item: ConstructionMaterial) => { item.rate.amount = null; }, (item: ConstructionMaterial) => { item.wastePercent = null; },
    (item: ConstructionMaterial) => { item.pack.orderIncrement = null; }, (item: ConstructionMaterial) => { item.reviewed = false; },
    (item: ConstructionMaterial) => { item.rate.source = { ...price, geography: 'US 50266' }; },
    (item: ConstructionMaterial) => { item.rate.source = { ...price, expiresAt: '2026-10-01' }; }]) {
    const item = material(); mutate(item); const result = estimateCatalogCost(catalog(item), selected('tile', 10), context);
    assert.equal(result.total, null); assert.equal(result.releaseStatus, 'blocked'); assert.ok(result.pending.length); assert.throws(() => catalogCostToEstimateLines(result), /blocked/);
  }
  assert.equal(estimateCatalogCost(catalog(material()), selected('tile', null), context).total, null);
});
test('crew productivity and person wage count each worker once without invented production', () => {
  const result = estimateCatalogCost(catalog(labor()), selected('labor', 100), context);
  assert.equal(result.lines[0]!.quantity, 30); assert.equal(result.total, 600);
  const sameBasis = labor(); sameBasis.rateBasis = 'crew'; sameBasis.hourlyRate = rate(60);
  assert.equal(estimateCatalogCost(catalog(sameBasis), selected('labor', 100), context).total, 600);
  const missing = labor(); missing.productivity.quantityPerHour = null;
  assert.equal(estimateCatalogCost(catalog(missing), selected('labor', 100), context).total, null);
});
test('equipment costs remain equipment, deposits excluded, required unknown charges/access block total', () => {
  const result = estimateCatalogCost(catalog(equipment()), selected('equipment', 1, 'EA'), context);
  assert.equal(result.total, 240); assert.equal(result.lines[0]!.category, 'equipment');
  const missing = equipment(); missing.costs.fuel.required = null;
  const partial = estimateCatalogCost(catalog(missing), selected('equipment', 1, 'EA'), context);
  assert.equal(partial.knownSubtotal, 240); assert.equal(partial.total, null);
  const access = equipment(); access.access.required = true;
  assert.equal(estimateCatalogCost(catalog(access), selected('equipment', 1, 'EA'), context).total, null);
  const wrongPeriod = equipment(); wrongPeriod.rentalPeriod.unit = 'WK';
  assert.equal(estimateCatalogCost(catalog(wrongPeriod), selected('equipment', 1, 'EA'), context).total, null);
});
test('service compositions reject cycles/missing coefficients instead of assuming one', () => {
  const service: ConstructionService = { id: 'service', kind: 'service', name: 'Assembly', unit: 'SF', specification: 'Fixture', specificationSource: source, reviewed: true,
    components: [{ id: 'tile', itemId: 'tile', quantityPerUnit: null, unit: 'SF' as const }] };
  assert.equal(estimateCatalogCost(catalog(service, material()), selected('service', 10), context).total, null);
  service.components = [{ id: 'loop', itemId: 'service', quantityPerUnit: 1, unit: 'SF' }];
  assert.match(estimateCatalogCost(catalog(service), selected('service', 10), context).pending.join(','), /composition_cycle/);
});
test('cost allocations preserve cents and categories in existing estimate calculator without synthetic rates/hours', () => {
  const result = estimateCatalogCost(catalog(material(), labor(), equipment()), [
    { ...selected('tile', 10)[0]!, id: 'm' }, { ...selected('labor', 100)[0]!, id: 'l' }, { ...selected('equipment', 1, 'EA')[0]!, id: 'e' }], context);
  const lines = catalogCostToEstimateLines(result);
  assert.equal(lines[0]!.materialDirectTotal, 76.56); assert.equal(lines[0]!.materialUnitRate, undefined);
  assert.equal(lines[1]!.laborTotal, 600); assert.equal(lines[1]!.laborProductionRate, undefined);
  const estimate = calculateEstimateV2({ lineItems: lines, generalConditions: 0, overheadPercent: 0, contingencies: [], profit: { method: 'markup', percent: 0 } });
  assert.deepEqual(estimate.categoryTotals, { material: 76.56, labor: 600, equipment: 240, subcontract: 0, other: 0 });
  assert.equal(estimate.directCost, result.total); assert.equal(estimate.lineItems[1]!.laborHours, 0);
});
