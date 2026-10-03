import { costDecimal, costMoney, costMultiply } from './cost-decimal.ts';
import type { CatalogCostResult } from './construction-catalog.ts';
import { guardConstructionTaxCostBase, normalizeConstructionQuotedTax, type ConstructionLandedCostLine, type ConstructionTaxCharge, type ConstructionTaxCostBase } from './construction-tax-ledger.ts';
import { evaluateSupplierQuote, quoteLocalDate, validateDocumentedSupplierQuote, type DocumentedSupplierQuote, type QuoteLocation, type SupplierQuoteEvaluation } from './supplier-quotes.ts';

export interface ConstructionBudgetTaxBinding { componentId: string; quoteId: string; evaluation: SupplierQuoteEvaluation }
export interface BudgetTaxScope { workspaceId: string; projectId: string }
interface PersistedTaxReviewStamp {
  /** The API must obtain these records from its authorized database lookup, never from calculate() request JSON. */
  origin: 'persisted_workspace_review'; workspaceId: string; projectId: string; reviewedBy: string; reviewedAt: string;
}
export interface PersistedConstructionQuoteTaxReview extends PersistedTaxReviewStamp {
  id: string; quoteId: string; sourceEvidenceRef: string; taxInclusion: 'exclusive' | 'inclusive' | 'not_applicable' | 'unknown';
  taxChargeIds: string[]; notApplicableEvidenceRef: string | null;
}
export interface PersistedConstructionTaxCharge extends PersistedTaxReviewStamp { charge: ConstructionTaxCharge }
export interface ConstructionBudgetTaxPendingNode {
  id: string; code: string; lineId: string | null; componentId: string | null; quoteId: string | null;
  sourceRefs: string[];
}
export interface ConstructionBudgetTaxTrace {
  lineId: string; componentId: string; quoteId: string | null; calculatedCostUsd: number | null;
  quotedQuantity: number | null; derivedPurchasingQuantity: number | null; quotedUnitPriceUsd: number | null;
  quoteEvidenceRef: string | null; taxReviewId: string | null; taxChargeReferences: string[];
  knownNonTaxPurchaseChargesUsd: number | null; normalizedNonTaxUsd: number | null;
  nonrecoverableTaxUsd: number | null; candidateLandedCostUsd: number | null; landedCostUsd: number | null; formulas: string[];
}
export interface ConstructionBudgetTaxResult {
  schema: 'roughbid-construction-budget-tax-v1'; fiscalStatus: 'pending' | 'reviewed';
  /** Partial actual calculations retained while fiscal inputs remain unresolved. */
  knownSubtotalUsd: number; reviewedScopeCostBaseUsd: number | null; unallocatedNonrecoverableTaxesUsd: number | null;
  /** Scope/coverage and independent review stay in the outer budget workflow. */
  totalUsd: null; pendingNodes: ConstructionBudgetTaxPendingNode[]; traces: ConstructionBudgetTaxTrace[];
  fiscalCostBase: ConstructionTaxCostBase | null;
}
const present = (value: string | null | undefined): value is string => typeof value === 'string' && Boolean(value.trim());
const money = (value: number) => costMoney(costDecimal(value));
const economicIdentity = (value: string) => value.trim().normalize('NFKC').toLowerCase();
function persistedStamp(record: PersistedTaxReviewStamp, scope: BudgetTaxScope, at: string): boolean {
  if (record.origin !== 'persisted_workspace_review' || record.workspaceId !== scope.workspaceId || record.projectId !== scope.projectId
    || !present(record.reviewedBy)) return false;
  try { quoteLocalDate(record.reviewedAt, 'Etc/UTC'); return Date.parse(record.reviewedAt) <= Date.parse(at); } catch { return false; }
}

/**
 * Join server-calculated costs to saved quotes and independently persisted tax reviews.
 * No input accepts a browser-provided landed cost or an estimated tax rate.
 * Until tax review persistence exists, pass empty taxReviews/taxLedger: the result exposes named blockers and real source traces.
 */
export function buildConstructionBudgetTax(input: {
  calculated: CatalogCostResult; quotes: readonly DocumentedSupplierQuote[]; quoteBindings: readonly ConstructionBudgetTaxBinding[];
  location: QuoteLocation | null; at: string; scope: BudgetTaxScope;
  taxReviews: readonly PersistedConstructionQuoteTaxReview[]; taxLedger: readonly PersistedConstructionTaxCharge[];
}): ConstructionBudgetTaxResult {
  quoteLocalDate(input.at, input.location?.timeZone ?? 'Etc/UTC');
  if (!present(input.scope.workspaceId) || !present(input.scope.projectId)) throw new TypeError('Authenticated workspace/project scope is required for fiscal review.');
  const pendingNodes: ConstructionBudgetTaxPendingNode[] = [], traces: ConstructionBudgetTaxTrace[] = [], landedLines: ConstructionLandedCostLine[] = [];
  const add = (code: string, lineId: string | null, componentId: string | null, quoteId: string | null, sourceRefs: string[] = []) => {
    const id = `${lineId ?? 'budget'}:${quoteId ?? 'none'}:${code}`;
    if (!pendingNodes.some(node => node.id === id)) pendingNodes.push({ id, code, lineId, componentId, quoteId, sourceRefs });
  };
  const quotes = new Map<string, DocumentedSupplierQuote>();
  for (const raw of input.quotes) {
    try {
      const quote = validateDocumentedSupplierQuote(raw);
      if (quotes.has(quote.id)) { add('duplicate_saved_quote_identity', null, null, quote.id); continue; } quotes.set(quote.id, quote);
    } catch { add('saved_quote_contract_invalid', null, null, typeof raw.id === 'string' ? raw.id : null); }
  }
  const bindings = new Map<string, ConstructionBudgetTaxBinding>(), boundQuotes = new Set<string>();
  for (const binding of input.quoteBindings) {
    if (bindings.has(binding.componentId) || boundQuotes.has(binding.quoteId)) add('quoted_purchase_allocation_competes', null, binding.componentId, binding.quoteId);
    else { bindings.set(binding.componentId, binding); boundQuotes.add(binding.quoteId); }
  }
  const reviews = new Map<string, PersistedConstructionQuoteTaxReview>();
  for (const review of input.taxReviews) {
    if (!persistedStamp(review, input.scope, input.at)) { add('persisted_tax_review_scope_or_author_invalid', null, null, review.quoteId); continue; }
    if (reviews.has(review.quoteId)) { add('competing_quote_tax_reviews', null, null, review.quoteId); continue; } reviews.set(review.quoteId, review);
  }
  const charges = new Map<string, ConstructionTaxCharge>(), chargeRefs = new Set<string>();
  for (const record of input.taxLedger) {
    const charge = record.charge;
    if (!persistedStamp(record, input.scope, input.at) || !charge.reviewed) { add('persisted_tax_charge_scope_or_author_invalid', null, null, charge.supplierQuoteId); continue; }
    if (charges.has(charge.id)) { add('duplicate_tax_charge_identity', null, null, charge.supplierQuoteId); continue; }
    const ref = charge.sourceChargeReference === null ? null : economicIdentity(charge.sourceChargeReference);
    if (ref && chargeRefs.has(ref)) { add('duplicate_economic_tax_charge', null, null, charge.supplierQuoteId, [charge.sourceChargeReference!]); continue; }
    if (ref) chargeRefs.add(ref); charges.set(charge.id, charge);
    if (charge.supplierQuoteId !== null && !quotes.has(charge.supplierQuoteId)) add('tax_charge_saved_quote_source_missing', null, null, charge.supplierQuoteId, charge.sourceRef ? [charge.sourceRef] : []);
  }
  for (const line of input.calculated.lines) {
    const trace: ConstructionBudgetTaxTrace = { lineId: line.id, componentId: line.itemId, quoteId: null, calculatedCostUsd: line.cost,
      quotedQuantity: null, derivedPurchasingQuantity: line.quantity, quotedUnitPriceUsd: null, quoteEvidenceRef: null, taxReviewId: null,
      taxChargeReferences: [], knownNonTaxPurchaseChargesUsd: null, normalizedNonTaxUsd: null, nonrecoverableTaxUsd: null, candidateLandedCostUsd: null, landedCostUsd: null, formulas: [] };
    traces.push(trace);
    const fiscalLine: ConstructionLandedCostLine = { id: line.id, category: 'direct', landedCost: null, taxChargeIds: [] }; landedLines.push(fiscalLine);
    if (line.cost === null || line.pending.length) add('calculated_line_cost_pending', line.id, line.itemId, null, line.priceSources.map(source => source.sourceName));
    if (line.category !== 'material') { add('line_tax_applicability_review_pending', line.id, line.itemId, null, line.priceSources.map(source => source.sourceName)); continue; }
    const binding = bindings.get(line.itemId), quote = binding ? quotes.get(binding.quoteId) : undefined;
    if (!binding || !quote) { add('saved_material_quote_binding_pending', line.id, line.itemId, binding?.quoteId ?? null); continue; }
    trace.quoteId = quote.id; trace.quotedQuantity = quote.quotedQuantity; trace.quotedUnitPriceUsd = quote.unitPrice;
    trace.quoteEvidenceRef = quote.documentRef ?? quote.sourceUrl;
    const sourceRefs = [trace.quoteEvidenceRef!, ...(quote.charges.tax.sourceRef ? [quote.charges.tax.sourceRef] : [])];
    if (binding.evaluation.quoteId !== quote.id || binding.evaluation.state !== 'fresh' || binding.evaluation.total === null) {
      add('saved_quote_evaluation_pending', line.id, line.itemId, quote.id, sourceRefs);
    }
    const current = evaluateSupplierQuote({ supplier: quote.supplier, location: input.location, sku: quote.sku, variant: quote.variant, channel: quote.channel,
      quantity: line.quantity, pricedUnit: line.unit, mode: 'documented_quote', partnerAccessVerified: false, contractEligibilityVerified: false }, quote, input.at);
    if (current.state !== 'fresh' || current.total === null) add('quote_date_location_quantity_or_cost_pending', line.id, line.itemId, quote.id, sourceRefs);
    const documentedMaterial = quote.unitPrice === null || line.quantity === null ? null : costMoney(costMultiply(costDecimal(quote.unitPrice), costDecimal(line.quantity)));
    if (line.cost !== null && documentedMaterial !== line.cost) add('calculated_material_cost_differs_from_saved_quote', line.id, line.itemId, quote.id, sourceRefs);
    const review = reviews.get(quote.id);
    if (!review || review.taxInclusion === 'unknown') {
      add('quote_tax_inclusion_review_pending', line.id, line.itemId, quote.id, sourceRefs);
      if (quote.charges.tax.required !== false) add('quote_tax_source_ledger_pending', line.id, line.itemId, quote.id, sourceRefs);
      continue;
    }
    trace.taxReviewId = review.id;
    if (review.sourceEvidenceRef !== quote.documentRef && review.sourceEvidenceRef !== quote.sourceUrl) add('tax_review_document_differs_from_saved_quote', line.id, line.itemId, quote.id, sourceRefs);
    const quoteCharges = review.taxChargeIds.flatMap(id => { const charge = charges.get(id); if (!charge) { add('reviewed_tax_charge_missing', line.id, line.itemId, quote.id, sourceRefs); return []; } return [charge]; });
    if (new Set(review.taxChargeIds).size !== review.taxChargeIds.length) add('duplicate_review_tax_reference', line.id, line.itemId, quote.id, sourceRefs);
    for (const charge of quoteCharges) {
      trace.taxChargeReferences.push(charge.sourceChargeReference ?? charge.id);
      if (charge.supplierQuoteId !== quote.id || charge.sourceChargeReference !== quote.charges.tax.sourceRef) add('tax_charge_does_not_match_quote_economic_source', line.id, line.itemId, quote.id, sourceRefs);
    }
    if (review.taxInclusion === 'not_applicable') {
      if (review.taxChargeIds.length || quote.charges.tax.required !== false || !present(review.notApplicableEvidenceRef)
        || review.notApplicableEvidenceRef !== quote.charges.tax.sourceRef) add('tax_exclusion_source_evidence_pending', line.id, line.itemId, quote.id, sourceRefs);
    } else {
      const ledgerAmount = quoteCharges.some(charge => charge.amount === null) ? null : costMoney(quoteCharges.reduce((sum, charge) => sum + costDecimal(charge.amount!), 0n));
      if (!quoteCharges.length || quote.charges.tax.required !== true || quote.charges.tax.amount === null || ledgerAmount !== money(quote.charges.tax.amount)) add('tax_ledger_amount_differs_from_documented_quote', line.id, line.itemId, quote.id, sourceRefs);
    }
    let knownNonTaxCharges = 0n;
    for (const [name, charge] of Object.entries(quote.charges)) {
      if (name === 'tax' || name === 'refundableDeposit') continue;
      if (charge.required === false) { if (!charge.sourceRef) add('purchase_charge_exclusion_evidence_pending', line.id, line.itemId, quote.id, sourceRefs); continue; }
      if (charge.required !== true || charge.amount === null || !charge.sourceRef) { add('purchase_charge_source_or_amount_pending', line.id, line.itemId, quote.id, sourceRefs); continue; }
      knownNonTaxCharges += name === 'conditionalDiscount' ? -costDecimal(charge.amount) : costDecimal(charge.amount);
    }
    if (documentedMaterial === null || costDecimal(documentedMaterial) + knownNonTaxCharges < 0n) { add('quoted_material_or_discount_amount_pending', line.id, line.itemId, quote.id, sourceRefs); continue; }
    trace.knownNonTaxPurchaseChargesUsd = knownNonTaxCharges < 0n ? -costMoney(-knownNonTaxCharges) : costMoney(knownNonTaxCharges);
    const normalization = normalizeConstructionQuotedTax({ quotedAmount: costMoney(costDecimal(documentedMaterial) + knownNonTaxCharges),
      taxInclusion: review.taxInclusion === 'not_applicable' ? 'exclusive' : review.taxInclusion, charges: quoteCharges,
      notApplicableEvidenceRef: review.notApplicableEvidenceRef });
    for (const reason of normalization.pending) add(`quote_tax_normalization:${reason}`, line.id, line.itemId, quote.id, sourceRefs);
    trace.normalizedNonTaxUsd = normalization.nonTaxAmount; trace.nonrecoverableTaxUsd = normalization.nonrecoverableTax; trace.candidateLandedCostUsd = normalization.landedCost;
    trace.formulas = ['documented_unit_price × server_derived_purchasing_quantity + documented_separate_non_tax_charges',
      'normalized_non_tax_amount = quoted_purchase_amount − identified_embedded_tax', 'landed_cost = normalized_non_tax_amount + nonrecoverable_tax_once'];
    fiscalLine.landedCost = pendingNodes.some(node => node.lineId === line.id) ? null : normalization.landedCost;
    trace.landedCostUsd = fiscalLine.landedCost;
    fiscalLine.taxChargeIds = quoteCharges.filter(charge => ['embedded_in_direct_line', 'added_once_to_direct_line'].includes(charge.treatment)).map(charge => charge.id);
  }
  let fiscalCostBase: ConstructionTaxCostBase | null = null;
  try {
    const notApplicableEvidence = input.calculated.lines.length > 0 && input.calculated.lines.every(line => {
      const binding = bindings.get(line.itemId), review = binding ? reviews.get(binding.quoteId) : undefined;
      return review?.taxInclusion === 'not_applicable' && present(review.notApplicableEvidenceRef);
    }) ? [...reviews.values()].map(review => review.notApplicableEvidenceRef).filter(present).join(';') : null;
    fiscalCostBase = guardConstructionTaxCostBase({ lines: landedLines, charges: [...charges.values()], notApplicableEvidenceRef: notApplicableEvidence });
    for (const reason of fiscalCostBase.pending) add(`tax_cost_base:${reason}`, null, null, null, [...charges.values()].map(charge => charge.sourceRef).filter(present));
  } catch { add('tax_cost_base_contract_invalid', null, null, null); }
  if (!input.taxLedger.length && !input.taxReviews.length) add('tax_ledger_review_not_persisted', null, null, null);
  const reviewed = !pendingNodes.length && fiscalCostBase?.total !== null && fiscalCostBase !== null;
  return { schema: 'roughbid-construction-budget-tax-v1', fiscalStatus: reviewed ? 'reviewed' : 'pending', knownSubtotalUsd: input.calculated.knownSubtotal,
    reviewedScopeCostBaseUsd: reviewed ? fiscalCostBase!.total : null,
    unallocatedNonrecoverableTaxesUsd: fiscalCostBase && !fiscalCostBase.pending.length ? fiscalCostBase.unallocatedNonrecoverableTaxes : null,
    totalUsd: null, pendingNodes, traces, fiscalCostBase };
}
