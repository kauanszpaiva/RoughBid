import { isCanonicalUnit, type CanonicalUnit, type PriceProvenance } from './takeoff-v2.ts';
import { costDecimal, costMoney, costMultiply } from './cost-decimal.ts';

export const SUPPLIER_QUOTE_SCHEMA = 'roughbid-supplier-quote-v1';
export type QuotedSupplier = 'lowes' | 'home_depot' | 'floor_and_decor' | 'other';
export type QuoteChannel = 'online' | 'pickup' | 'delivery' | 'contract';
export type QuoteOrigin = 'partner_api' | 'partner_feed' | 'supplier_quote' | 'manual_quote' | 'cache';
export type SupplierQuoteState = 'awaiting_location' | 'partner_access_required' | 'quote_required' | 'stale' | 'fresh'
  | 'out_of_stock' | 'availability_unknown' | 'source_error';
export interface QuoteLocation { country: 'US'; postalCode: string; storeId: string; timeZone: string }
export interface SupplierQuoteRequest {
  supplier: QuotedSupplier;
  location: QuoteLocation | null;
  sku: string | null;
  variant: string | null;
  channel: QuoteChannel;
  quantity: number | null;
  pricedUnit: CanonicalUnit | null;
  mode: 'documented_quote' | 'official_partner';
  partnerAccessVerified: boolean;
  contractEligibilityVerified: boolean;
}
export interface QuoteCharge {
  required: boolean | null;
  amount: number | null;
  /** A refundable deposit stays outside construction cost. */
  refundable: boolean;
  sourceRef: string | null;
}
export interface DocumentedSupplierQuote {
  schema: typeof SUPPLIER_QUOTE_SCHEMA;
  id: string;
  supplier: QuotedSupplier;
  supplierName: string;
  location: QuoteLocation;
  sku: string;
  variant: string | null;
  model: string | null;
  specification: string | null;
  specificationReviewed: boolean;
  channel: QuoteChannel;
  quotedQuantity: number;
  pricedUnit: CanonicalUnit;
  unitPrice: number | null;
  currency: 'USD';
  origin: QuoteOrigin;
  sourceUrl: string | null;
  documentRef: string | null;
  observedAt: string;
  /** Time of the original evidence; import/read time cannot refresh it. */
  evidenceAt: string;
  sourceUpdatedAt: string | null;
  validUntil: string | null;
  importedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  availableQuantity: number | null;
  availabilityAt: string | null;
  coveragePerPricedUnit: { quantity: number; unit: CanonicalUnit } | null;
  unitsPerPackage: number | null;
  minimumOrderPackages: number | null;
  /** A box content count does not imply a whole-box purchase obligation. */
  orderIncrement: number | null;
  roundingRule: 'none' | 'round_up_increment' | null;
  charges: { freight: QuoteCharge; handling: QuoteCharge; tax: QuoteCharge; conditionalDiscount: QuoteCharge; refundableDeposit: QuoteCharge };
}
export interface SupplierQuoteEvaluation {
  state: SupplierQuoteState;
  priceState: 'missing' | 'fresh' | 'stale';
  label: string;
  knownUnitPrice: number | null;
  total: number | null;
  knownSubtotal: number;
  pending: string[];
  quoteId: string | null;
  verifiedLocalDate: string | null;
}
export class SupplierQuoteError extends Error {
  readonly code: string;
  constructor(code: string) { super(`Supplier quote validation: ${code}.`); this.name = 'SupplierQuoteError'; this.code = code; }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const decimal = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
  && /^(\d+)(?:\.(\d{1,6}))?$/.test(String(value));
const suppliers = new Set<QuotedSupplier>(['lowes', 'home_depot', 'floor_and_decor', 'other']);
const channels = new Set<QuoteChannel>(['online', 'pickup', 'delivery', 'contract']);
const origins = new Set<QuoteOrigin>(['partner_api', 'partner_feed', 'supplier_quote', 'manual_quote', 'cache']);
function fail(code: string): never { throw new SupplierQuoteError(code); }
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const day = value.slice(0, 10), date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(Date.parse(value)) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}
export function quoteLocalDate(value: string, timeZone: string): string {
  if (!timestamp(value)) fail('invalid_timestamp');
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const part = (name: string) => parts.find(item => item.type === name)!.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch { return fail('invalid_project_timezone'); }
}
function location(value: unknown): QuoteLocation {
  if (!record(value) || value.country !== 'US' || typeof value.postalCode !== 'string' || !/^\d{5}(?:-\d{4})?$/.test(value.postalCode)
    || !id(value.storeId) || typeof value.timeZone !== 'string' || !value.timeZone.trim()) fail('invalid_quote_location');
  quoteLocalDate('2026-01-01T00:00:00Z', value.timeZone);
  return { country: 'US', postalCode: value.postalCode, storeId: value.storeId, timeZone: value.timeZone };
}
function nullableTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (!timestamp(value)) fail('invalid_timestamp');
  return value;
}
function sourceUrl(value: unknown): string | null {
  if (value === null) return null;
  try { const url = new URL(String(value)); if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('invalid_quote_url'); return url.toString(); }
  catch { return fail('invalid_quote_url'); }
}
function charge(value: unknown): QuoteCharge {
  if (!record(value) || (value.required !== null && typeof value.required !== 'boolean')
    || (value.amount !== null && !decimal(value.amount)) || typeof value.refundable !== 'boolean'
    || (value.sourceRef !== null && !id(value.sourceRef))) fail('invalid_quote_charge');
  return { required: value.required as boolean | null, amount: value.amount as number | null,
    refundable: value.refundable, sourceRef: value.sourceRef as string | null };
}
/** Explicit documented import DTO. No HTTP, crawler, cached refresh or credentials. */
export function validateDocumentedSupplierQuote(input: unknown): DocumentedSupplierQuote {
  if (!record(input) || input.schema !== SUPPLIER_QUOTE_SCHEMA || !id(input.id) || !suppliers.has(input.supplier as QuotedSupplier)
    || typeof input.supplierName !== 'string' || !input.supplierName.trim() || input.supplierName.length > 160 || !id(input.sku)
    || (input.variant !== null && !id(input.variant)) || !channels.has(input.channel as QuoteChannel)
    || (input.model !== null && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160))
    || (input.specification !== null && (typeof input.specification !== 'string' || !input.specification.trim() || input.specification.length > 4_000))
    || typeof input.specificationReviewed !== 'boolean'
    || !decimal(input.quotedQuantity) || input.quotedQuantity <= 0 || typeof input.pricedUnit !== 'string' || !isCanonicalUnit(input.pricedUnit)
    || (input.unitPrice !== null && !decimal(input.unitPrice)) || input.currency !== 'USD' || !origins.has(input.origin as QuoteOrigin)
    || !timestamp(input.observedAt) || !timestamp(input.evidenceAt) || !timestamp(input.importedAt)
    || (input.reviewedBy !== null && !id(input.reviewedBy)) || !['in_stock', 'out_of_stock', 'unknown'].includes(String(input.availability))
    || (input.availableQuantity !== null && !decimal(input.availableQuantity))
    || (input.unitsPerPackage !== null && (!decimal(input.unitsPerPackage) || input.unitsPerPackage <= 0))
    || (input.minimumOrderPackages !== null && !decimal(input.minimumOrderPackages))
    || (input.orderIncrement !== null && (!decimal(input.orderIncrement) || input.orderIncrement <= 0))
    || ![null, 'none', 'round_up_increment'].includes(input.roundingRule as string | null) || !record(input.charges)) fail('invalid_documented_quote');
  const quoteLocation = location(input.location), url = sourceUrl(input.sourceUrl);
  if ((input.documentRef !== null && !id(input.documentRef)) || (!url && !input.documentRef)) fail('quote_evidence_required');
  let coverage: DocumentedSupplierQuote['coveragePerPricedUnit'] = null;
  if (input.coveragePerPricedUnit !== null) {
    if (!record(input.coveragePerPricedUnit) || !decimal(input.coveragePerPricedUnit.quantity) || input.coveragePerPricedUnit.quantity <= 0
      || typeof input.coveragePerPricedUnit.unit !== 'string' || !isCanonicalUnit(input.coveragePerPricedUnit.unit)) fail('invalid_quote_coverage');
    coverage = { quantity: input.coveragePerPricedUnit.quantity, unit: input.coveragePerPricedUnit.unit };
  }
  const charges = { freight: charge(input.charges.freight), handling: charge(input.charges.handling), tax: charge(input.charges.tax),
    conditionalDiscount: charge(input.charges.conditionalDiscount), refundableDeposit: charge(input.charges.refundableDeposit) };
  const chargeRefs = new Set<string>();
  for (const [name, item] of Object.entries(charges)) {
    if (item.required === false && item.amount !== null && item.amount !== 0) fail('excluded_charge_has_amount');
    if (name !== 'refundableDeposit' && item.refundable) fail('only_refundable_deposit_is_excluded');
    if (name === 'refundableDeposit' && item.required === true && !item.refundable) fail('deposit_refundability_required');
    if (name !== 'refundableDeposit' && item.required === true && item.sourceRef) {
      if (chargeRefs.has(item.sourceRef)) fail('duplicate_charge_reference'); chargeRefs.add(item.sourceRef);
    }
  }
  return { schema: SUPPLIER_QUOTE_SCHEMA, id: input.id, supplier: input.supplier as QuotedSupplier, supplierName: input.supplierName.trim(),
    location: quoteLocation, sku: input.sku, variant: input.variant as string | null, model: input.model as string | null,
    specification: input.specification as string | null, specificationReviewed: input.specificationReviewed, channel: input.channel as QuoteChannel,
    quotedQuantity: input.quotedQuantity, pricedUnit: input.pricedUnit, unitPrice: input.unitPrice as number | null, currency: 'USD', origin: input.origin as QuoteOrigin,
    sourceUrl: url, documentRef: input.documentRef as string | null, observedAt: input.observedAt, evidenceAt: input.evidenceAt,
    sourceUpdatedAt: nullableTimestamp(input.sourceUpdatedAt), validUntil: nullableTimestamp(input.validUntil), importedAt: input.importedAt,
    reviewedBy: input.reviewedBy as string | null, reviewedAt: nullableTimestamp(input.reviewedAt), availability: input.availability as DocumentedSupplierQuote['availability'],
    availableQuantity: input.availableQuantity as number | null, availabilityAt: nullableTimestamp(input.availabilityAt), coveragePerPricedUnit: coverage,
    unitsPerPackage: input.unitsPerPackage as number | null, minimumOrderPackages: input.minimumOrderPackages as number | null, orderIncrement: input.orderIncrement as number | null,
    roundingRule: input.roundingRule as DocumentedSupplierQuote['roundingRule'], charges };
}
export function evaluateSupplierQuote(request: SupplierQuoteRequest, source: DocumentedSupplierQuote | null, at: string,
  sourceError = false): SupplierQuoteEvaluation {
  if (!timestamp(at)) fail('invalid_evaluation_time');
  const pending: string[] = [];
  const quote = source === null ? null : validateDocumentedSupplierQuote(source);
  const knownSubtotal = quote?.unitPrice === null || !quote ? 0 : costMoney(costMultiply(costDecimal(quote.unitPrice), costDecimal(quote.quotedQuantity)));
  const base: Omit<SupplierQuoteEvaluation, 'state' | 'priceState' | 'label'> = { knownUnitPrice: quote?.unitPrice ?? null, knownSubtotal, total: null, pending, quoteId: quote?.id ?? null, verifiedLocalDate: null };
  const result = (state: SupplierQuoteState, priceState: SupplierQuoteEvaluation['priceState'], label: string): SupplierQuoteEvaluation => ({ ...base, state, priceState, label, pending });
  if (!request.location) { pending.push('project_location_required'); return result('awaiting_location', quote ? 'stale' : 'missing', 'Choose project ZIP and store'); }
  const desired = location(request.location), localDay = quoteLocalDate(at, desired.timeZone);
  if (sourceError) { pending.push('supplier_source_error'); return result('source_error', quote ? 'stale' : 'missing', 'Source unavailable; historical value retained'); }
  if (!quote) {
    if (request.mode === 'official_partner' && request.partnerAccessVerified !== true) { pending.push('official_partner_access_required'); return result('partner_access_required', 'missing', 'Official partner access required'); }
    pending.push('documented_supplier_quote_required'); return result('quote_required', 'missing', 'Documented quote required');
  }
  if (quote.supplier !== request.supplier || quote.sku !== request.sku || quote.variant !== request.variant || quote.channel !== request.channel
    || quote.location.country !== desired.country || quote.location.postalCode !== desired.postalCode || quote.location.storeId !== desired.storeId
    || quote.location.timeZone !== desired.timeZone || quote.quotedQuantity !== request.quantity || quote.pricedUnit !== request.pricedUnit
    || (request.channel === 'contract' && request.contractEligibilityVerified !== true)) {
    pending.push('quote_scope_or_contract_eligibility_mismatch'); return result('quote_required', 'stale', 'Quote does not match selected SKU, store, ZIP, quantity and channel');
  }
  if (quote.unitPrice === null || !quote.reviewedBy || !quote.reviewedAt) { pending.push('price_and_document_review_required'); return result('quote_required', 'missing', 'Price and document review required'); }
  if (!quote.specification || quote.specificationReviewed !== true) { pending.push('product_specification_review_required'); return result('quote_required', 'stale', 'Exact product specification review required'); }
  if (quote.validUntil === null) { pending.push('supplier_validity_policy_required'); return result('quote_required', 'stale', 'Documented supplier validity required'); }
  const dated = [quote.observedAt, quote.evidenceAt, ...(quote.sourceUpdatedAt ? [quote.sourceUpdatedAt] : [])];
  if (quote.origin === 'cache' || Date.parse(quote.reviewedAt) > Date.parse(at) || dated.some(time => Date.parse(time) > Date.parse(at) || quoteLocalDate(time, desired.timeZone) !== localDay)
    || (['partner_api', 'partner_feed'].includes(quote.origin) && (!quote.sourceUpdatedAt || request.partnerAccessVerified !== true))
    || (quote.validUntil !== null && Date.parse(quote.validUntil) <= Date.parse(at))) {
    pending.push('source_date_stale_or_unverified'); return result('stale', 'stale', 'Historical quote; refresh source evidence');
  }
  base.verifiedLocalDate = localDay;
  if (quote.availability === 'out_of_stock' || (quote.availableQuantity !== null && quote.availableQuantity < quote.quotedQuantity)) {
    pending.push('requested_quantity_unavailable'); return result('out_of_stock', 'fresh', 'Price documented today; requested quantity unavailable');
  }
  if (quote.availability !== 'in_stock' || quote.availableQuantity === null || quote.availabilityAt === null
    || Date.parse(quote.availabilityAt) > Date.parse(at) || quoteLocalDate(quote.availabilityAt, desired.timeZone) !== localDay) {
    pending.push('availability_for_quantity_unverified'); return result('availability_unknown', 'fresh', 'Price documented today; availability unverified');
  }
  let extras = 0n;
  for (const [name, cost] of Object.entries(quote.charges)) {
    if (name === 'refundableDeposit' || cost.refundable) continue;
    if (cost.required === false) { if (!cost.sourceRef) pending.push(`${name}_exclusion_evidence_pending`); continue; }
    if (cost.required === null || cost.amount === null || !cost.sourceRef) { pending.push(`${name}_pending`); continue; }
    extras += name === 'conditionalDiscount' ? -costDecimal(cost.amount) : costDecimal(cost.amount);
  }
  const total = costDecimal(knownSubtotal) + extras;
  if (total < 0n) pending.push('discount_exceeds_documented_cost');
  return { ...result(pending.length ? 'quote_required' : 'fresh', 'fresh', pending.length ? 'Documented price today; complete quote pending' : 'Documented today for selected store and channel'), total: pending.length ? null : costMoney(total) };
}

export function quotePriceProvenance(quote: DocumentedSupplierQuote, evaluation: SupplierQuoteEvaluation): PriceProvenance | null {
  if (evaluation.state !== 'fresh' || evaluation.priceState !== 'fresh' || evaluation.total === null || evaluation.pending.length || evaluation.quoteId !== quote.id || !evaluation.verifiedLocalDate) return null;
  return { sourceType: 'project_quote', sourceName: `${quote.supplierName} quote ${quote.id} / ${quote.sku} / store ${quote.location.storeId}`,
    effectiveDate: evaluation.verifiedLocalDate, expiresAt: quote.validUntil ? quoteLocalDate(quote.validUntil, quote.location.timeZone) : null,
    geography: `US ${quote.location.postalCode}`, vendor: quote.supplierName, sku: quote.sku, confidence: 1 };
}
export function importDocumentedSupplierQuotes(json: string, importedAt: string): DocumentedSupplierQuote[] {
  if (!timestamp(importedAt) || new TextEncoder().encode(json).byteLength > 1_000_000) fail('invalid_quote_import');
  let value: unknown; try { value = JSON.parse(json); } catch { return fail('quote_import_json_required'); }
  const candidates = Array.isArray(value) ? value : [value];
  if (!candidates.length || candidates.length > 500) fail('invalid_quote_import_batch');
  const seen = new Set<string>();
  return candidates.map(candidate => {
    if (!record(candidate)) fail('invalid_documented_quote');
    const quote = validateDocumentedSupplierQuote({ ...candidate, importedAt });
    if (seen.has(quote.id)) fail('duplicate_quote_id'); seen.add(quote.id); return quote;
  });
}
