import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblyScopeFields, compatibleBudgetAssemblies, constructionBudgetLimitNotices, constructionBudgetMoneySummary,
  constructionBudgetSelectionFromDraft, constructionCatalogInputTemplate, createConstructionBudgetApi,
  INITIAL_CONSTRUCTION_CATALOG, parseBudgetLocation, parseBudgetScopeQuantity, parseConstructionCatalogOverrides,
  type AcceptedBudgetMeasurement, type ConstructionBudgetCreateInput, type ConstructionBudgetResult,
  type ConstructionBudgetSnapshot, type ConstructionBudgetState,
} from '../app/src/services/construction-budget-api.ts';
import type { ResearchCatalogAssembly } from '../app/src/services/constructionCatalog.ts';
import type { DocumentedSupplierQuote } from '../app/src/services/supplierQuotes.ts';

const measure: AcceptedBudgetMeasurement = { id: 'measure-fixture', runId: 'run-fixture', sourceKind: 'plan', label: 'Reviewed wall area fixture', quantity: 100, unit: 'SF', reviewStatus: 'accepted', evidenceRef: 'fixture:sheet-4:region-2', pageNumber: 4 };
const state: ConstructionBudgetState = { quotes: [], snapshots: [], measurements: [measure], coverage: 'partial', humanReviewRequired: true };
const snapshot: ConstructionBudgetSnapshot = {
  id: 'snapshot-fixture', createdAt: '2026-10-02T12:00:00Z', sourceKind: 'plan', runId: 'run-fixture', selectionCount: 1,
  result: { status: 'pending', knownSubtotalUsd: 0, totalUsd: null, lines: [], missingInputs: ['missing_price'], warnings: ['Partial scope fixture'], trace: [] },
  coverage: 'partial', humanReviewRequired: true,
};
const assembly: ResearchCatalogAssembly = {
  id: 'fixture-wall', name: 'Fixture wall service', description: 'Offline formula fixture', category: 'fixture', unit: 'ft2', equipmentIds: [], sourceRefs: [],
  materials: ['primer', 'finish'].map(name => ({ id: `fixture-wall.${name}`, name, unit: 'ft2', active: null, expression: { op: 'multiply', args: [{ op: 'input', key: 'assembly_quantity', unit: 'ft2' }, { op: 'input', key: 'coats', unit: 'ratio' }] } })),
};

function quote(origin: DocumentedSupplierQuote['origin'] = 'manual_quote'): DocumentedSupplierQuote {
  const notRequired = () => ({ required: false, amount: null, refundable: false, sourceRef: null });
  return {
    schema: 'roughbid-supplier-quote-v1', id: 'offline-quote', supplier: 'other', supplierName: 'Offline supplier fixture',
    location: { country: 'US', postalCode: '00000', storeId: 'fixture-store', timeZone: 'Etc/UTC' }, sku: 'fixture-sku', variant: null,
    channel: 'pickup', quotedQuantity: 1, pricedUnit: 'EA', unitPrice: 10, currency: 'USD', origin,
    model: null, specification: null, specificationReviewed: false,
    sourceUrl: null, documentRef: 'fixture-document-only', observedAt: '2026-10-02T12:00:00Z', evidenceAt: '2026-10-02T12:00:00Z',
    sourceUpdatedAt: null, validUntil: null, importedAt: '2026-10-02T12:00:00Z', reviewedBy: null, reviewedAt: null,
    availability: 'unknown', availableQuantity: null, availabilityAt: null, coveragePerPricedUnit: null,
    unitsPerPackage: null, minimumOrderPackages: null, orderIncrement: null, roundingRule: null,
    charges: { freight: notRequired(), handling: notRequired(), tax: notRequired(), conditionalDiscount: notRequired(), refundableDeposit: { ...notRequired(), refundable: true } },
  };
}

test('initial researched catalog exposes 72 scopes with pending commercial/production inputs', () => {
  assert.equal(INITIAL_CONSTRUCTION_CATALOG.assemblies.length, 72);
  assert.ok(INITIAL_CONSTRUCTION_CATALOG.assemblies.every(item => item.materials.every(material => material.active === null)));
  const template = constructionCatalogInputTemplate([INITIAL_CONSTRUCTION_CATALOG.assemblies[0]!.id]);
  assert.ok(template.items.every(item => !item.reviewed));
  assert.ok(template.items.filter(item => item.kind === 'material').every(item => item.rate.amount === null && item.wastePercent === null));
});

test('assembly choices match canonical accepted units without browser physical-scale conversion', () => {
  const options = compatibleBudgetAssemblies(measure);
  assert.ok(options.length > 0);
  assert.ok(options.every(option => option.unit === 'ft2'));
  assert.deepEqual(compatibleBudgetAssemblies({ unit: 'HR' }), []);
});

test('authenticated project scope is attached to reads without touching providers', async () => {
  const calls: Array<{ path: string; options: unknown }> = [];
  const api = createConstructionBudgetApi(async <T>(path: string, options: unknown) => { calls.push({ path, options }); return state as T; });
  const read = await api.get('workspace-fixture', 'project/fixture');
  assert.equal(read.measurements[0]!.quantity, 100);
  assert.deepEqual(calls, [{ path: '/api/projects/project%2Ffixture/construction-budget', options: { workspaceId: 'workspace-fixture' } }]);
});

test('missing workspace or project scope rejects before any network adapter is invoked', async () => {
  let calls = 0;
  const api = createConstructionBudgetApi(async <T>() => { calls++; return state as T; });
  await assert.rejects(api.get('', 'project'), /workspace project/);
  await assert.rejects(api.get('workspace', ''), /workspace project/);
  assert.equal(calls, 0);
});

test('API measurements lacking human acceptance or canonical units are not made selectable', async () => {
  for (const bad of [{ ...measure, reviewStatus: 'estimated' }, { ...measure, evidenceRef: '' }, { ...measure, unit: 'm2' }]) {
    const api = createConstructionBudgetApi(async <T>() => ({ ...state, measurements: [bad] }) as T);
    await assert.rejects(api.get('workspace', 'project'), /accepted quantity evidence/);
  }
});

test('component input keys remain separately scoped even when two materials both use coats', () => {
  const fields = assemblyScopeFields(assembly);
  assert.deepEqual(fields.map(field => [field.componentId, field.key]), [['fixture-wall.primer', 'coats'], ['fixture-wall.finish', 'coats']]);
  const selection = constructionBudgetSelectionFromDraft(measure, assembly, {
    assemblyId: assembly.id,
    inputs: { 'fixture-wall.primer': { coats: { value: '2', confirmed: true, sourceRef: 'fixture:spec-primer' } } },
    activation: { 'fixture-wall.primer': true },
  });
  assert.equal(selection.componentInputs!['fixture-wall.primer']!.coats!.value, 2);
  assert.equal(selection.componentInputs!['fixture-wall.finish']!.coats!.value, null);
  assert.equal(selection.componentInputs!['fixture-wall.finish']!.coats!.reviewed, false);
  assert.equal(selection.activation!['fixture-wall.finish'], null);
  assert.equal('quantity' in selection, false);
  assert.ok(Object.values(selection.componentInputs!).every(values => !Object.hasOwn(values, 'assembly_quantity')));
});

test('known supplemental values without review and source remain unreviewed', () => {
  const selection = constructionBudgetSelectionFromDraft(measure, assembly, {
    assemblyId: assembly.id, activation: {}, inputs: { 'fixture-wall.primer': { coats: { value: '2', confirmed: true, sourceRef: '' } } },
  });
  assert.equal(selection.componentInputs!['fixture-wall.primer']!.coats!.value, 2);
  assert.equal(selection.componentInputs!['fixture-wall.primer']!.coats!.reviewed, false);
  assert.equal(selection.componentInputs!['fixture-wall.primer']!.coats!.sourceRef, null);
});

test('unaccepted or incompatible measurements cannot be paired with a service', () => {
  const draft = { assemblyId: assembly.id, inputs: {}, activation: {} };
  assert.throws(() => constructionBudgetSelectionFromDraft({ ...measure, unit: 'LF' }, assembly, draft), /matching/);
  assert.throws(() => constructionBudgetSelectionFromDraft({ ...measure, reviewStatus: 'estimated' } as unknown as AcceptedBudgetMeasurement, assembly, draft), /matching/);
});

test('extra dimensions and coefficients use strict decimal parsing without invented defaults', () => {
  assert.equal(parseBudgetScopeQuantity('0'), 0);
  assert.equal(parseBudgetScopeQuantity('1.250001'), 1.250001);
  for (const value of ['', 'NaN', '-2', '1e2', '0.1234567']) assert.equal(parseBudgetScopeQuantity(value), null);
});

test('project ZIP, store and IANA zone are all required, with no automatic retailer location', () => {
  assert.equal(parseBudgetLocation('', '', ''), null);
  assert.equal(parseBudgetLocation('00000', 'fixture-store', 'Bad/Zone'), null);
  assert.equal(parseBudgetLocation('00000', '', 'Etc/UTC'), null);
  assert.deepEqual(parseBudgetLocation('00000', 'fixture-store', 'Etc/UTC'), { country: 'US', postalCode: '00000', storeId: 'fixture-store', timeZone: 'Etc/UTC' });
});

test('budget save sends measurement identities and supplemental scope, never browser replacement quantities', async () => {
  let sent: unknown;
  const api = createConstructionBudgetApi(async <T>(_path: string, options: { body?: unknown }) => { sent = options.body; return snapshot as T; });
  const input = { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id, quantity: 9999 }], quoteIds: ['one', 'one'] } as unknown as ConstructionBudgetCreateInput;
  await api.save('workspace', 'project', input);
  assert.deepEqual(sent, { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id }], quoteIds: ['one'] });
});

test('duplicate measurements and attempted assembly quantity overrides reject before dispatch', async () => {
  let calls = 0;
  const api = createConstructionBudgetApi(async <T>() => { calls++; return {} as T; });
  const selected = { measurementId: measure.id, assemblyId: assembly.id };
  await assert.rejects(api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [selected, selected], quoteIds: [] }), /once/);
  await assert.rejects(api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [{ ...selected, componentInputs: { 'fixture-wall.primer': { assembly_quantity: { value: 9999, unit: 'ft2', reviewed: true, sourceRef: 'forged-browser-value' } } } }], quoteIds: [] }), /cannot be replaced/);
  assert.equal(calls, 0);
});

test('failed budget mutation is attempted once, with no silent retry', async () => {
  let calls = 0;
  const api = createConstructionBudgetApi(async () => { calls++; throw new Error('Offline transport fixture failure'); });
  await assert.rejects(api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id }], quoteIds: [] }), /transport/);
  assert.equal(calls, 1);
});

test('documented quote import preserves original dates and denies invented partner provenance', async () => {
  let sent: unknown; let calls = 0;
  const api = createConstructionBudgetApi(async <T>(_path: string, options: { body?: unknown }) => { sent = options.body; calls++; return { quotes: [] } as T; });
  const document = quote();
  await api.importQuotes('workspace', 'project', [document]);
  assert.equal((sent as { quotes: DocumentedSupplierQuote[] }).quotes[0]!.evidenceAt, document.evidenceAt);
  for (const origin of ['partner_api', 'partner_feed'] as const) await assert.rejects(api.importQuotes('workspace', 'project', [quote(origin)]), /partner API/);
  assert.equal(calls, 1);
});

test('catalog template preserves null rates, packaging and labor production and can be reviewed as structured JSON', () => {
  const chosen = INITIAL_CONSTRUCTION_CATALOG.assemblies.find(item => item.unit === 'ft2')!;
  const template = constructionCatalogInputTemplate([chosen.id]);
  const parsed = parseConstructionCatalogOverrides(JSON.stringify(template));
  assert.deepEqual(parsed, template);
  const labor = template.items.find(item => item.kind === 'labor');
  assert.equal(labor?.kind === 'labor' ? labor.hourlyRate.amount : undefined, null);
  assert.equal(labor?.kind === 'labor' ? labor.productivity.quantityPerHour : undefined, null);
  assert.equal(parseConstructionCatalogOverrides(''), undefined);
  assert.throws(() => parseConstructionCatalogOverrides(JSON.stringify({ schema: 'wrong', revision: 'fixture', items: [] })), /construction-catalog/);
});

test('a budget with entirely missing prices displays pending rather than a zero-price complete estimate', () => {
  const result: ConstructionBudgetResult = { status: 'pending', knownSubtotalUsd: 0, totalUsd: null, missingInputs: ['missing_price'], warnings: [], trace: [], lines: [{ id: 'fixture-line', itemId: 'fixture-item', description: 'Fixture missing price', category: 'material', quantity: 100, unit: 'SF', cost: null, knownSubtotal: 0, pending: ['missing_price'], formulas: [], priceSources: [] }] };
  assert.deepEqual(constructionBudgetMoneySummary(result), { knownSubtotal: null, total: null });
  assert.deepEqual(constructionBudgetMoneySummary({ ...result, knownSubtotalUsd: 10, lines: [{ ...result.lines[0]!, cost: 10, knownSubtotal: 10 }] }), { knownSubtotal: 10, total: null });
});

test('the direct HTTP snapshot response is normalized to the component save contract', async () => {
  const api = createConstructionBudgetApi(async <T>() => snapshot as T);
  const saved = await api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id }], quoteIds: [] });
  assert.deepEqual(saved, { snapshot });
});

test('a legacy snapshot wrapper is accepted only when its full saved record validates', async () => {
  const api = createConstructionBudgetApi(async <T>() => ({ snapshot }) as T);
  assert.deepEqual(await api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id }], quoteIds: [] }), { snapshot });
});

test('malformed saved snapshots are rejected after one dispatch instead of becoming a false success', async () => {
  const malformed = [null, {}, { snapshot: null }, { ...snapshot, id: '' }, { ...snapshot, humanReviewRequired: false },
    { ...snapshot, result: { ...snapshot.result, lines: undefined } }, { ...snapshot, result: { ...snapshot.result, knownSubtotalUsd: '0' } }];
  for (const response of malformed) {
    let calls = 0;
    const api = createConstructionBudgetApi(async <T>() => { calls++; return response as T; });
    await assert.rejects(api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, selections: [{ measurementId: measure.id, assemblyId: assembly.id }], quoteIds: [] }), /snapshot could not be verified/);
    assert.equal(calls, 1);
  }
});

test('reading malformed historical details rejects before a view can dereference missing arrays', async () => {
  const api = createConstructionBudgetApi(async <T>() => ({ ...state, snapshots: [{ ...snapshot, result: { ...snapshot.result, missingInputs: null } }] }) as T);
  await assert.rejects(api.get('workspace', 'project'), /snapshot could not be verified/);
});

test('accepted-quantity and saved-history limits stay explicit and do not imply coverage completion', async () => {
  const bounded = { ...state, hasMoreMeasurements: true, hasMoreSnapshots: true, hasMoreQuotes: true };
  const api = createConstructionBudgetApi(async <T>() => bounded as T);
  const read = await api.get('workspace', 'project');
  const notices = constructionBudgetLimitNotices(read);
  assert.equal(notices.length, 3);
  assert.ok(notices.some(notice => notice.includes('project scope is incomplete')));
  assert.ok(notices.some(notice => notice.includes('full history')));
  assert.deepEqual(constructionBudgetLimitNotices({}), []);
});

test('selected saved evidence uses an encoded scoped query and preserves explicit unloaded history metadata', async () => {
  let path = '';
  const summaryOnly = { ...snapshot, detailLoaded: false, result: { ...snapshot.result, warnings: ['Details not loaded; open this saved snapshot.'] } };
  const api = createConstructionBudgetApi(async <T>(url: string) => { path = url; return { ...state, snapshots: [summaryOnly], hasMoreSnapshots: true } as T; });
  const read = await api.get('workspace', 'project', 'snapshot?id');
  assert.equal(path, '/api/projects/project/construction-budget?snapshot_id=snapshot%3Fid');
  assert.equal(read.snapshots[0]!.detailLoaded, false);
  assert.deepEqual(constructionBudgetMoneySummary(read.snapshots[0]!.result), { knownSubtotal: null, total: null });
});

test('equipment usage allocations start unknown without a default count of one', () => {
  const service = { ...assembly, equipmentIds: ['fixture-lift'] };
  const selected = constructionBudgetSelectionFromDraft(measure, service, { assemblyId: service.id, inputs: {}, activation: {} });
  assert.deepEqual(selected.equipmentAllocations, { 'fixture-lift': { quantity: null, unit: 'EA', reviewed: false, sourceRef: null } });
  assert.equal('quantity' in selected, false);
});

test('manual reviewed equipment allocations stay independent of the accepted physical measure', () => {
  const service = { ...assembly, equipmentIds: ['fixture-lift'] };
  const selected = constructionBudgetSelectionFromDraft(measure, service, { assemblyId: service.id, inputs: {}, activation: {}, equipmentAllocations: { 'fixture-lift': { value: '0.5', confirmed: true, sourceRef: 'fixture:job-rental-1:half-allocation' } } });
  assert.equal(selected.measurementId, measure.id);
  assert.deepEqual(selected.equipmentAllocations!['fixture-lift'], { quantity: 0.5, unit: 'EA', reviewed: true, sourceRef: 'fixture:job-rental-1:half-allocation' });
  assert.equal(measure.quantity, 100);
  assert.equal(measure.unit, 'SF');
});

test('equipment input without source, review or supported bound remains pending rather than becoming usage', () => {
  const service = { ...assembly, equipmentIds: ['fixture-lift'] };
  for (const draft of [{ value: '1', confirmed: true, sourceRef: '' }, { value: '1', confirmed: false, sourceRef: 'fixture:job-rental' }, { value: '1000001', confirmed: true, sourceRef: 'fixture:job-rental' }, { value: '', confirmed: true, sourceRef: 'fixture:job-rental' }]) {
    const selected = constructionBudgetSelectionFromDraft(measure, service, { assemblyId: service.id, inputs: {}, activation: {}, equipmentAllocations: { 'fixture-lift': draft } });
    assert.equal(selected.equipmentAllocations!['fixture-lift']!.reviewed, false);
    if (draft.value === '' || draft.value === '1000001') assert.equal(selected.equipmentAllocations!['fixture-lift']!.quantity, null);
  }
});

test('equipment allocations only use the selected service equipment and bounded source references', () => {
  const service = { ...assembly, equipmentIds: ['fixture-lift'] };
  const selected = constructionBudgetSelectionFromDraft(measure, service, { assemblyId: service.id, inputs: {}, activation: {}, equipmentAllocations: { 'other-service-lift': { value: '2', confirmed: true, sourceRef: 'fixture:other-rental' } } });
  assert.deepEqual(Object.keys(selected.equipmentAllocations!), ['fixture-lift']);
  assert.equal(selected.equipmentAllocations!['fixture-lift']!.quantity, null);
  assert.throws(() => constructionBudgetSelectionFromDraft(measure, service, { assemblyId: service.id, inputs: {}, activation: {}, equipmentAllocations: { 'fixture-lift': { value: '1', confirmed: true, sourceRef: 'x'.repeat(241) } } }), /at most 240/);
});

test('equipment usage is serialized as a documented allocation and never as an accepted measurement replacement', async () => {
  let sent: ConstructionBudgetCreateInput | undefined;
  const api = createConstructionBudgetApi(async <T>(_path: string, options: { body?: unknown }) => { sent = options.body as ConstructionBudgetCreateInput; return snapshot as T; });
  await api.save('workspace', 'project', { sourceKind: 'plan', runId: measure.runId, quoteIds: [], selections: [{ measurementId: measure.id, assemblyId: assembly.id, equipmentAllocations: { 'fixture-lift': { quantity: 1, unit: 'EA', reviewed: true, sourceRef: 'fixture:unique-job-usage' } } }] });
  assert.deepEqual(sent!.selections[0]!.equipmentAllocations, { 'fixture-lift': { quantity: 1, unit: 'EA', reviewed: true, sourceRef: 'fixture:unique-job-usage' } });
  assert.equal('quantity' in sent!.selections[0]!, false);
});
