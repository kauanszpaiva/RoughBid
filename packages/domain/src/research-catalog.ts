import { CONSTRUCTION_CATALOG_SCHEMA, type CatalogQuantity, type CatalogSpecificationSource, type ConstructionCatalog, type ConstructionEquipment, type ConstructionCatalogItem } from './construction-catalog.ts';
import { evaluateCatalogExpression, isCatalogExpressionUnit, validateCatalogExpressionDimensions, type CatalogExpression, type CatalogExpressionResult, type CatalogExpressionUnit, type ConfirmedCatalogInput } from './catalog-expressions.ts';
import type { CanonicalUnit } from './takeoff-v2.ts';

export interface ResearchCatalogMaterial { id: string; name: string; unit: CatalogExpressionUnit; expression: CatalogExpression; active: boolean | null; supplierQuoteId: string | null }
export interface ResearchCatalogAssembly {
  id: string; name: string; description: string; category: string; unit: CatalogExpressionUnit;
  materials: ResearchCatalogMaterial[]; equipmentIds: string[]; sourceRefs: string[];
}
export interface ResearchConstructionCatalog {
  id: string; revision: string; createdAt: string; assemblies: ResearchCatalogAssembly[];
  equipment: Array<{ id: string; name: string; supplierQuoteId: string | null }>; sources: Array<{ id: string; publisher: string; url: string; checkedAt: string }>;
  /** Quote IDs bind to the existing DocumentedSupplierQuote entity; this adapter creates no second quote store. */
  supplierQuoteIds: string[];
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new TypeError(`Research catalog ${name} is required.`); return value; }
function identifier(value: unknown): string { const id = field(value, 'identity'); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new TypeError('Invalid research catalog identity.'); return id; }
function list(value: unknown, name: string, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new TypeError(`Invalid research catalog ${name}.`); return value; }
function physicalUnit(value: unknown): CatalogExpressionUnit { if (!isCatalogExpressionUnit(value) || ['ratio', 'crew_hour', 'worker_hour', 'package', 'ft3/yd3'].includes(value)) throw new TypeError('Research catalog requires a supported physical measure unit.'); return value; }
export function researchUnitToCanonical(unit: CatalogExpressionUnit): CanonicalUnit {
  if (unit === 'ft') return 'LF'; if (unit === 'ft2') return 'SF'; if (unit === 'ft3') return 'CF'; if (unit === 'yd3') return 'CY';
  if (unit === 'lb') return 'LB'; if (unit === 'ea') return 'EA';
  throw new TypeError('A ratio, package or crew/person hour cannot be substituted for a physical measure unit.');
}
/** Parse only the researched specification/AST subset. Numeric price/productivity fields are deliberately not trusted as reviewed rates. */
export function validateResearchConstructionCatalog(input: unknown): ResearchConstructionCatalog {
  if (!object(input) || input.schema_version !== '1.1.0') throw new TypeError('Unsupported research catalog schema; use reviewed version 1.1.0.');
  if (!object(input.expression_contract) || input.expression_contract.evaluate_strings_as_code !== false || input.expression_contract.dimensional_validation_required !== true
    || !object(input.tax_cost_contract) || input.tax_cost_contract.convention !== 'direct_line_landed_costs_already_include_nonrecoverable_line_taxes'
    || !object(input.supplier_quote_contract) || input.supplier_quote_contract.records_path !== 'supplier_quotes[]') throw new TypeError('Reviewed AST, tax and supplier quote contracts are required.');
  const formulaIds = new Set<string>();
  for (const formula of list(input.formulas, 'formulas', 100)) { if (!object(formula)) throw new TypeError('Invalid formula metadata.'); const id = identifier(formula.formula_id); if (formulaIds.has(id)) throw new TypeError('Duplicate formula identity.'); formulaIds.add(id); }
  const profileIds = new Set<string>();
  for (const profile of list(input.height_access_profiles, 'access profiles', 100)) { if (!object(profile)) throw new TypeError('Invalid access profile.'); const id = identifier(profile.profile_id); if (profileIds.has(id)) throw new TypeError('Duplicate access profile identity.'); profileIds.add(id); }
  const supplierQuoteIds = list(input.supplier_quotes, 'supplier quote references', 10_000).map(quote => {
    if (!object(quote)) throw new TypeError('Invalid supplier quote reference.'); return identifier(quote.supplier_quote_id);
  });
  const quoteIds = new Set(supplierQuoteIds); if (quoteIds.size !== supplierQuoteIds.length) throw new TypeError('Duplicate supplier quote identity.');
  const quoteRef = (value: unknown): string | null => { if (value === null) return null; const id = identifier(value); if (!quoteIds.has(id)) throw new TypeError('Dangling supplier quote binding.'); return id; };
  const taxIds = new Set<string>(), taxRefs = new Set<string>();
  for (const charge of list(input.tax_charge_ledger, 'tax ledger references', 10_000)) {
    if (!object(charge)) throw new TypeError('Invalid tax ledger entry.'); const id = identifier(charge.tax_charge_id), ref = field(charge.source_charge_reference, 'economic tax source').trim().normalize('NFKC').toLowerCase();
    if (taxIds.has(id) || taxRefs.has(ref)) throw new TypeError('Duplicate economic tax charge.'); taxIds.add(id); taxRefs.add(ref); quoteRef(charge.supplier_quote_id);
  }
  const identities = new Set<string>();
  const unique = (id: string) => { if (identities.has(id)) throw new TypeError('Duplicate research catalog identity.'); identities.add(id); return id; };
  const equipment = list(input.equipment_catalog, 'equipment', 500).map(value => {
    if (!object(value) || !object(value.cost_inputs) || !formulaIds.has(identifier(value.formula_ref))) throw new TypeError('Invalid researched equipment or formula reference.');
    return { id: unique(identifier(value.equipment_id)), name: field(value.name_pt, 'equipment name'), supplierQuoteId: quoteRef(value.cost_inputs.source_quote_id) };
  });
  const equipmentIds = new Set(equipment.map(item => item.id));
  const sources = list(input.sources, 'sources', 500).map(value => {
    if (!object(value)) throw new TypeError('Invalid research source.'); const url = new URL(field(value.url, 'source URL'));
    if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Research sources must use public HTTPS URLs.');
    return { id: unique(identifier(value.source_id)), publisher: field(value.publisher, 'publisher'), url: url.toString(), checkedAt: field(value.checked_at, 'source check date') };
  });
  const sourceIds = new Set(sources.map(source => source.id));
  const assemblies = list(input.assemblies, 'assemblies', 1_000).map(value => {
    if (!object(value) || !object(value.measurement) || !object(value.labor) || !formulaIds.has(identifier(value.labor.formula_ref)) || !profileIds.has(identifier(value.height_access_profile_ref))) throw new TypeError('Invalid research assembly or labor/access graph reference.');
    const id = unique(identifier(value.service_id)), unit = physicalUnit(value.measurement.unit);
    const unitOfAssembly = unit;
    const materials = list(value.materials, 'materials', 100).map(material => {
      if (!object(material) || !object(material.purchase) || !object(material.measure_inputs) || !formulaIds.has(identifier(material.purchase.formula_ref)) || ![null, true, false].includes(material.active as null | boolean)) throw new TypeError('Invalid researched material, formula, inputs or activation scope.');
      const unit = physicalUnit(material.measure_unit), materialId = unique(identifier(material.component_id));
      if (!materialId.startsWith(`${id}.`)) throw new TypeError('Material inputs must stay scoped to their service/component identity.');
      const expression = validateCatalogExpressionDimensions(material.measure_expression, unit);
      const validateInputs = (node: CatalogExpression): void => {
        if (node.op === 'multiply') { node.args.forEach(validateInputs); return; }
        if (node.op !== 'input') return;
        const declared = object(material.measure_inputs) && Object.hasOwn(material.measure_inputs, node.key) ? material.measure_inputs[node.key] : null;
        if (!object(declared) || declared.unit !== node.unit) throw new TypeError('AST input is missing or conflicts with declared component unit.');
        if (node.key === 'assembly_quantity' && node.unit !== unitOfAssembly) throw new TypeError('AST assembly quantity unit conflicts with reviewed measurement unit.');
      };
      validateInputs(expression);
      return { id: materialId, name: field(material.name, 'material name'), unit, expression, active: material.active as boolean | null, supplierQuoteId: quoteRef(material.purchase.supplier_quote_id) };
    });
    const flags = list(value.equipment_flags, 'equipment flags', 100).map(flag => {
      if (!object(flag)) throw new TypeError('Invalid equipment flag.'); const equipmentId = identifier(flag.equipment_id);
      if (!equipmentIds.has(equipmentId)) throw new TypeError('Assembly references missing research equipment.'); return equipmentId;
    });
    const refs = list(value.source_refs, 'source references', 100).map(ref => { const sourceId = identifier(ref); if (!sourceIds.has(sourceId)) throw new TypeError('Assembly references missing source.'); return sourceId; });
    return { id, unit, name: field(value.name_pt, 'service name'), description: field(value.description_pt, 'description'), category: identifier(value.category), materials, equipmentIds: flags, sourceRefs: refs };
  });
  return { id: identifier(input.catalog_id), revision: input.schema_version, createdAt: field(input.created_at, 'creation date'), assemblies, equipment, sources, supplierQuoteIds };
}
/** The researched baseline is unpriced/unreviewed. It never fills unknown consumption coefficients with one. */
export function researchCatalogToConstructionCatalog(research: ResearchConstructionCatalog): ConstructionCatalog {
  const source: CatalogSpecificationSource = { name: 'RoughBid researched scope template', url: null, documentRef: research.id, effectiveDate: null, place: null };
  const items: ConstructionCatalogItem[] = [];
  for (const equipment of research.equipment) {
    const component = () => ({ required: null, quantity: null, unit: null, rate: { amount: null, source: null, reviewed: false } });
    const item: ConstructionEquipment = { id: `equipment:${equipment.id}`, name: equipment.name, unit: 'EA', kind: 'equipment', specification: 'Exact model, method, sharing, billing terms and site conditions require review.', specificationSource: source, reviewed: false,
      costs: { rental: component(), operator: component(), transport: component(), pickup: component(), fuel: component(), mobilization: component(), assemblyDismantling: component(), extraMeterHours: component(), fees: component(), tax: component() }, rentalPeriod: { quantity: null, unit: null }, refundableDeposit: null,
      access: { required: null, reviewed: false, workingHeightFt: null, platformHeightFt: null, clearWidthIn: null, clearHeightIn: null, loadCapacityLb: null, groundAndFloorCapacityReviewed: false, indoorOutdoorReviewed: false, source: null } };
    items.push(item);
  }
  for (const assembly of research.assemblies) {
    const unit = researchUnitToCanonical(assembly.unit), laborId = `${assembly.id}.labor`;
    for (const material of assembly.materials) items.push({ id: material.id, name: material.name, kind: 'material', unit: researchUnitToCanonical(material.unit), specification: 'Project scope and exact product specification require confirmation.', specificationSource: source, reviewed: false,
      rate: { amount: null, source: null, reviewed: false }, wastePercent: null, pack: { pricedUnit: null, coverageQuantity: null, coverageUnit: null, unitsPerPackage: null, minimumOrderPackages: null, orderIncrement: null, roundingRule: null } });
    items.push({ id: laborId, name: `${assembly.name} — labor`, kind: 'labor', unit, specification: 'Loaded cost and confirmed crew productivity; not an employee wage or selling rate.', specificationSource: source, reviewed: false,
      hourlyRate: { amount: null, source: null, reviewed: false }, rateBasis: null,
      productivity: { quantityPerHour: null, quantityUnit: null, hourBasis: null, crewSize: null, modifier: null, setupHours: null, cleanupHours: null, source: null, reviewed: false } });
    items.push({ id: assembly.id, name: assembly.name, kind: 'service', unit, specification: assembly.description, specificationSource: source, reviewed: false,
      components: [...assembly.materials.map(material => ({ id: material.id, itemId: material.id, quantityPerUnit: null, unit: researchUnitToCanonical(material.unit) })),
        { id: laborId, itemId: laborId, quantityPerUnit: null, unit },
        ...assembly.equipmentIds.map(equipmentId => ({ id: `equipment:${equipmentId}`, itemId: `equipment:${equipmentId}`, quantityPerUnit: null, unit: 'EA' as const }))] });
  }
  return { schema: CONSTRUCTION_CATALOG_SCHEMA, revision: `${research.id}@${research.revision}`, items };
}
export interface ResolvedResearchAssembly { quantities: CatalogQuantity[]; expressions: Array<{ componentId: string; result: CatalogExpressionResult }>; pending: string[] }
/** Resolve physical demand from reviewed inputs. Active/inactive selection and each component remain independently scoped. */
export function resolveResearchAssembly(research: ResearchConstructionCatalog, assemblyId: string, assemblyQuantity: ConfirmedCatalogInput | null,
  componentInputs: Readonly<Record<string, Readonly<Record<string, ConfirmedCatalogInput>>>>, activation: Readonly<Record<string, boolean | null>>): ResolvedResearchAssembly {
  const assembly = research.assemblies.find(item => item.id === assemblyId); if (!assembly) throw new TypeError('Research assembly not found.');
  const expressions: ResolvedResearchAssembly['expressions'] = [], quantities: CatalogQuantity[] = [], pending: string[] = [];
  if (assemblyQuantity && assemblyQuantity.unit !== assembly.unit) pending.push('assembly_quantity:unit_mismatch');
  for (const material of assembly.materials) {
    const active = Object.hasOwn(activation, material.id) ? activation[material.id] : material.active;
    if (active === false) continue;
    if (active !== true) { pending.push(`${material.id}:scope_selection_pending`); continue; }
    const result = evaluateCatalogExpression(material.expression, material.unit, Object.hasOwn(componentInputs, material.id) ? componentInputs[material.id]! : {}, assemblyQuantity);
    expressions.push({ componentId: material.id, result }); pending.push(...result.pending.map(reason => `${material.id}:${reason}`));
    quantities.push({ id: material.id, itemId: material.id, quantity: result.quantity, unit: researchUnitToCanonical(material.unit), reviewed: result.pending.length === 0,
      sourceRef: result.pending.length ? null : `catalog-ast:${research.id}:${assembly.id}:${material.id}` });
  }
  // Labor, access and equipment allocation are separate decisions; a resolved geometric quantity is not a complete building budget.
  pending.push(`${assembly.id}:labor_productivity_and_rates_pending`);
  if (assembly.equipmentIds.length) pending.push(`${assembly.id}:equipment_selection_and_allocation_pending`);
  return { quantities, expressions, pending };
}
