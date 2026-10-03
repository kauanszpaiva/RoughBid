import { useState, type ChangeEvent } from 'react';
import { evaluateSupplierQuote, importDocumentedSupplierQuotes, type DocumentedSupplierQuote, type SupplierQuoteEvaluation, type SupplierQuoteRequest } from '../services/supplierQuotes.ts';

export interface SupplierQuoteImportPanelProps {
  request: SupplierQuoteRequest;
  /** Caller persists only after its authenticated workspace/project authorization check. */
  onImport: (quotes: readonly DocumentedSupplierQuote[]) => void | Promise<void>;
  now?: () => string;
}
/** Local documented JSON import; does not contact suppliers or claim cached values are current. */
export function SupplierQuoteImportPanel({ request, onImport, now = () => new Date().toISOString() }: SupplierQuoteImportPanelProps) {
  const [document, setDocument] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ quote: DocumentedSupplierQuote; evaluation: SupplierQuoteEvaluation }>>([]);
  const [busy, setBusy] = useState(false);
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 1_000_000 || !file.name.toLowerCase().endsWith('.json')) { setError('Use a documented quote JSON file of at most 1 MB.'); return; }
    setDocument(await file.text()); setError(null); setResults([]);
  };
  const importQuotes = async () => {
    setBusy(true); setError(null); setResults([]);
    try {
      const at = now(), quotes = importDocumentedSupplierQuotes(document, at);
      const evaluated = quotes.map(quote => ({ quote, evaluation: evaluateSupplierQuote(request, quote, at) }));
      await onImport(quotes); setResults(evaluated);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Documented quote import failed.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Documented supplier quotes" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
    <h3 className="font-semibold text-slate-900">Import a documented supplier quote</h3>
    <p className="text-sm text-slate-600">Lowe’s, The Home Depot and Floor &amp; Decor prices require the selected ZIP, store, SKU, channel and quantity. Importing a document preserves its original evidence date.</p>
    {!request.location && <p role="status" className="text-sm text-amber-800">Choose the project ZIP, store and time zone to verify a price for today.</p>}
    <label className="block text-sm">Quote JSON file <input type="file" accept=".json,application/json" onChange={readFile} disabled={busy} className="mt-1 block w-full" /></label>
    <label className="block text-sm">Documented quote JSON<textarea aria-label="Documented quote JSON" value={document} onChange={event => { setDocument(event.target.value); setResults([]); }} maxLength={1_000_000} rows={7} disabled={busy} className="mt-1 block w-full rounded border border-slate-300 p-2 font-mono text-xs" /></label>
    <p className="text-xs text-slate-500">Contract: roughbid-supplier-quote-v1. Include source URL or document reference, original timestamps, review, stock evidence and all required charges.</p>
    <button type="button" onClick={importQuotes} disabled={busy || !document.trim()} className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Importing…' : 'Import documented quote'}</button>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {results.length > 0 && <ul className="space-y-2">{results.map(({ quote, evaluation }) => <li key={quote.id} className="rounded border border-slate-200 p-2 text-sm">
      <p className="font-medium">{quote.supplierName} · {quote.sku} · {quote.location.postalCode} · store {quote.location.storeId}</p>
      <p role="status">{evaluation.label} ({evaluation.state})</p>
      <p>Original evidence: {quote.evidenceAt}. Imported: {quote.importedAt}.</p>
      <p>Known documented subtotal: ${evaluation.knownSubtotal.toFixed(2)}. {evaluation.total === null ? 'Complete quote total pending.' : `Complete documented total: $${evaluation.total.toFixed(2)}.`}</p>
      {evaluation.pending.length > 0 && <p className="text-amber-800">Pending: {evaluation.pending.join(', ')}</p>}
    </li>)}</ul>}
  </section>;
}
