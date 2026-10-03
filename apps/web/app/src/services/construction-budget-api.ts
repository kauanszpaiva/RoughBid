import rawResearchCatalog from '../../../../../packages/domain/data/roughbid-catalog-base.json' with { type: 'json' };
import {
  CONSTRUCTION_CATALOG_SCHEMA, researchCatalogToConstructionCatalog, researchUnitToCanonical, validateResearchConstructionCatalog,
  type CatalogCostLine, type CatalogExpression, type CatalogExpressionUnit, type ConfirmedCatalogInput, type ConstructionCatalog,
  type ResearchCatalogAssembly, type ResearchConstructionCatalog,
} from './constructionCatalog.ts';
import { validateDocumentedSupplierQuote, type DocumentedSupplierQuote, type QuotedSupplier, type QuoteChannel, type QuoteLocation } from './supplierQuotes.ts';
import { isCanonicalUnit, type CanonicalUnit } from '../../../../../packages/domain/src/takeoff-v2.ts';

export type BudgetSourceKind = 'plan' | 'photo';
export type AcceptedBudgetMeasurement = {
  id: string; sourceKind: BudgetSourceKind; runId: string; label: string; quantity: number;
  unit: CanonicalUnit; reviewStatus: 'accepted'; evidenceRef: string; pageNumber?: number;
};
export type PendingBudgetMeasurement = {
  id: string; sourceKind: BudgetSourceKind; runId: string; label: string;
  quantity: number | null; unit: string | null; reviewStatus: string; reason?: string;
};
export type ConstructionBudgetResult = {
  status: 'pending' | 'review_required'; knownSubtotalUsd: number; totalUsd: number | null;
  lines: CatalogCostLine[]; missingInputs: string[]; warnings: string[]; trace: unknown[];
};
export type ConstructionBudgetSnapshot = {
  id: string; createdAt: string; sourceKind: BudgetSourceKind; runId: string; selectionCount: number;
  result: ConstructionBudgetResult; coverage: 'partial'; humanReviewRequired: true;
  detailLoaded?: boolean;
};
export type ConstructionBudgetState = {
  quotes: DocumentedSupplierQuote[]; snapshots: ConstructionBudgetSnapshot[];
  measurements: AcceptedBudgetMeasurement[]; pendingMeasurements?: PendingBudgetMeasurement[];
  location?: QuoteLocation | null; coverage: 'partial'; humanReviewRequired: true;
  hasMoreMeasurements?: boolean; hasMoreSnapshots?: boolean; hasMoreQuotes?: boolean;
};
export type BudgetComponentInput = ConfirmedCatalogInput;
export type BudgetEquipmentAllocation = { quantity: number | null; unit: 'EA'; reviewed: boolean; sourceRef: string | null };
export type BudgetSelection = {
  measurementId: string; assemblyId: string;
  componentInputs?: Record<string, Record<string, BudgetComponentInput>>;
  activation?: Record<string, boolean | null>;
  equipmentAllocations?: Record<string, BudgetEquipmentAllocation>;
};
export type ConstructionBudgetCreateInput = {
  sourceKind: BudgetSourceKind; runId: string; selections: BudgetSelection[]; quoteIds: string[];
  quoteBindings?: Array<{ componentId: string; quoteId: string; supplier: QuotedSupplier; sku: string; variant: string | null; channel: QuoteChannel; specificationReviewed: true }>;
  catalogOverrides?: ConstructionCatalog;
  location?: QuoteLocation;
};
export type ConstructionBudgetRequest = <T>(path: string, options: { method?: 'GET' | 'POST'; workspaceId: string; body?: unknown }) => Promise<T>;

/** The researched baseline contains scopes, never implied prices or production. */
export const INITIAL_CONSTRUCTION_CATALOG: ResearchConstructionCatalog = validateResearchConstructionCatalog(rawResearchCatalog);

async function authenticatedRequest<T>(path: string, options: { method?: 'GET' | 'POST'; workspaceId: string; body?: unknown }): Promise<T> {
  const { request } = await import('./api.ts');
  return request<T>(path, options);
}
const projectBase = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;
function scope(workspaceId: string, projectId: string): void {
  if (!workspaceId.trim() || !projectId.trim()) throw new Error('Choose an authenticated workspace project before reading its construction budget.');
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function validateSnapshot(value: unknown): ConstructionBudgetSnapshot {
  const failure = () => new Error('The saved construction-budget snapshot could not be verified. Refresh saved budgets before submitting again.');
  if (!object(value) || !nonempty(value.id) || !nonempty(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
    || !['plan', 'photo'].includes(String(value.sourceKind)) || !nonempty(value.runId)
    || typeof value.selectionCount !== 'number' || !Number.isSafeInteger(value.selectionCount) || value.selectionCount < 1
    || value.coverage !== 'partial' || value.humanReviewRequired !== true || !object(value.result)
    || (value.detailLoaded !== undefined && typeof value.detailLoaded !== 'boolean')) throw failure();
  const result = value.result;
  if (!['pending', 'review_required'].includes(String(result.status)) || !nonnegative(result.knownSubtotalUsd)
    || (result.totalUsd !== null && !nonnegative(result.totalUsd)) || !Array.isArray(result.lines)
    || !strings(result.missingInputs) || !strings(result.warnings) || !Array.isArray(result.trace)) throw failure();
  for (const line of result.lines) {
    if (!object(line) || !nonempty(line.id) || !nonempty(line.itemId) || !nonempty(line.description)
      || !['material', 'labor', 'equipment', 'subcontract', 'other'].includes(String(line.category))
      || typeof line.unit !== 'string' || !isCanonicalUnit(line.unit) || (line.quantity !== null && !nonnegative(line.quantity))
      || (line.cost !== null && !nonnegative(line.cost)) || !nonnegative(line.knownSubtotal)
      || !strings(line.pending) || !Array.isArray(line.formulas) || !Array.isArray(line.priceSources)) throw failure();
  }
  return value as unknown as ConstructionBudgetSnapshot;
}

/** The current API returns a direct snapshot; a previous wrapper is accepted only when its full payload validates. */
function normalizeSavedSnapshot(response: unknown): { snapshot: ConstructionBudgetSnapshot } {
  const snapshot = object(response) && Object.hasOwn(response, 'snapshot') ? response.snapshot : response;
  return { snapshot: validateSnapshot(snapshot) };
}

function validateState(value: ConstructionBudgetState): ConstructionBudgetState {
  if (!value || !Array.isArray(value.measurements) || !Array.isArray(value.quotes) || !Array.isArray(value.snapshots)
    || value.coverage !== 'partial' || value.humanReviewRequired !== true) throw new Error('The saved construction-budget response could not be verified.');
  for (const measure of value.measurements) {
    if (!measure.id || !measure.runId || !measure.label || !['plan', 'photo'].includes(measure.sourceKind)
      || measure.reviewStatus !== 'accepted' || !Number.isFinite(measure.quantity) || measure.quantity < 0
      || !isCanonicalUnit(measure.unit) || !measure.evidenceRef) throw new Error('A returned measurement lacks accepted quantity evidence. Review the source before budgeting.');
  }
  for (const key of ['hasMoreMeasurements', 'hasMoreSnapshots', 'hasMoreQuotes'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('The construction-budget coverage response could not be verified.');
  }
  value.snapshots.forEach(validateSnapshot);
  return value;
}

/** Requests use the shared authenticated integration. Mutations are never retried by this client. */
export function createConstructionBudgetApi(requester: ConstructionBudgetRequest = authenticatedRequest) {
  return {
    async get(workspaceId: string, projectId: string, snapshotId?: string): Promise<ConstructionBudgetState> {
      scope(workspaceId, projectId);
      const query = snapshotId ? `?snapshot_id=${encodeURIComponent(snapshotId)}` : '';
      return validateState(await requester<ConstructionBudgetState>(`${projectBase(projectId)}/construction-budget${query}`, { workspaceId }));
    },
    async save(workspaceId: string, projectId: string, input: ConstructionBudgetCreateInput): Promise<{ snapshot: ConstructionBudgetSnapshot }> {
      scope(workspaceId, projectId);
      if (!input.runId || !['plan', 'photo'].includes(input.sourceKind) || !input.selections.length) throw new Error('Select accepted quantities from one saved source run.');
      const measurementIds = new Set<string>();
      for (const selected of input.selections) {
        if (!selected.measurementId || !selected.assemblyId || measurementIds.has(selected.measurementId)) throw new Error('Each accepted measurement can appear once in a budget selection.');
        measurementIds.add(selected.measurementId);
        if (Object.values(selected.componentInputs ?? {}).some(values => Object.hasOwn(values, 'assembly_quantity'))) throw new Error('The accepted assembly quantity is supplied by the server and cannot be replaced by a browser input.');
      }
      const selections = input.selections.map(selected => ({ measurementId: selected.measurementId, assemblyId: selected.assemblyId, ...(selected.componentInputs ? { componentInputs: selected.componentInputs } : {}), ...(selected.activation ? { activation: selected.activation } : {}), ...(selected.equipmentAllocations ? { equipmentAllocations: selected.equipmentAllocations } : {}) }));
      const body: ConstructionBudgetCreateInput = { sourceKind: input.sourceKind, runId: input.runId, selections, quoteIds: Array.from(new Set(input.quoteIds)), ...(input.quoteBindings ? { quoteBindings: input.quoteBindings } : {}), ...(input.catalogOverrides ? { catalogOverrides: input.catalogOverrides } : {}), ...(input.location ? { location: input.location } : {}) };
      return normalizeSavedSnapshot(await requester<unknown>(`${projectBase(projectId)}/construction-budget`, { method: 'POST', workspaceId, body }));
    },
    async importQuotes(workspaceId: string, projectId: string, quotes: readonly DocumentedSupplierQuote[]): Promise<{ quotes: DocumentedSupplierQuote[] }> {
      scope(workspaceId, projectId);
      if (!quotes.length) throw new Error('No documented supplier quote was supplied.');
      const validated = quotes.map(quote => validateDocumentedSupplierQuote(quote));
      if (validated.some(quote => !['supplier_quote', 'manual_quote', 'cache'].includes(quote.origin))) throw new Error('A user import cannot claim official partner API or feed access. Import a supplier or manual documented quote.');
      return requester<{ quotes: DocumentedSupplierQuote[] }>(`${projectBase(projectId)}/supplier-quotes`, { method: 'POST', workspaceId, body: { quotes: validated } });
    },
  };
}

export const constructionBudgetApi = createConstructionBudgetApi();

export function compatibleBudgetAssemblies(measurement: Pick<AcceptedBudgetMeasurement, 'unit'>, catalog = INITIAL_CONSTRUCTION_CATALOG): ResearchCatalogAssembly[] {
  return catalog.assemblies.filter(assembly => researchUnitToCanonical(assembly.unit) === measurement.unit);
}

export type ComponentScopeField = { componentId: string; componentName: string; key: string; unit: CatalogExpressionUnit };
export type BudgetScopeFieldDraft = { value: string; confirmed: boolean; sourceRef: string };
export type BudgetSelectionDraft = {
  assemblyId: string;
  inputs: Record<string, Record<string, BudgetScopeFieldDraft>>;
  activation: Record<string, boolean | null>;
  equipmentAllocations?: Record<string, BudgetScopeFieldDraft>;
};
/** Input names remain local to each material; the browser never substitutes the accepted assembly quantity. */
export function assemblyScopeFields(assembly: ResearchCatalogAssembly): ComponentScopeField[] {
  const fields: ComponentScopeField[] = [];
  for (const material of assembly.materials) {
    const found = new Map<string, CatalogExpressionUnit>();
    const visit = (node: CatalogExpression) => {
      if (node.op === 'multiply') { node.args.forEach(visit); return; }
      if (node.op !== 'input' || node.key === 'assembly_quantity') return;
      const old = found.get(node.key);
      if (old && old !== node.unit) throw new Error('A component reuses an input with incompatible units.');
      found.set(node.key, node.unit);
    };
    visit(material.expression);
    for (const [key, unit] of found) fields.push({ componentId: material.id, componentName: material.name, key, unit });
  }
  return fields;
}

export function parseBudgetScopeQuantity(value: string): number | null {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000_000 ? amount : null;
}

export function constructionBudgetSelectionFromDraft(measurement: AcceptedBudgetMeasurement, assembly: ResearchCatalogAssembly, draft: BudgetSelectionDraft): BudgetSelection {
  if (measurement.reviewStatus !== 'accepted' || !measurement.evidenceRef || draft.assemblyId !== assembly.id || researchUnitToCanonical(assembly.unit) !== measurement.unit) throw new Error('Choose an assembly matching the accepted measurement unit.');
  const componentInputs: Record<string, Record<string, BudgetComponentInput>> = {};
  for (const field of assemblyScopeFields(assembly)) {
    const supplied = draft.inputs[field.componentId]?.[field.key];
    componentInputs[field.componentId] ??= {};
    componentInputs[field.componentId]![field.key] = {
      value: supplied ? parseBudgetScopeQuantity(supplied.value) : null,
      unit: field.unit,
      reviewed: supplied?.confirmed === true && Boolean(supplied.sourceRef.trim()),
      sourceRef: supplied?.sourceRef.trim() || null,
    };
  }
  const activation: Record<string, boolean | null> = {};
  for (const material of assembly.materials) activation[material.id] = draft.activation[material.id] ?? null;
  const equipmentAllocations: Record<string, BudgetEquipmentAllocation> = {};
  for (const equipmentId of assembly.equipmentIds) {
    const supplied = draft.equipmentAllocations?.[equipmentId];
    const value = supplied ? parseBudgetScopeQuantity(supplied.value) : null;
    const quantity = value !== null && value <= 1_000_000 ? value : null;
    const sourceRef = supplied?.sourceRef.trim() || null;
    if (sourceRef && sourceRef.length > 240) throw new Error('An equipment allocation source reference must be at most 240 characters.');
    equipmentAllocations[equipmentId] = { quantity, unit: 'EA', reviewed: quantity !== null && supplied?.confirmed === true && sourceRef !== null, sourceRef };
  }
  return { measurementId: measurement.id, assemblyId: assembly.id, componentInputs, activation, ...(assembly.equipmentIds.length ? { equipmentAllocations } : {}) };
}

export function parseBudgetLocation(postalCode: string, storeId: string, timeZone: string): QuoteLocation | null {
  if (!/^\d{5}(?:-\d{4})?$/.test(postalCode.trim()) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(storeId.trim()) || !timeZone.trim()) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(); }
  catch { return null; }
  return { country: 'US', postalCode: postalCode.trim(), storeId: storeId.trim(), timeZone: timeZone.trim() };
}

/** Structured documented override, never executed formula text or automatic rate defaults. The API revalidates it. */
export function parseConstructionCatalogOverrides(document: string): ConstructionCatalog | undefined {
  if (!document.trim()) return undefined;
  if (document.length > 1_000_000) throw new Error('Documented catalog JSON must be at most 1 MB.');
  const value: unknown = JSON.parse(document);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a documented construction-catalog JSON object.');
  const catalog = value as ConstructionCatalog;
  if (catalog.schema !== CONSTRUCTION_CATALOG_SCHEMA || typeof catalog.revision !== 'string' || !catalog.revision.trim() || !Array.isArray(catalog.items) || catalog.items.length > 5_000) throw new Error('Use roughbid-construction-catalog-v1 with a reviewed revision and items.');
  const ids = new Set<string>();
  for (const item of catalog.items) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || !['material', 'labor', 'equipment', 'service'].includes(item.kind) || !isCanonicalUnit(item.unit)) throw new Error('Documented catalog items need unique IDs, supported kinds and canonical units.');
    ids.add(item.id);
  }
  return catalog;
}

/** Seed only selected scopes with explicit nulls; a template never marks any rate or productivity reviewed. */
export function constructionCatalogInputTemplate(assemblyIds: readonly string[]): ConstructionCatalog {
  const base = researchCatalogToConstructionCatalog(INITIAL_CONSTRUCTION_CATALOG);
  const itemById = new Map(base.items.map(item => [item.id, item]));
  const selected = new Set<string>();
  const visit = (id: string) => {
    if (selected.has(id)) return;
    const item = itemById.get(id); if (!item) throw new Error('The selected service is missing from the initial catalog.');
    selected.add(id);
    if (item.kind === 'service') item.components.forEach(component => visit(component.itemId));
  };
  assemblyIds.forEach(visit);
  return { ...base, items: base.items.filter(item => selected.has(item.id)) };
}

/** A partial known subtotal is displayed separately and never relabeled as the full construction price. */
export function constructionBudgetMoneySummary(result: ConstructionBudgetResult): { knownSubtotal: number | null; total: number | null } {
  const priced = result.lines.some(line => line.cost !== null || line.priceSources.length > 0);
  return { knownSubtotal: priced ? result.knownSubtotalUsd : null, total: result.totalUsd };
}

export function constructionBudgetLimitNotices(state: Pick<ConstructionBudgetState, 'hasMoreMeasurements' | 'hasMoreSnapshots' | 'hasMoreQuotes'>): string[] {
  const notices: string[] = [];
  if (state.hasMoreMeasurements) notices.push('This budget view shows a subset of accepted quantities. Additional quantities remain outside this view; the project scope is incomplete.');
  if (state.hasMoreSnapshots) notices.push('Showing the recent saved reviews. More saved reviews are retained, and this view does not show the full history.');
  if (state.hasMoreQuotes) notices.push('This view shows a subset of saved supplier quotes. Additional quotes are retained and are not included in this list.');
  return notices;
}
