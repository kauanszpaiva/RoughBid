import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSupplierQuote, importDocumentedSupplierQuotes, quotePriceProvenance, validateDocumentedSupplierQuote, quoteLocalDate,
  SUPPLIER_QUOTE_SCHEMA, type DocumentedSupplierQuote, type SupplierQuoteRequest, type QuoteCharge } from '../src/supplier-quotes.ts';

const at = '2026-10-02T16:00:00Z';
const notRequired = (): QuoteCharge => ({ required: false, amount: null, refundable: false, sourceRef: 'reviewed-exclusion42' });
const quote = (): DocumentedSupplierQuote => ({ schema: SUPPLIER_QUOTE_SCHEMA, id: 'q42', supplier: 'floor_and_decor', supplierName: 'Floor & Decor',
  location: { country: 'US', postalCode: '02110', storeId: 'boston', timeZone: 'America/New_York' }, sku: '100899178', variant: null,
  model: null, specification: 'Synthetic specification fixture; no product equivalence claim.', specificationReviewed: true,
  channel: 'pickup', quotedQuantity: 25, pricedUnit: 'EA', unitPrice: 3.19, currency: 'USD', origin: 'manual_quote',
  sourceUrl: 'https://www.flooranddecor.com/example', documentRef: 'reviewed-doc42', observedAt: at, evidenceAt: at,
  sourceUpdatedAt: null, validUntil: '2026-10-03T00:00:00Z', importedAt: at, reviewedBy: 'reviewer42', reviewedAt: at,
  availability: 'in_stock', availableQuantity: 100, availabilityAt: at, coveragePerPricedUnit: { quantity: 0.43, unit: 'SF' },
  unitsPerPackage: 25, minimumOrderPackages: 0, orderIncrement: 1, roundingRule: 'round_up_increment', charges: { freight: notRequired(), handling: notRequired(), tax: notRequired(), conditionalDiscount: notRequired(), refundableDeposit: notRequired() } });
const request = (): SupplierQuoteRequest => ({ supplier: 'floor_and_decor', location: quote().location, sku: '100899178', variant: null, channel: 'pickup', quantity: 25, pricedUnit: 'EA', mode: 'documented_quote', partnerAccessVerified: false, contractEligibilityVerified: false });

test('documents an exact local quote and never labels it live', () => {
  const evaluation = evaluateSupplierQuote(request(), quote(), at);
  assert.equal(evaluation.state, 'fresh'); assert.equal(evaluation.knownSubtotal, 79.75); assert.equal(evaluation.total, 79.75);
  assert.equal(evaluation.verifiedLocalDate, '2026-10-02'); assert.doesNotMatch(evaluation.label, /live/i);
  assert.equal(quotePriceProvenance(quote(), evaluation)?.sourceType, 'project_quote');
});
test('import/read time cannot renew an old feed or cache', () => {
  const old = { ...quote(), evidenceAt: '2026-10-01T16:00:00Z', observedAt: '2026-10-01T16:00:00Z', importedAt: '2026-10-01T16:00:00Z' };
  const imported = importDocumentedSupplierQuotes(JSON.stringify(old), at)[0]!;
  assert.equal(imported.importedAt, at); assert.equal(imported.evidenceAt, old.evidenceAt);
  assert.equal(evaluateSupplierQuote(request(), imported, at).state, 'stale');
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), origin: 'cache' }, at).state, 'stale');
  assert.equal(evaluateSupplierQuote({ ...request(), partnerAccessVerified: true }, { ...quote(), origin: 'partner_feed', sourceUpdatedAt: old.evidenceAt }, at).state, 'stale');
});
test('ZIP/store/SKU/variant/channel/quantity/unit must match; no implied national price', () => {
  for (const change of [{ sku: 'other' }, { variant: 'other' }, { channel: 'online' as const }, { quantity: 24 }, { pricedUnit: 'BOX' as const },
    { location: { ...quote().location, postalCode: '50266' } }, { location: { ...quote().location, storeId: 'other' } }]) {
    assert.equal(evaluateSupplierQuote({ ...request(), ...change }, quote(), at).state, 'quote_required');
  }
  assert.equal(evaluateSupplierQuote({ ...request(), location: null }, quote(), at).state, 'awaiting_location');
  assert.equal(evaluateSupplierQuote({ ...request(), mode: 'official_partner' }, null, at).state, 'partner_access_required');
  assert.equal(evaluateSupplierQuote({ ...request(), channel: 'contract' }, { ...quote(), channel: 'contract' }, at).state, 'quote_required');
});
test('today follows project timezone and expired/future evidence stays stale', () => {
  assert.equal(quoteLocalDate('2026-10-03T01:00:00Z', 'America/New_York'), '2026-10-02');
  const evening = { ...quote(), validUntil: '2026-10-03T03:00:00Z' };
  assert.equal(evaluateSupplierQuote(request(), evening, '2026-10-03T01:00:00Z').state, 'fresh');
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), validUntil: at }, at).state, 'stale');
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), reviewedAt: '2026-10-03T01:00:00Z' }, at).state, 'stale');
});
test('unknown taxes/freight preserve a known subtotal and null complete total; refundable deposit excluded', () => {
  const source = quote(); source.charges.tax = { required: null, amount: null, refundable: false, sourceRef: null };
  const evaluated = evaluateSupplierQuote(request(), source, at);
  assert.equal(evaluated.priceState, 'fresh'); assert.equal(evaluated.total, null); assert.equal(evaluated.knownSubtotal, 79.75);
  assert.equal(evaluated.state, 'quote_required');
  assert.equal(quotePriceProvenance(source, evaluated), null);
  source.charges.tax = { required: true, amount: 4.985, refundable: false, sourceRef: 'tax-doc' };
  source.charges.refundableDeposit = { required: true, amount: 500, refundable: true, sourceRef: 'deposit-doc' };
  assert.equal(evaluateSupplierQuote(request(), source, at).total, 84.74);
});
test('missing supplier validity, product specification or cost exclusion evidence cannot establish a complete fresh quote', () => {
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), validUntil: null }, at).state, 'quote_required');
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), specification: null }, at).state, 'quote_required');
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), specificationReviewed: false }, at).state, 'quote_required');
  const source = quote(); source.charges.tax.sourceRef = null;
  assert.equal(evaluateSupplierQuote(request(), source, at).state, 'quote_required');
});
test('contradictory exclusions and duplicate charge line references cannot double count tax or freight', () => {
  const excluded = quote(); excluded.charges.tax = { required: false, amount: 10, refundable: false, sourceRef: 'tax-line' };
  assert.throws(() => validateDocumentedSupplierQuote(excluded), /excluded_charge_has_amount/);
  const duplicate = quote(); duplicate.charges.tax = { required: true, amount: 10, refundable: false, sourceRef: 'same-line' };
  duplicate.charges.freight = { required: true, amount: 10, refundable: false, sourceRef: 'same-line' };
  assert.throws(() => validateDocumentedSupplierQuote(duplicate), /duplicate_charge_reference/);
});
test('stock quantity/evidence is separate from documented price and failures retain historical value', () => {
  const unavailable = evaluateSupplierQuote(request(), { ...quote(), availableQuantity: 24 }, at);
  assert.equal(unavailable.state, 'out_of_stock'); assert.equal(unavailable.priceState, 'fresh'); assert.equal(unavailable.total, null);
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), availabilityAt: null }, at).state, 'availability_unknown');
  const failure = evaluateSupplierQuote(request(), quote(), at, true);
  assert.equal(failure.state, 'source_error'); assert.equal(failure.knownUnitPrice, 3.19); assert.equal(failure.total, null);
});
test('explicit documented zero is distinct from missing price and unsafe/unreviewed imports fail clearly', () => {
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), unitPrice: 0 }, at).total, 0);
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), unitPrice: null }, at).total, null);
  assert.equal(evaluateSupplierQuote(request(), { ...quote(), reviewedBy: null }, at).state, 'quote_required');
  assert.throws(() => validateDocumentedSupplierQuote({ ...quote(), evidenceAt: '2026-02-30T16:00:00Z' }), /validation/);
  assert.throws(() => importDocumentedSupplierQuotes(JSON.stringify([quote(), quote()]), at), /duplicate_quote_id/);
  assert.throws(() => validateDocumentedSupplierQuote({ ...quote(), sourceUrl: 'https://user:password@example.com/' }), /invalid_quote_url/);
  const cleaned = validateDocumentedSupplierQuote({ ...quote(), credential: 'DO_NOT_PERSIST' });
  assert.equal(Object.hasOwn(cleaned, 'credential'), false);
});
