import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCatalogExpression, validateCatalogExpressionDimensions } from '../src/catalog-expressions.ts';
import { validateResearchConstructionCatalog, researchCatalogToConstructionCatalog, resolveResearchAssembly } from '../src/research-catalog.ts';
const input = (key: string, unit: string) => ({ op: 'input', key, unit });
const confirmed = (value: number | null, unit: 'ft' | 'ft2' | 'yd3' | 'ratio' = 'ft') => ({ value, unit, reviewed: true, sourceRef: 'measure42' });

test('AST computes reviewed physical demand and validates exact volume conversion', () => {
  const area = { op: 'multiply', args: [input('assembly_quantity', 'ft'), input('height', 'ft')] };
  assert.equal(evaluateCatalogExpression(area, 'ft2', { height: confirmed(8) }, confirmed(10)).quantity, 80);
  const volume = { op: 'multiply', args: [input('assembly_quantity', 'yd3'), { op: 'constant', value: 27, unit: 'ft3/yd3', reason: 'Exact unit conversion' }] };
  assert.equal(evaluateCatalogExpression(volume, 'ft3', {}, confirmed(2, 'yd3')).quantity, 54);
  assert.throws(() => validateCatalogExpressionDimensions(area, 'ft'), /dimension/);
  assert.throws(() => validateCatalogExpressionDimensions({ ...volume, args: [volume.args[0], { ...volume.args[1], value: 30 }] }, 'ft3'), /27/);
});
test('null propagates even when another factor is zero, and unreviewed inputs cannot produce quantity', () => {
  const expression = { op: 'multiply', args: [input('assembly_quantity', 'ft'), input('height', 'ft')] };
  assert.equal(evaluateCatalogExpression(expression, 'ft2', {}, confirmed(0)).quantity, null);
  assert.equal(evaluateCatalogExpression(expression, 'ft2', { height: { ...confirmed(8), reviewed: false } }, confirmed(10)).quantity, null);
  assert.equal(evaluateCatalogExpression(expression, 'ft2', { height: confirmed(8, 'ft2') }, confirmed(10)).quantity, null);
  assert.equal(evaluateCatalogExpression(expression, 'ft2', { height: confirmed(0) }, confirmed(10)).quantity, 0);
});
test('formula strings, functions, deep/unsupported nodes are rejected without evaluation', () => {
  assert.throws(() => validateCatalogExpressionDimensions('process.exit()', 'ft'), /structural/);
  assert.throws(() => validateCatalogExpressionDimensions({ op: 'eval', code: 'process.exit()' }, 'ft'), /supported/);
  let deep: unknown = input('length', 'ft'); for (let i = 0; i < 22; i++) deep = { op: 'multiply', args: [deep, { op: 'constant', value: 1, unit: 'ratio', reason: 'Dimensionless fixture' }] };
  assert.throws(() => validateCatalogExpressionDimensions(deep, 'ft'), /limits/);
});
test('public baseline validates all dimensions, stays unpriced and does not invent production or consumption coefficients', () => {
  const json: unknown = JSON.parse(readFileSync(new URL('../data/roughbid-catalog-base.json', import.meta.url), 'utf8'));
  const research = validateResearchConstructionCatalog(json), catalog = researchCatalogToConstructionCatalog(research);
  assert.equal(research.revision, '1.1.0');
  assert.equal(research.assemblies.length, 72); assert.equal(research.equipment.length, 48); assert.equal(research.sources.length, 8);
  assert.equal(research.assemblies.reduce((sum, assembly) => sum + assembly.materials.length, 0), 179);
  for (const item of catalog.items) {
    assert.equal(item.reviewed, false);
    if (item.kind === 'material') { assert.equal(item.rate.amount, null); assert.equal(item.wastePercent, null); }
    if (item.kind === 'labor') assert.equal(item.productivity.quantityPerHour, null);
    if (item.kind === 'service') assert.ok(item.components.every(component => component.quantityPerUnit === null));
  }
});
test('reviewed graph rejects obsolete schema, dangling formula/equipment/source/quote and mismatched declared input units', () => {
  const baseline: unknown = JSON.parse(readFileSync(new URL('../data/roughbid-catalog-base.json', import.meta.url), 'utf8'));
  assert.ok(baseline && typeof baseline === 'object');
  const change = (mutate: (value: Record<string, any>) => void) => { const value: Record<string, any> = JSON.parse(JSON.stringify(baseline)); mutate(value); assert.throws(() => validateResearchConstructionCatalog(value)); };
  change(value => { value.schema_version = '1.0.0'; });
  change(value => { value.assemblies[0].materials[0].purchase.formula_ref = 'missing'; });
  change(value => { value.assemblies[0].materials[0].purchase.supplier_quote_id = 'missing'; });
  change(value => { value.equipment_catalog[0].cost_inputs.source_quote_id = 'missing'; });
  change(value => { value.assemblies[0].equipment_flags[0].equipment_id = 'missing'; });
  change(value => { value.assemblies[0].source_refs = ['missing']; });
  change(value => { value.assemblies[0].height_access_profile_ref = 'missing'; });
  change(value => { value.assemblies[0].materials[0].measure_inputs.assembly_quantity.unit = 'ft'; });
});
test('component inputs with the same name remain separate and reviewed assembly quantity does not activate unknown scope', () => {
  const json: unknown = JSON.parse(readFileSync(new URL('../data/roughbid-catalog-base.json', import.meta.url), 'utf8'));
  const research = validateResearchConstructionCatalog(json), assembly = research.assemblies[0]!, material = assembly.materials[1]!;
  const noActivation = resolveResearchAssembly(research, assembly.id, confirmed(100, 'ft2'), {}, {});
  assert.equal(noActivation.quantities.length, 0); assert.ok(noActivation.pending.some(reason => reason.includes('scope_selection_pending')));
  const result = resolveResearchAssembly(research, assembly.id, confirmed(100, 'ft2'), { [material.id]: { seam_and_edge_length_ft: confirmed(12) } }, { [material.id]: true });
  assert.equal(result.quantities[0]!.quantity, 12); assert.ok(result.pending.some(reason => reason.includes('labor_productivity')));
  const otherComponent = resolveResearchAssembly(research, assembly.id, confirmed(100, 'ft2'), { unrelated: { seam_and_edge_length_ft: confirmed(12) } }, { [material.id]: true });
  assert.equal(otherComponent.quantities[0]!.quantity, null);
});
